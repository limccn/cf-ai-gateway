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
  ProviderConfig,
  ProviderType,
  UpstreamRequest,
} from "../../providers/types";
import { decryptSecret } from "../../lib/security";
import { parseProviderModels } from "../../lib/provider-models";
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

interface ResolvedProvider {
  providerId: number;
  type: string;
  baseUrl: string;
  apiKeyEnc: string;
  models: Record<string, string>;
}

/** 模型路由：按 provider id 升序找第一个 enabled 且 models 映射包含该内部模型名的 Provider。 */
async function resolveProvider(db: Db, model: string): Promise<ResolvedProvider | null> {
  const rows = await db
    .select()
    .from(providers)
    .where(eq(providers.enabled, true))
    .orderBy(asc(providers.id));
  for (const row of rows) {
    const models = parseProviderModels(row.models);
    if (models[model] !== undefined) {
      return {
        providerId: row.id,
        type: row.type,
        baseUrl: row.baseUrl,
        apiKeyEnc: row.apiKeyEnc,
        models,
      };
    }
  }
  return null;
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

export function proxyRoute(app: Hono<AppEnv>, kind: EndpointKind): void {
  app.post(
    PATH_BY_KIND[kind],
    gatewayRateLimit(),
    gatewayBalanceCheck(),
    // 校验失败 400 由 src/index.ts 全局中间件统一为 {error:{message}}（M8）
    zValidator("json", INPUT_SCHEMAS[kind]),
    async (c) => {
      const logger = c.get("logger");
      const auth = c.get("gatewayAuth");
      if (!auth) {
        // gatewayAuth 先挂载，正常不会走到；防御性兜底
        return c.json({ error: { message: "Unauthorized" } }, 401);
      }
      const body = c.req.valid("json") as Record<string, unknown>;
      const model = typeof body["model"] === "string" ? body["model"] : "";
      const stream = body["stream"] === true;
      const db = createDb(c.env);
      const startTime = Date.now();

      // 5. 缓存（仅非流式 && key.cacheEnabled）→ 命中直接返回（不转发、不扣费）
      const cacheable = !stream && auth.key.cacheEnabled;
      let cacheKey: string | null = null;
      if (cacheable) {
        const bodyHash = await hashRequestBody(body);
        cacheKey = buildCacheKey(auth.key.id, model, bodyHash);
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

      // 4. 模型路由
      const resolved = await resolveProvider(db, model);
      if (!resolved) {
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

      const adapter = getAdapter(resolved.type);
      if (!adapter) {
        logger.error("unknown_provider_type", {
          providerId: resolved.providerId,
          type: resolved.type,
        });
        return c.json({ error: { message: "Provider type not supported" } }, 500);
      }
      if (!adapter.supports(kind)) {
        return c.json(
          {
            error: {
              message: `Provider type '${resolved.type}' does not support this endpoint`,
            },
          },
          400,
        );
      }

      // 解密上游密钥（仅请求内存中使用）
      let upstreamKey: string;
      try {
        upstreamKey = await decryptSecret(resolved.apiKeyEnc, c.env.GATEWAY_SECRET_KEY);
      } catch (error) {
        if (error instanceof Error) {
          logger.error("provider_key_decrypt_failed", {
            providerId: resolved.providerId,
            error: error.message,
          });
        }
        return c.json(
          { error: { message: "Upstream provider key decryption failed" } },
          500,
        );
      }

      // 适配器构造上游请求
      const internalReq: InternalRequest = { kind, body, model, stream };
      const cfg: ProviderConfig = {
        type: resolved.type as ProviderType,
        baseUrl: resolved.baseUrl,
        apiKey: upstreamKey,
        models: resolved.models,
      };
      let upstreamReq: UpstreamRequest;
      try {
        upstreamReq = adapter.buildRequest(internalReq, cfg);
      } catch (error) {
        if (error instanceof AdapterError) {
          logger.warn("adapter_error", {
            providerId: resolved.providerId,
            model,
            message: error.message,
          });
          return c.json({ error: { message: error.message } }, 400);
        }
        throw error;
      }

      // 6. 转发（含超时）
      let upstreamResp: Response;
      try {
        upstreamResp = await fetchUpstream(upstreamReq.url, upstreamReq.init);
      } catch (error) {
        // 4.3 失败语义：上游网络错误/超时 → 不扣费，明细记 error
        const upstreamLatencyMs = Date.now() - startTime;
        logUpstreamError(logger, resolved.providerId, model, error);
        const errorLog: RequestLogRecord = {
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: resolved.providerId,
          model,
          status: "error",
          latencyMs: Date.now() - startTime,
          upstreamLatencyMs,
        };
        await recordRequestLog(db, errorLog);
        enqueueUsage(c, errorLog);
        if (error instanceof UpstreamTimeoutError) {
          return c.json({ error: { message: error.message } }, 504);
        }
        return c.json({ error: { message: "Failed to reach upstream provider" } }, 502);
      }

      // 上游非 2xx：透传状态码 + 归一化 OpenAI 风格错误体（4.3：不扣费，明细记 error）
      if (!upstreamResp.ok) {
        const message = await extractUpstreamError(upstreamResp);
        const upstreamLatencyMs = Date.now() - startTime;
        logger.warn("upstream_error", {
          providerId: resolved.providerId,
          model,
          status: upstreamResp.status,
          message,
        });
        const errorLog: RequestLogRecord = {
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: resolved.providerId,
          model,
          status: "error",
          latencyMs: Date.now() - startTime,
          upstreamLatencyMs,
        };
        await recordRequestLog(db, errorLog);
        enqueueUsage(c, errorLog);
        return c.json({ error: { message } }, toContentStatus(upstreamResp.status));
      }

      const upstreamLatencyMs = Date.now() - startTime;

      // 流式：适配器转换（OpenAI 透传 / Anthropic 事件转换）后以 SSE 返回；
      // 包装流在尾包 usage 到达（或流结束）后结算（4.2）
      if (stream) {
        if (!upstreamResp.body) {
          logger.error("upstream_stream_empty", {
            providerId: resolved.providerId,
            model,
          });
          const emptyStreamLog: RequestLogRecord = {
            userId: auth.user.id,
            keyId: auth.key.id,
            providerId: resolved.providerId,
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
                providerId: resolved.providerId,
                model,
                reason: usage === null ? "no_usage" : "no_price",
              });
            }
            const settleLog: ChargeUsageInput = {
              userId: auth.user.id,
              keyId: auth.key.id,
              providerId: resolved.providerId,
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
          providerId: resolved.providerId,
          model,
          keyId: auth.key.id,
        });
        return new Response(settled, {
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
          providerId: resolved.providerId,
          model,
          status: upstreamResp.status,
        });
        const nonJsonLog: RequestLogRecord = {
          userId: auth.user.id,
          keyId: auth.key.id,
          providerId: resolved.providerId,
          model,
          status: "error",
          latencyMs: Date.now() - startTime,
          upstreamLatencyMs,
        };
        await recordRequestLog(db, nonJsonLog);
        enqueueUsage(c, nonJsonLog);
        return c.json({ error: { message: "Upstream returned a non-JSON response" } }, 502);
      }
      const output =
        adapter.transformResponse !== undefined ? adapter.transformResponse(data) : data;

      // 7. 计费（成功）：usage → 价格 → 费用 → 条件 UPDATE 原子扣费 + 流水 + 明细
      const usage = adapter.parseUsage(data) ?? extractLooseUsage(data);
      const price = await findModelPrice(db, model);
      const cost = usage !== null && price !== null ? calcCost(usage, price) : 0;
      if (usage === null || price === null) {
        logger.info("charge_skipped", {
          providerId: resolved.providerId,
          model,
          reason: usage === null ? "no_usage" : "no_price",
        });
      }
      const successLog: ChargeUsageInput = {
        userId: auth.user.id,
        keyId: auth.key.id,
        providerId: resolved.providerId,
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

      // 8. 缓存写（非阻塞，不拖慢响应）
      if (cacheKey !== null) {
        c.executionCtx.waitUntil(
          setCachedResponse(c.env.CACHE_KV, cacheKey, output, auth.key.cacheTtl),
        );
      }

      logger.info("proxy_success", {
        providerId: resolved.providerId,
        model,
        keyId: auth.key.id,
        cost,
        charged: charge.charged,
      });
      return c.json(output);
    },
  );
}
