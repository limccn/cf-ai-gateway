// 入站协议感知中间件（08-31-protocol-auto-detect，design §4.1）：仅注册于 /v1/messages。
// 顺序：error-adapt 之前（v1/router.ts）。行为：
// - 请求体 JSON 解析成功 → detectProtocol → c.set("detectedProtocol")（后续 proxy 变体 / error-adapt 动态格式消费）。
// - 双向冲突 → c.set("detectedProtocol","anthropic")（错误形态沿用现状）+ 400 返回。
//   注意：直接 return c.json() 会短路中间件链（error-adapt 的 post-phase 不执行——它在 await
//   next() 之后），故错误体在此直接按 Anthropic 形态构造（400 → invalid_request_error，
//   与 error-adapt 映射一致）；也不抛异常：抛 HTTPException 同样绕过 error-adapt。
// - 非 JSON body（如鉴权 401 空请求）→ 不设置（走默认，零回归）。
// Hono c.req.json() 有解析缓存：后续 zValidator / handler 复用同一份，无双重解析。
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { detectProtocol, ProtocolDetectionError } from "../lib/protocol-detect";

export function protocolDetectMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // 未认证短路（LOW perf）：无凭据请求必被 gatewayAuth 401，无需 parse body 判定协议；
    // 免去攻击/扫描流量全量 JSON 解析。带凭据但失败仍由 gatewayAuth 兜底 401。
    if (c.req.header("authorization") === null) {
      return next();
    }
    const body: unknown = await c.req.json().catch(() => null);
    if (body === null) {
      return next();
    }
    try {
      const protocol = detectProtocol(body, new Headers(c.req.header()));
      c.set("detectedProtocol", protocol);
    } catch (error) {
      if (error instanceof ProtocolDetectionError) {
        c.set("detectedProtocol", "anthropic");
        // 短路返回：error-adapt 的 post-phase 不会执行，直接按 Anthropic 形态构造
        // （400 → invalid_request_error，与 error-adapt 映射一致）
        return c.json(
          { type: "error", error: { type: "invalid_request_error", message: error.message } },
          400,
        );
      }
      throw error;
    }
    return next();
  };
}
