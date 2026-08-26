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

    if (current >= limit) {
      logger.warn("rate_limit_exceeded", {
        keyId: auth.key.id,
        limit,
        windowStart,
      });
      return c.json(
        { error: { message: "Rate limit exceeded. Please slow down and try again later." } },
        429,
      );
    }

    await c.env.CACHE_KV.put(kvKey, String(current + 1), {
      expirationTtl: COUNTER_TTL_SECONDS,
    });
    await next();
  };
};
