// 代理面核心处理器（M3 3.3 + M4 4.1-4.5）。
// 中间件链（router.ts 挂载）：gatewayAuth → gatewayRateLimit → gatewayBalanceCheck → zValidator。
// 处理器内（design §3 步骤 5/6/7/8）：
//   5. 缓存（非流式 && key.cacheEnabled）→ 命中直接返回（不转发、不扣费，明细记 cached）；
//      R2 触发收窄：请求体 > 32KB 跳过评估；小请求未命中先计数（10min 窗口 ≥2 次才写缓存）。
//   4. 模型路由（Provider 选择）
//   6. 适配器构造 + 超时转发
//   7. 计费（08-31-perf-v2 延迟计费）：成功路径（非流式/流式 settle）只发 BILLING_QUEUE 事件
//      （waitUntil 旁路，0 同步 D1 读写）；扣费 + 明细 + balance_tx 由消费者批内执行；
//      失败语义（4.3）：上游错误/超时 → 不扣费，明细记 error（同步，带 request_id 幂等键）。
//   8. 非流式成功且（小上下文 ∧ 高频重传）→ 响应写 KV（waitUntil 非阻塞）。
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
  TokenUsage,
  UpstreamRequest,
} from "../../providers/types";
import { decryptSecret } from "../../lib/security";
import {
  maskModelInData,
  maskModelInErrorMessage,
  maskModelInStream,
} from "../../lib/model-mask";
import { parseProviderModels } from "../../lib/provider-models";
import { resolveModelId, strip1mSuffix } from "../../lib/model-id";
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
  buildCountKey,
  bumpCacheMissCount,
  getCachedResponse,
  hashRequestBody,
  MAX_CACHE_BODY_BYTES,
  MAX_CACHE_RESPONSE_BYTES,
  setCachedResponse,
} from "../../lib/response-cache";
import { extractLooseUsage, recordRequestLog } from "../../lib/billing";
import type { RequestLogRecord } from "../../lib/billing";
import { buildBillingEvent, sendBillingEvent } from "../../lib/billing-queue";
import { enqueueUsageEvent } from "../../lib/usage-aggregation";
import {
  createAnthropicUsageDetector,
  wrapStreamWithSettlement,
} from "../../lib/stream-settle";
import type { SseFrameTransform } from "../../providers/sse-pipe";

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
  /** 流式出站协议转换（字节级；R2.4 起仅 anthropic 上游 corner 路径使用，默认恒等）。
   * 主路径用 streamConsumer（帧级，结算管线消费同一批帧）。 */
  transformStream?: (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
  /** 流式出站帧级事件转换工厂（R2.4；每次调用创建独立状态机；OpenAI 上游主路径）。
   * 缺省 = 原始字节透传（P1）。 */
  streamConsumer?: () => SseFrameTransform;
  /** anthropic 上游 + anthropic 原生入站 → 协议短路（P2a）：字节原样透传，
   * settle 用 Anthropic 提取器，不经过转换器。 */
  passthroughAnthropicStream?: boolean;
  /** 缓存键协议命名空间前缀（协议间隔离，如 "anthropic:"）；默认 ""（现有端点键不变）。 */
  cachePrefix?: string;
  /** 入站协议偏好的 provider 类型：模型路由优先匹配同类型 provider（如 Anthropic 协议
   * → type=anthropic 的 provider 原生转发，OpenAI 协议 → type=openai），无同类型命中
   * 时回退按 id 升序全量匹配（既有配置零回归）。默认不限定（行为不变）。 */
  providerType?: ProviderType;
  /**
   * 协议变体（08-31-protocol-auto-detect，design §5）：detectedProtocol 命中时用变体字段
   * 覆盖 base；缺省 undefined → eff === options（现有端点逐字节不变）。
   * kind / inputSchema 不入变体（统一入口用统一 schema）。
   */
  protocolVariants?: Partial<
    Pick<
      ProxyEndpointOptions,
      | "toInternal"
      | "transformResponse"
      | "transformStream"
      | "streamConsumer"
      | "passthroughAnthropicStream"
      | "cachePrefix"
      | "providerType"
    >
  > & { protocol: import("../../lib/protocol-detect").Protocol };
}

interface ResolvedProvider {
  providerId: number;
  type: string;
  baseUrl: string;
  apiKeyEnc: string;
  /** 高级 HTTP 选项密文（NULL ≡ 未配置）。 */
  httpOptionsEnc: string | null;
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
      // 后缀感知匹配（PRD R1.1）：精确命中优先，请求带 `[1m]` 时剥离后缀回退匹配
      if (resolveModelId(models, model).matched) {
        out.push({
          providerId: row.id,
          type: row.type,
          baseUrl: row.baseUrl,
          apiKeyEnc: row.apiKeyEnc,
          httpOptionsEnc: row.httpOptionsEnc,
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
  const { inputSchema, kind = "chat" } = options;

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
      // 协议变体（design §5）：detectedProtocol 命中变体 → 变体字段覆盖 base；缺省 → options 本身
      const proto = c.get("detectedProtocol");
      const eff =
        proto !== undefined && options.protocolVariants?.protocol === proto
          ? { ...options, ...options.protocolVariants }
          : options;
      const {
        toInternal,
        transformResponse,
        transformStream,
        streamConsumer,
        passthroughAnthropicStream,
        cachePrefix = "",
        providerType,
      } = eff;
      const rawBody = c.req.valid("json") as Record<string, unknown>;
      // 入站协议 → 内部 OpenAI Chat 形态（P1；缓存键仍以原始入站 body 为准，协议隔离由 cachePrefix 负责）
      const body = toInternal ? toInternal(rawBody) : rawBody;
      const model = typeof body["model"] === "string" ? body["model"] : "";
      // 计费/记录/缓存统一使用剥离 `[1m]` 后缀的模型名（PRD R1.3）；上游名保留后缀由适配器负责
      const billingModel = strip1mSuffix(model);
      const stream = body["stream"] === true;
      const db = createDb(c.env);
      const startTime = Date.now();
      // 幂等键：优先取 Cloudflare 边缘请求 id（cf-ray，可与边缘日志关联；请求路径统一生成，
      // 延迟计费消费者按此去重）。本地/miniflare 无 cf-ray 头 → 回退 UUID（唯一性由两端保证）。
      const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
      // R2.1 体树早释放（关键）：waitUntil 延迟路径（计费事件/缓存写）只引用提前解构的
      // 局部常量（不捕获 c）——handler 返回后请求体对象树随 c 回收，不随旁路任务常驻 isolate。
      const BILLING_QUEUE = c.env.BILLING_QUEUE;
      const CACHE_KV = c.env.CACHE_KV;
      const executionCtx = c.executionCtx;

      // 5. 缓存（仅非流式 && key.cacheEnabled）→ 命中直接返回（不转发、不扣费）
      // R2 触发收窄：请求体 > MAX_CACHE_BODY_BYTES → 跳过整个缓存评估（不 hash、不读 KV、不计数、不写）；
      // 小请求未命中 → 计数（第 1 次只计数；10min 窗口 ≥2 次 → cacheWriteKey，响应成功后写缓存）。
      const cacheable = !stream && auth.key.cacheEnabled;
      let cacheKey: string | null = null;
      let cacheWriteKey: string | null = null;
      if (cacheable) {
        const bodyBytes = JSON.stringify(rawBody).length;
        if (bodyBytes > MAX_CACHE_BODY_BYTES) {
          logger.info("cache_skip_large_body", {
            bytes: bodyBytes,
            keyId: auth.key.id,
            model: billingModel,
          });
        } else {
          // model 归一化为计费名（[1m] 声明不影响语义/响应）：`xxx` 与 `xxx[1m]` 共享缓存（R1.3）
          const bodyHash = await hashRequestBody(
            model !== "" ? { ...rawBody, model: billingModel } : rawBody,
          );
          cacheKey = buildCacheKey(auth.key.id, billingModel, bodyHash, cachePrefix);
          const cached = await getCachedResponse(CACHE_KV, cacheKey);
          if (cached !== null) {
            logger.info("cache_hit", { keyId: auth.key.id, model: billingModel });
            const cachedLog: RequestLogRecord = {
              requestId,
              userId: auth.user.id,
              keyId: auth.key.id,
              providerId: null,
              model: billingModel,
              status: "cached",
              latencyMs: Date.now() - startTime,
            };
            await recordRequestLog(db, cachedLog);
            enqueueUsage(c, cachedLog);
            return c.json(cached);
          }
          // 未命中：高频重传计数（同键窗口内第 2+ 次出现 → 本次成功后写缓存）
          if (
            await bumpCacheMissCount(
              CACHE_KV,
              buildCountKey(auth.key.id, billingModel, bodyHash),
            )
          ) {
            cacheWriteKey = cacheKey;
          }
        }
      }

      // 4. 模型路由：候选池（协议偏好优先同类型，无命中回退全量）
      const candidates = await resolveCandidates(db, model, providerType);
      if (candidates.length === 0) {
        logger.warn("model_not_routed", { model: billingModel, keyId: auth.key.id });
        const rejectedLog: RequestLogRecord = {
          requestId,
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: null,
          model: billingModel,
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
        logger.warn("all_providers_circuit_open", { model: billingModel, keyId: auth.key.id });
        const allOpenLog: RequestLogRecord = {
          requestId,
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: atOrThrow(candidates, 0, "resolveCandidates").providerId,
          model: billingModel,
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
      // 实际执行 provider 的模型映射（伪装层 upstreamModel 来源；失败路径记录最后一次尝试者）
      let resolvedModels: Record<string, string> = {};
      let lastErrorUpstreamModel = model;
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
            model: billingModel,
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

        // 高级 HTTP 选项解密（headers 可能含上游认证值，与 apiKey 同规范 AES-GCM）；
        // 解密/解析失败 → 空对象（增强项失败不阻断转发，防御性兜底）
        let httpOptions: ProviderConfig["httpOptions"];
        if (cand.httpOptionsEnc === null) {
          httpOptions = undefined;
        } else {
          try {
            const parsed: unknown = JSON.parse(
              await decryptSecret(cand.httpOptionsEnc, c.env.GATEWAY_SECRET_KEY),
            );
            httpOptions =
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as ProviderConfig["httpOptions"])
                : undefined;
          } catch (error) {
            if (error instanceof Error) {
              logger.warn("http_options_decrypt_failed", {
                providerId: cand.providerId,
                error: error.message,
              });
            }
            httpOptions = undefined;
          }
        }

        // 适配器构造上游请求（内部形态恒为 OpenAI Chat Completions 兼容，P1）
        const cfg: ProviderConfig = {
          type: cand.type as ProviderType,
          baseUrl: cand.baseUrl,
          apiKey: upstreamKey,
          models: cand.models,
          ...(httpOptions !== undefined ? { httpOptions } : {}),
        };
        let upstreamReq: UpstreamRequest;
        try {
          upstreamReq = adapter.buildRequest(internalReq, cfg);
        } catch (error) {
          if (error instanceof AdapterError) {
            logger.warn("adapter_error", {
              providerId: cand.providerId,
              model: billingModel,
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
          logUpstreamError(logger, cand.providerId, billingModel, error);
          const reason = error instanceof UpstreamTimeoutError ? "timeout" : "network";
          // 尝试级明细行不携带请求级 requestId：部分唯一索引（request_logs_request_id_idx）
          // 每键只允许一行，而一次请求最多 2 次尝试、每次各落一行（且失败尝试可能与成功路径的
          // 计费事件同请求）——请求级幂等键只属于计费事件（消费者写成功明细），尝试级错误行置 NULL
          const errorLog: RequestLogRecord = {
            requestId: null,
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: cand.providerId,
            model: billingModel,
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
              model: billingModel,
              reason,
              keyId: auth.key.id,
            });
          }
          lastError =
            error instanceof UpstreamTimeoutError
              ? { status: 504, message: error.message }
              : { status: 502, message: "Failed to reach upstream provider" };
          lastErrorUpstreamModel = cand.models[model] ?? model;
          continue;
        }

        // 上游非 2xx：归一化 OpenAI 风格错误体（4.3：不扣费，明细记 error）
        if (!upstreamResp.ok) {
          const message = await extractUpstreamError(upstreamResp);
          const upstreamLatencyMs = Date.now() - startTime;
          logger.warn("upstream_error", {
            providerId: cand.providerId,
            model: billingModel,
            status: upstreamResp.status,
            message,
          });
          // 尝试级明细行不携带请求级 requestId（同上方网络错误路径：每次尝试一行，
          // 且可能与成功路径计费事件同请求；幂等键只属于计费事件）
          const errorLog: RequestLogRecord = {
            requestId: null,
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: cand.providerId,
            model: billingModel,
            status: "error",
            latencyMs: Date.now() - startTime,
            upstreamLatencyMs,
          };
          await recordRequestLog(db, errorLog);
          enqueueUsage(c, errorLog);
          // 4xx（非 429）为客户端错误，转候选也不会成功：透传，不转移（错误消息伪装）
          const retryable = upstreamResp.status === 429 || upstreamResp.status >= 500;
          if (!retryable) {
            return c.json(
              {
                error: {
                  message: maskModelInErrorMessage(message, model, cand.models[model] ?? model),
                },
              },
              toContentStatus(upstreamResp.status),
            );
          }
          // 429 / 5xx：可转移 → 写断路器 + 转移下一候选
          const reason = upstreamResp.status === 429 ? "429" : "5xx";
          if (multiCandidate) {
            await openCircuit(c.env.CACHE_KV, cand.providerId, reason);
            logger.warn("provider_failover", {
              fromProviderId: cand.providerId,
              toProviderId: nextId,
              model: billingModel,
              reason,
              status: upstreamResp.status,
              keyId: auth.key.id,
            });
          }
          lastError = { status: upstreamResp.status, message };
          lastErrorUpstreamModel = cand.models[model] ?? model;
          continue;
        }

        // 成功：锁定本次执行的 provider，退出尝试循环
        resolvedProviderId = cand.providerId;
        resolvedModels = cand.models;
        // 清除转移前记录的最后失败（转移后第二候选成功时不得回退到失败语义）
        lastError = null;
        break;
      }

      // 全部尝试失败（网络/超时/5xx/429 转移后仍失败）：返回最后一次尝试的真实错误（错误消息伪装）
      if (lastError !== null) {
        return c.json(
          {
            error: {
              message: maskModelInErrorMessage(
                lastError.message,
                model,
                lastErrorUpstreamModel,
              ),
            },
          },
          toContentStatus(lastError.status),
        );
      }

      // 成功路径不变量：循环仅在成功时 break（upstreamResp.ok 且 adapter 已锁定）
      if (upstreamResp === null || adapter === null) {
        logger.error("proxy_success_invariant_broken", { model: billingModel, keyId: auth.key.id });
        return c.json({ error: { message: "Upstream provider error" } }, 502);
      }

      const upstreamLatencyMs = Date.now() - startTime;

      // 流式：适配器转换（OpenAI 透传 / Anthropic 事件转换）后以 SSE 返回；
      // 包装流在尾包 usage 到达（或流结束）后结算（4.2）
      if (stream) {
        if (!upstreamResp.body) {
          logger.error("upstream_stream_empty", {
            providerId: resolvedProviderId,
            model: billingModel,
          });
          const emptyStreamLog: RequestLogRecord = {
            requestId,
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: resolvedProviderId,
            model: billingModel,
            status: "error",
            latencyMs: Date.now() - startTime,
            upstreamLatencyMs,
          };
          await recordRequestLog(db, emptyStreamLog);
          enqueueUsage(c, emptyStreamLog);
          return c.json({ error: { message: "Upstream returned no stream body" } }, 502);
        }
        // R2.1 体树早释放（关键）：settle 回调只引用提前解构的局部常量（不捕获 c）
        // ——handler 返回后请求体对象树（92.7k 输入可到数十 MB）随 c 回收，
        // 不再随 8-10s 上游等待/长输出流常驻 isolate。
        const settleCb = async (usage: TokenUsage | null): Promise<void> => {
          if (usage === null) {
            // 无 usage 尾包 → 免计策略（PRD R5.4 / M4 4.2；no_price 由消费者判定）
            logger.info("stream_settle_free", {
              providerId: resolvedProviderId,
              model: billingModel,
              reason: "no_usage",
            });
          }
          // 延迟计费：settle 回调只发事件（不 await D1，0 同步读写）；
          // 扣费 + 明细 + 流水由消费者批内执行（结算时刻价格，request_id 幂等）。
          executionCtx.waitUntil(
            sendBillingEvent(
              BILLING_QUEUE,
              buildBillingEvent({
                requestId,
                userId: auth.user.id,
                keyId: auth.key.id,
                providerId: resolvedProviderId,
                model: billingModel,
                usage,
                latencyMs: Date.now() - startTime,
                upstreamLatencyMs,
                ts: Date.now(),
              }),
            ),
          );
        };
        // R2.4 统一流式管线：settle 结算旁路挂在帧层（O(1)/帧，无字节累积），
        // 协议转换消费同一批帧（单次 decode/parse）；按上游形态组合出站：
        //   P2a 短路：anthropic 入站 + anthropic 上游 → 字节原样透传（Anthropic 提取器）
        //   角例：anthropic 上游 + 字节出站转换（responses）→ 旧字节链（接受额外 parse）
        //   正向：anthropic 上游 → OpenAI 出站（adapter 帧级转换）
        //   P1/P2b/P3：openai 上游 → 出站帧级事件转换（如有）
        const upstreamAnthropic = adapter.type === "anthropic";
        let outboundStream: ReadableStream<Uint8Array>;
        if (upstreamAnthropic && passthroughAnthropicStream === true) {
          outboundStream = wrapStreamWithSettlement(upstreamResp.body, settleCb, logger, {
            detector: createAnthropicUsageDetector(),
          });
        } else if (upstreamAnthropic && transformStream !== undefined) {
          outboundStream = transformStream(
            wrapStreamWithSettlement(
              adapter.transformStreamToOpenAI(upstreamResp.body),
              settleCb,
              logger,
            ),
          );
        } else if (upstreamAnthropic) {
          outboundStream = wrapStreamWithSettlement(upstreamResp.body, settleCb, logger, {
            detector: createAnthropicUsageDetector(),
            transform: adapter.createStreamToOpenAI?.(),
          });
        } else {
          outboundStream = wrapStreamWithSettlement(upstreamResp.body, settleCb, logger, {
            transform: streamConsumer?.(),
          });
        }
        logger.info("proxy_stream_started", {
          providerId: resolvedProviderId,
          model: billingModel,
          keyId: auth.key.id,
        });
        // 伪装在最终出站形态上（恒等映射时整链字节透传，零开销）
        const maskedStream = maskModelInStream(
          outboundStream,
          model,
          resolvedModels[model] ?? model,
        );
        return new Response(maskedStream, {
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
          model: billingModel,
          status: upstreamResp.status,
        });
        const nonJsonLog: RequestLogRecord = {
          requestId,
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: resolvedProviderId,
          model: billingModel,
          status: "error",
          latencyMs: Date.now() - startTime,
          upstreamLatencyMs,
        };
        await recordRequestLog(db, nonJsonLog);
        enqueueUsage(c, nonJsonLog);
        return c.json({ error: { message: "Upstream returned a non-JSON response" } }, 502);
      }
      // P1：适配器正向转换在前（OpenAI 透传 / Anthropic 格式转换），协议出站转换在最后；
      // 伪装在最终出站形态上（恒等映射时零开销恒等变换）；缓存内容即伪装形态
      const output =
        adapter.transformResponse !== undefined ? adapter.transformResponse(data) : data;
      const outbound = transformResponse !== undefined ? transformResponse(output, c) : output;
      const maskedOutbound = maskModelInData(
        outbound,
        model,
        resolvedModels[model] ?? model,
      );

      // 7. 计费（成功）：延迟计费 —— 组装计费事件 → BILLING_QUEUE（waitUntil 旁路，0 同步 D1 读写）；
      //    扣费 + 明细 + balance_tx + 聚合事件由消费者批内执行（结算时刻价格，request_id 幂等）。
      const usage = adapter.parseUsage(data) ?? extractLooseUsage(data);
      if (usage === null) {
        // 无 usage → 免计策略（PRD R5.4 / M4 4.2；no_price 由消费者判定）
        logger.info("charge_skipped", {
          providerId: resolvedProviderId,
          model: billingModel,
          reason: "no_usage",
        });
      }
      executionCtx.waitUntil(
        sendBillingEvent(
          BILLING_QUEUE,
          buildBillingEvent({
            requestId,
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: resolvedProviderId,
            model: billingModel,
            usage,
            latencyMs: Date.now() - startTime,
            upstreamLatencyMs,
            ts: Date.now(),
          }),
        ),
      );

      // 8. 缓存写（非阻塞，不拖慢响应）；仅当 R2 触发条件成立（小上下文 ∧ 高频重传）。
      // 缓存内容 = 伪装后的协议出站形态（P3）。R3：stringify 一次 → 体积复用；>5MB 跳过缓存（照常返回）
      if (cacheWriteKey !== null) {
        const serialized = JSON.stringify(maskedOutbound);
        if (
          typeof serialized === "string" &&
          serialized.length > MAX_CACHE_RESPONSE_BYTES
        ) {
          logger.info("cache_skip_large_response", {
            bytes: serialized.length,
            keyId: auth.key.id,
            model: billingModel,
          });
        } else {
          executionCtx.waitUntil(
            setCachedResponse(CACHE_KV, cacheWriteKey, serialized, auth.key.cacheTtl),
          );
        }
      }

      logger.info("proxy_success", {
        providerId: resolvedProviderId,
        model: billingModel,
        keyId: auth.key.id,
      });
      return c.json(maskedOutbound);
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
