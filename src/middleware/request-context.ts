// 请求上下文中间件（spec environment.md：MUST 最先挂载）。
// 注入 requestId + 结构化 logger；后续中间件与路由通过 c.get("requestId") / c.get("logger") 使用。
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { createRequestLogger } from "../lib/logger";

export const requestContext = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    // crypto.randomUUID() 必须在请求处理内调用（Cloudflare Workers 禁止全局作用域随机）
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.set("logger", createRequestLogger(requestId));
    await next();
  };
};
