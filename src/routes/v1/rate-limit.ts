// 代理面限流中间件（M3 3.3 第二步，占位实现）。
// KV 固定 60s 窗口计数器：`rate:{keyId}:{windowStart}`；超限 429（OpenAI 风格错误体）。
// M3 占位说明：get+put 非原子（KV 无原子自增），边界突发可接受（design §8 权衡）；
// 并发精确语义与可配置窗口在 M4（4.4）完善。
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types";

/** 固定窗口长度（秒）；qpsLimit 语义 = 每分钟请求上限（PRD R6.1）。导出供 /api/admin/settings 展示。 */
export const WINDOW_SECONDS = 60;
/** KV 计数器 TTL：两倍窗口，防残留。 */
const COUNTER_TTL_SECONDS = WINDOW_SECONDS * 2;

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
    const windowStart = Math.floor(Date.now() / (WINDOW_SECONDS * 1000)) * WINDOW_SECONDS;
    const kvKey = `rate:${auth.key.id}:${windowStart}`;

    const currentRaw = await c.env.CACHE_KV.get(kvKey);
    const parsed = currentRaw ? parseInt(currentRaw, 10) : 0;
    const current = Number.isFinite(parsed) ? parsed : 0;

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
      await c.env.CACHE_KV.put(kvKey, String(current + 1), {
        expirationTtl: COUNTER_TTL_SECONDS,
      });
    }
  };
};
