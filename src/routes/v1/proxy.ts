// 代理面核心处理器（M3 3.3 + M4 4.1-4.5）。
// 中间件链（router.ts 挂载）：gatewayAuth → gatewayRateLimit → gatewayBalanceCheck → zValidator。
// 处理器内（design §3 步骤 5/6/7/8）：
//   5. 缓存（非流式 && key.cacheEnabled）→ 命中直接返回（不转发、不扣费，明细记 cached）
//   4. 模型路由（Provider 选择）
//   6. 适配器构造 + 超时转发
//   7. 计费：成功 → 条件 UPDATE 原子扣费 + balance_tx(usage) 流水 + request_logs 明细；
//      流式 → SSE 尾包 usage 到达后结算（无 usage 默认免计，记日志）；
//      失败语义（4.3）：上游错误/超时 → 不扣费，明细记 error。
//   8. 非流式成功且开启缓存 → 响应写 KV（waitUntil 非阻塞）。
// 错误一律 OpenAI 风格 `{error:{message}}`（3.6）。
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodType } from "zod";
import type { AppEnv } from "../../types";
import type { Db } from "../../db";
import { providers } from "../../db/schema";
import { createDb } from "../../db";
import { getAdapter } from "../../providers";
import { AdapterError } from "../../providers/types";
import type {
  EndpointKind,
  InternalRequest,
  ProviderAdapter,
  ProviderConfig,
  ProviderType,
  UpstreamRequest,
} from "../../providers/types";
import { decryptSecret } from "../../lib/security";
import { parseProviderModels } from "../../lib/provider-models";
import {
  atOrThrow,
  isCircuitOpen,
  openCircuit,
  pickHealthyProvider,
  type RouteCandidate,
} from "../../lib/provider-router";
import {
  extractUpstreamError,
  fetchUpstream,
  logUpstreamError,
  UpstreamTimeoutError,
} from "../../lib/upstream";
import {
  chatCompletionsInputSchema,
  completionsInputSchema,
  embeddingsInputSchema,
} from "./types";
import { gatewayRateLimit } from "./rate-limit";
import { gatewayBalanceCheck } from "./balance";
import {
  buildCacheKey,
  getCachedResponse,
  hashRequestBody,
  setCachedResponse,
} from "../../lib/response-cache";
import {
  calcCost,
  chargeUsage,
  extractLooseUsage,
  findModelPrice,
  recordRequestLog,
} from "../../lib/billing";
import type { ChargeUsageInput, RequestLogRecord } from "../../lib/billing";
import { enqueueUsageEvent } from "../../lib/usage-aggregation";
import { wrapStreamWithSettlement } from "../../lib/stream-settle";

const PATH_BY_KIND: Record<EndpointKind, string> = {
  chat: "/chat/completions",
  completions: "/completions",
  embeddings: "/embeddings",
};

/**
 * 协议端点注入点（P1）：新协议入口（/anthropic、/v1/messages、/v1/responses）
 * 通过它复用共享代理管道。全部选项有默认语义，现有三端点（proxyRoute 薄包装）
 * 不传任何协议选项，行为逐字节不变。
 */
export interface ProxyEndpointOptions<B = Record<string, unknown>> {
  /** 入站请求体 zod 校验（宽松 passthrough 风格，见 routes/v1/types.ts）。 */
  inputSchema: ZodType;
  /** 内部 EndpointKind：新协议入口恒为 "chat"（anthropic 适配器 supports() 只放行 chat）；默认 "chat"。 */
  kind?: EndpointKind;
  /** 入站协议 → 内部 OpenAI Chat 形态；默认恒等（chat/completions/embeddings 端点）。 */
  toInternal?: (body: B) => B;
  /** 非流式出站协议转换（在 adapter.transformResponse 正向转换之后执行）；默认恒等。 */
  transformResponse?: (data: unknown, c: Context<AppEnv>) => unknown;
  /** 流式出站协议转换（在 wrapStreamWithSettlement 结算包装之后执行）；默认恒等。 */
  transformStream?: (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
  /** 缓存键协议命名空间前缀（协议间隔离，如 "anthropic:"）；默认 ""（现有端点键不变）。 */
  cachePrefix?: string;
  /** 入站协议偏好的 provider 类型：模型路由优先匹配同类型 provider（如 Anthropic 协议
   * → type=anthropic 的 provider 原生转发，OpenAI 协议 → type=openai），无同类型命中
   * 时回退按 id 升序全量匹配（既有配置零回归）。默认不限定（行为不变）。 */
  providerType?: ProviderType;
}

interface ResolvedProvider {
  providerId: number;
  type: string;
  baseUrl: string;
  apiKeyEnc: string;
  models: Record<string, string>;
  /** 负载均衡权重（DB 列；缺失按 1 兜底）。 */
  weight: number;
}

/**
 * 模型路由 → 候选池：优先收集 preferredType 的同类型 Provider（协议原生转发，如 Anthropic
 * 协议 → 上游 /anthropic 端点）；无同类型命中时回退按 id 升序全量收集（仅配 openai/anthropic
 * 单面 provider 的既有配置行为不变）。两趟均按 id 升序保证确定性。
 * 多候选构成负载均衡池（哈希分配 + 故障转移）；单候选 = 现状单赢家行为（零回归）。
 */
async function resolveCandidates(
  db: Db,
  model: string,
  preferredType?: ProviderType,
): Promise<ResolvedProvider[]> {
  const rows = await db
    .select()
    .from(providers)
    .where(eq(providers.enabled, true))
    .orderBy(asc(providers.id));
  const collect = (wantType: ProviderType | null): ResolvedProvider[] => {
    const out: ResolvedProvider[] = [];
    for (const row of rows) {
      if (wantType !== null && row.type !== wantType) {
        continue;
      }
      const models = parseProviderModels(row.models);
      if (models[model] !== undefined) {
        out.push({
          providerId: row.id,
          type: row.type,
          baseUrl: row.baseUrl,
          apiKeyEnc: row.apiKeyEnc,
          models,
          weight: typeof row.weight === "number" && row.weight >= 1 ? row.weight : 1,
        });
      }
    }
    return out;
  };
  if (preferredType !== undefined) {
    const preferred = collect(preferredType);
    if (preferred.length > 0) {
      return preferred;
    }
  }
  return collect(null);
}

const INPUT_SCHEMAS: Record<EndpointKind, ZodType> = {
  chat: chatCompletionsInputSchema,
  completions: completionsInputSchema,
  embeddings: embeddingsInputSchema,
};

/** 上游状态码 → Hono 合法内容状态码（仅非 2xx 分支进入，400-599 全为合法值）。 */
function toContentStatus(status: number): ContentfulStatusCode {
  if (status >= 400 && status <= 599) {
    return status as ContentfulStatusCode;
  }
  return 502;
}

/** 明细落库后非阻塞 enqueue 聚合事件（M5 5.2；waitUntil 旁路管道，不拖慢请求路径）。 */
function enqueueUsage(c: Context<AppEnv>, log: RequestLogRecord): void {
  c.executionCtx.waitUntil(enqueueUsageEvent(c.env.USAGE_QUEUE, log));
}

export function proxyRouteWithOptions(
  app: Hono<AppEnv>,
  path: string,
  options: ProxyEndpointOptions,
): void {
  const {
    inputSchema,
    kind = "chat",
    toInternal,
    transformResponse,
    transformStream,
    cachePrefix = "",
    providerType,
  } = options;

  app.post(
    path,
    gatewayRateLimit(),
    gatewayBalanceCheck(),
    // 校验失败 400 由 src/index.ts 全局中间件统一为 {error:{message}}（M8）
    zValidator("json", inputSchema),
    async (c) => {
      const logger = c.get("logger");
      const auth = c.get("gatewayAuth");
      if (!auth) {
        // gatewayAuth 先挂载，正常不会走到；防御性兜底
        return c.json({ error: { message: "Unauthorized" } }, 401);
      }
      const rawBody = c.req.valid("json") as Record<string, unknown>;
      // 入站协议 → 内部 OpenAI Chat 形态（P1；缓存键仍以原始入站 body 为准，协议隔离由 cachePrefix 负责）
      const body = toInternal ? toInternal(rawBody) : rawBody;
      const model = typeof body["model"] === "string" ? body["model"] : "";
      const stream = body["stream"] === true;
      const db = createDb(c.env);
      const startTime = Date.now();

      // 5. 缓存（仅非流式 && key.cacheEnabled）→ 命中直接返回（不转发、不扣费）
      const cacheable = !stream && auth.key.cacheEnabled;
      let cacheKey: string | null = null;
      if (cacheable) {
        const bodyHash = await hashRequestBody(rawBody);
        cacheKey = buildCacheKey(auth.key.id, model, bodyHash, cachePrefix);
        const cached = await getCachedResponse(c.env.CACHE_KV, cacheKey);
        if (cached !== null) {
          logger.info("cache_hit", { keyId: auth.key.id, model });
          const cachedLog: RequestLogRecord = {
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: null,
            model,
            status: "cached",
            latencyMs: Date.now() - startTime,
          };
          await recordRequestLog(db, cachedLog);
          enqueueUsage(c, cachedLog);
          return c.json(cached);
        }
      }

      // 4. 模型路由：候选池（协议偏好优先同类型，无命中回退全量）
      const candidates = await resolveCandidates(db, model, providerType);
      if (candidates.length === 0) {
        logger.warn("model_not_routed", { model, keyId: auth.key.id });
        const rejectedLog: RequestLogRecord = {
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: null,
          model,
          status: "rejected",
          latencyMs: Date.now() - startTime,
        };
        await recordRequestLog(db, rejectedLog);
        enqueueUsage(c, rejectedLog);
        return c.json(
          {
            error: {
              message: `The model '${model}' does not exist or you do not have access to it.`,
            },
          },
          404,
        );
      }

      // 内部请求形态恒为 OpenAI Chat Completions 兼容（P1）；每轮尝试重建上游请求，天然可重试
      const internalReq: InternalRequest = { kind, body, model, stream };
      const multiCandidate = candidates.length > 1;

      // 尝试列表（转移上限 1 次 → 总尝试 ≤ 2）：
      //   单候选 → 恒为现状路径（零回归：无 hash、无 KV、无重试）；
      //   多候选 → 首选 = keyId 哈希落点（粘性，断路跳过），其后按 id 升序补一个未断路候选。
      const attempts: ResolvedProvider[] = [];
      let allCircuitsOpen = false;
      if (!multiCandidate) {
        // candidates.length >= 1（上面已处理 0 候选，越界为不可达防御）
        attempts.push(atOrThrow(candidates, 0, "resolveCandidates"));
      } else {
        const routeCandidates: RouteCandidate[] = candidates.map((c) => ({
          providerId: c.providerId,
          weight: c.weight,
        }));
        const picked = await pickHealthyProvider(
          routeCandidates,
          auth.key.id,
          (id) => isCircuitOpen(c.env.CACHE_KV, id),
        );
        if (picked === null) {
          allCircuitsOpen = true;
        } else {
          attempts.push(
            candidates.find((c) => c.providerId === picked.providerId) ??
              atOrThrow(candidates, 0, "resolveCandidates"),
          );
          for (const cand of candidates) {
            if (attempts.some((a) => a.providerId === cand.providerId)) {
              continue;
            }
            if (!(await isCircuitOpen(c.env.CACHE_KV, cand.providerId))) {
              attempts.push(cand);
            }
            if (attempts.length >= 2) {
              break;
            }
          }
        }
      }

      // 全部候选断路（open 态拒绝语义）：不逐个撞墙，502 明确错误（TTL 到期自动恢复）
      if (allCircuitsOpen) {
        logger.warn("all_providers_circuit_open", { model, keyId: auth.key.id });
        const allOpenLog: RequestLogRecord = {
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: atOrThrow(candidates, 0, "resolveCandidates").providerId,
          model,
          status: "error",
          latencyMs: Date.now() - startTime,
        };
        await recordRequestLog(db, allOpenLog);
        enqueueUsage(c, allOpenLog);
        return c.json(
          { error: { message: "All upstream providers are temporarily unavailable" } },
          502,
        );
      }

      // 5/6. 尝试循环：解密 → 适配器构造 → 转发；失败分类（连接/超时/5xx/429）转移并写断路器
      let upstreamResp: Response | null = null;
      let adapter: ProviderAdapter | null = null;
      let resolvedProviderId: number = attempts[0]?.providerId ?? 0;
      let lastError: { status: number; message: string } | null = null;
      for (let i = 0; i < attempts.length; i++) {
        // i < attempts.length，索引必在界内（越界为不可达防御）
        const cand = atOrThrow(attempts, i, "attempts");
        const nextId = attempts[i + 1]?.providerId;

        adapter = getAdapter(cand.type);
        if (!adapter) {
          logger.error("unknown_provider_type", {
            providerId: cand.providerId,
            type: cand.type,
          });
          return c.json({ error: { message: "Provider type not supported" } }, 500);
        }
        if (!adapter.supports(kind)) {
          if (!multiCandidate) {
            return c.json(
              {
                error: {
                  message: `Provider type '${cand.type}' does not support this endpoint`,
                },
              },
              400,
            );
          }
          // 多候选：类型不支持是配置问题而非健康问题 → 跳过该候选，不写断路器
          logger.warn("provider_skip_unsupported", {
            providerId: cand.providerId,
            type: cand.type,
            kind,
            model,
          });
          continue;
        }

        // 解密上游密钥（仅请求内存中使用）
        let upstreamKey: string;
        try {
          upstreamKey = await decryptSecret(cand.apiKeyEnc, c.env.GATEWAY_SECRET_KEY);
        } catch (error) {
          if (error instanceof Error) {
            logger.error("provider_key_decrypt_failed", {
              providerId: cand.providerId,
              error: error.message,
            });
          }
          return c.json(
            { error: { message: "Upstream provider key decryption failed" } },
            500,
          );
        }

        // 适配器构造上游请求（内部形态恒为 OpenAI Chat Completions 兼容，P1）
        const cfg: ProviderConfig = {
          type: cand.type as ProviderType,
          baseUrl: cand.baseUrl,
          apiKey: upstreamKey,
          models: cand.models,
        };
        let upstreamReq: UpstreamRequest;
        try {
          upstreamReq = adapter.buildRequest(internalReq, cfg);
        } catch (error) {
          if (error instanceof AdapterError) {
            logger.warn("adapter_error", {
              providerId: cand.providerId,
              model,
              message: error.message,
            });
            return c.json({ error: { message: error.message } }, 400);
          }
          throw error;
        }

        // 6. 转发（含超时）
        try {
          upstreamResp = await fetchUpstream(upstreamReq.url, upstreamReq.init);
        } catch (error) {
          // 4.3 失败语义：上游网络错误/超时 → 不扣费，明细记 error
          const upstreamLatencyMs = Date.now() - startTime;
          logUpstreamError(logger, cand.providerId, model, error);
          const reason = error instanceof UpstreamTimeoutError ? "timeout" : "network";
          const errorLog: RequestLogRecord = {
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: cand.providerId,
            model,
            status: "error",
            latencyMs: Date.now() - startTime,
            upstreamLatencyMs,
          };
          await recordRequestLog(db, errorLog);
          enqueueUsage(c, errorLog);
          if (multiCandidate) {
            await openCircuit(c.env.CACHE_KV, cand.providerId, reason);
            logger.warn("provider_failover", {
              fromProviderId: cand.providerId,
              toProviderId: nextId,
              model,
              reason,
              keyId: auth.key.id,
            });
          }
          lastError =
            error instanceof UpstreamTimeoutError
              ? { status: 504, message: error.message }
              : { status: 502, message: "Failed to reach upstream provider" };
          continue;
        }

        // 上游非 2xx：归一化 OpenAI 风格错误体（4.3：不扣费，明细记 error）
        if (!upstreamResp.ok) {
          const message = await extractUpstreamError(upstreamResp);
          const upstreamLatencyMs = Date.now() - startTime;
          logger.warn("upstream_error", {
            providerId: cand.providerId,
            model,
            status: upstreamResp.status,
            message,
          });
          const errorLog: RequestLogRecord = {
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: cand.providerId,
            model,
            status: "error",
            latencyMs: Date.now() - startTime,
            upstreamLatencyMs,
          };
          await recordRequestLog(db, errorLog);
          enqueueUsage(c, errorLog);
          // 4xx（非 429）为客户端错误，转候选也不会成功：透传，不转移
          const retryable = upstreamResp.status === 429 || upstreamResp.status >= 500;
          if (!retryable) {
            return c.json({ error: { message } }, toContentStatus(upstreamResp.status));
          }
          // 429 / 5xx：可转移 → 写断路器 + 转移下一候选
          const reason = upstreamResp.status === 429 ? "429" : "5xx";
          if (multiCandidate) {
            await openCircuit(c.env.CACHE_KV, cand.providerId, reason);
            logger.warn("provider_failover", {
              fromProviderId: cand.providerId,
              toProviderId: nextId,
              model,
              reason,
              status: upstreamResp.status,
              keyId: auth.key.id,
            });
          }
          lastError = { status: upstreamResp.status, message };
          continue;
        }

        // 成功：锁定本次执行的 provider，退出尝试循环
        resolvedProviderId = cand.providerId;
        // 清除转移前记录的最后失败（转移后第二候选成功时不得回退到失败语义）
        lastError = null;
        break;
      }

      // 全部尝试失败（网络/超时/5xx/429 转移后仍失败）：返回最后一次尝试的真实错误
      if (lastError !== null) {
        return c.json(
          { error: { message: lastError.message } },
          toContentStatus(lastError.status),
        );
      }

      // 成功路径不变量：循环仅在成功时 break（upstreamResp.ok 且 adapter 已锁定）
      if (upstreamResp === null || adapter === null) {
        logger.error("proxy_success_invariant_broken", { model, keyId: auth.key.id });
        return c.json({ error: { message: "Upstream provider error" } }, 502);
      }

      const upstreamLatencyMs = Date.now() - startTime;

      // 流式：适配器转换（OpenAI 透传 / Anthropic 事件转换）后以 SSE 返回；
      // 包装流在尾包 usage 到达（或流结束）后结算（4.2）
      if (stream) {
        if (!upstreamResp.body) {
          logger.error("upstream_stream_empty", {
            providerId: resolvedProviderId,
            model,
          });
          const emptyStreamLog: RequestLogRecord = {
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: resolvedProviderId,
            model,
            status: "error",
            latencyMs: Date.now() - startTime,
            upstreamLatencyMs,
          };
          await recordRequestLog(db, emptyStreamLog);
          enqueueUsage(c, emptyStreamLog);
          return c.json({ error: { message: "Upstream returned no stream body" } }, 502);
        }
        const transformed = adapter.transformStreamToOpenAI(upstreamResp.body);
        const settled = wrapStreamWithSettlement(
          transformed,
          async (usage) => {
            const price = await findModelPrice(db, model);
            const cost = usage !== null && price !== null ? calcCost(usage, price) : 0;
            if (usage === null || price === null) {
              // 无 usage 尾包 → 免计策略（PRD R5.4 / M4 4.2）
              logger.info("stream_settle_free", {
                providerId: resolvedProviderId,
                model,
                reason: usage === null ? "no_usage" : "no_price",
              });
            }
            const settleLog: ChargeUsageInput = {
              userId: auth.user.id,
              keyId: auth.key.id,
              providerId: resolvedProviderId,
              model,
              promptTokens: usage?.promptTokens ?? 0,
              completionTokens: usage?.completionTokens ?? 0,
              cost,
              latencyMs: Date.now() - startTime,
              upstreamLatencyMs,
              status: "success",
            };
            const result = await chargeUsage(db, settleLog);
            // 流式结算点在 settle 回调内直接 await（响应已开始消费，waitUntil 不再可靠）
            await enqueueUsageEvent(c.env.USAGE_QUEUE, settleLog);
            if (cost > 0 && !result.charged) {
              logger.warn("overdraft_rejected", {
                userId: auth.user.id,
                cost,
                model,
              });
            }
          },
          logger,
        );
        logger.info("proxy_stream_started", {
          providerId: resolvedProviderId,
          model,
          keyId: auth.key.id,
        });
        // P1：协议出站流式转换（默认恒等；结算包装在前，与输出格式正交）
        const outboundStream = transformStream ? transformStream(settled) : settled;
        return new Response(outboundStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      // 非流式：OpenAI 透传 / Anthropic 格式转换
      let data: unknown;
      try {
        data = await upstreamResp.json();
      } catch {
        logger.error("upstream_non_json_response", {
          providerId: resolvedProviderId,
          model,
          status: upstreamResp.status,
        });
        const nonJsonLog: RequestLogRecord = {
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: resolvedProviderId,
          model,
          status: "error",
          latencyMs: Date.now() - startTime,
          upstreamLatencyMs,
        };
        await recordRequestLog(db, nonJsonLog);
        enqueueUsage(c, nonJsonLog);
        return c.json({ error: { message: "Upstream returned a non-JSON response" } }, 502);
      }
      // P1：适配器正向转换在前（OpenAI 透传 / Anthropic 格式转换），协议出站转换在最后
      const output =
        adapter.transformResponse !== undefined ? adapter.transformResponse(data) : data;
      const outbound = transformResponse !== undefined ? transformResponse(output, c) : output;

      // 7. 计费（成功）：usage → 价格 → 费用 → 条件 UPDATE 原子扣费 + 流水 + 明细
      const usage = adapter.parseUsage(data) ?? extractLooseUsage(data);
      const price = await findModelPrice(db, model);
      const cost = usage !== null && price !== null ? calcCost(usage, price) : 0;
      if (usage === null || price === null) {
        logger.info("charge_skipped", {
          providerId: resolvedProviderId,
          model,
          reason: usage === null ? "no_usage" : "no_price",
        });
      }
      const successLog: ChargeUsageInput = {
        userId: auth.user.id,
        keyId: auth.key.id,
        providerId: resolvedProviderId,
        model,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        cost,
        latencyMs: Date.now() - startTime,
        upstreamLatencyMs,
        status: "success",
      };
      const charge = await chargeUsage(db, successLog);
      enqueueUsage(c, successLog);
      if (cost > 0 && !charge.charged) {
        logger.warn("overdraft_rejected", {
          userId: auth.user.id,
          cost,
          model,
        });
      }

      // 8. 缓存写（非阻塞，不拖慢响应）；缓存内容 = 协议出站形态的响应（P3）
      if (cacheKey !== null) {
        c.executionCtx.waitUntil(
          setCachedResponse(c.env.CACHE_KV, cacheKey, outbound, auth.key.cacheTtl),
        );
      }

      logger.info("proxy_success", {
        providerId: resolvedProviderId,
        model,
        keyId: auth.key.id,
        cost,
        charged: charge.charged,
      });
      return c.json(outbound);
    },
  );
}

/** 现有三端点薄包装（P1）：默认参数（恒等 toInternal / 出站转换、空缓存前缀），行为逐字节不变。
 * providerType: "openai" 为协议偏好：OpenAI 面请求优先 openai provider；仅配 anthropic
 * provider 时回退命中（既有 claude 上游配置行为不变）。 */
export function proxyRoute(app: Hono<AppEnv>, kind: EndpointKind): void {
  proxyRouteWithOptions(app, PATH_BY_KIND[kind], {
    inputSchema: INPUT_SCHEMAS[kind],
    kind,
    providerType: "openai",
  });
}
