// 代理面限流中间件（M3 3.3 第二步；O1 方案 B 重写，09-11-kv-ops-optimization）。
// isolate 模块级计数 + KV 定期落账（rate-counter.ts）：每请求 1 KV 读（全局快照 +
// 本地增量合成），KV 写仅在落账触发时发生（delta≥5 / 30s 兜底 / 失败退避）。
// 语义保留：固定 60s 窗口、计数后移（status<500 才消耗配额）、429 不计数、
// 标准限流头公式不变；KV 读失败 → 快照按 0 处理（fail-open 到本地有界计数，
// 不 500——先例 proxy.ts modelcap「KV 抖动不 fail-closed」）。
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types";
import {
  WINDOW_SECONDS,
  ensureEntry,
  flushEntry,
  kvKey,
  recordIncrement,
  windowStartOf,
} from "../../lib/rate-counter";

/** 固定窗口长度（秒）；qpsLimit 语义 = 每分钟请求上限。导出供 /api/admin/settings 展示。 */
export { WINDOW_SECONDS };

export const gatewayRateLimit = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const logger = c.get("logger");
    const auth = c.get("gatewayAuth");
    if (!auth) {
      // gatewayAuth 先挂载，正常不会走到；防御性兜底放行
      await next();
      return;
    }

    const limit = auth.key.qpsLimit;
    const windowStart = windowStartOf(Date.now());

    let snapshot = 0;
    try {
      const raw = await c.env.CACHE_KV.get(kvKey(auth.key.id, windowStart));
      const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
      snapshot = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch (error) {
      logger.warn("rate_limit_kv_read_failed", {
        keyId: auth.key.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const entry = ensureEntry(auth.key.id, windowStart);
    const current = snapshot + entry.local;

    // 标准限流头（窗口语义：limit=每分钟上限，reset=窗口结束 unix 秒）
    const windowEnd = windowStart + WINDOW_SECONDS;
    const rateLimitHeaders = {
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Reset": String(windowEnd),
      "X-RateLimit-Remaining": String(Math.max(0, limit - current - 1)),
    };
    // next() 前设置成功头（SSE 流式响应头部先于流体发出，next 后设置无效）
    for (const [name, value] of Object.entries(rateLimitHeaders)) {
      c.header(name, value);
    }

    if (current >= limit) {
      logger.warn("rate_limit_exceeded", {
        keyId: auth.key.id,
        limit,
        windowStart,
      });
      c.header("Retry-After", String(Math.max(1, windowEnd - Math.floor(Date.now() / 1000))));
      return c.json(
        { error: { message: "Rate limit exceeded. Please slow down and try again later." } },
        429,
      );
    }

    // 计数后移：请求成功处理（next 返回）后才消耗配额 —— 5xx 上游失败不惩罚重试；
    // 4xx（402 余额不足/400 校验失败等）仍计数（客户端问题，防滥用）。
    await next();
    if (c.res.status < 500) {
      if (recordIncrement(auth.key.id, windowStart)) {
        c.executionCtx.waitUntil(flushEntry(c.env.CACHE_KV, auth.key.id, entry));
      }
    }
  };
};
