// 代理面鉴权中间件（M3 3.3 第一步）：Bearer 网关 API Key → 查 api_keys(hash) → 关联 user。
// 与 /api/* 的会话鉴权（requireSession）并存、互不冲突：路径分离，本中间件只挂 /v1/*。
// 失败统一 OpenAI 风格错误体 `{error:{message}}`（3.6）。
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, GatewayAuthContext } from "../types";
import { apiKeys, users } from "../db/schema";
import { createDb } from "../db";
import { hashToken } from "../lib/security";

export const gatewayAuth = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const logger = c.get("logger");

    // P4：Bearer 优先（OpenAI 客户端行为不变）；缺失时回退 x-api-key（Anthropic SDK 默认头）。
    // token 值只用于 hash 比对，不落日志（security spec）。
    const authHeader = c.req.header("Authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const token =
      bearerToken.length > 0 ? bearerToken : (c.req.header("x-api-key") ?? "").trim();
    if (token.length === 0) {
      logger.warn("gateway_auth_missing", { path: c.req.path });
      return c.json(
        {
          error: {
            message:
              "Missing API key. Provide 'Authorization: Bearer <gateway_key>' or 'x-api-key' header.",
          },
        },
        401,
      );
    }

    // anthropic-version 宽容处理（P4）：缺失不拒绝（curl/多云客户端可能不带）；格式异常仅日志
    const anthropicVersion = c.req.header("anthropic-version");
    if (anthropicVersion !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(anthropicVersion)) {
      logger.warn("anthropic_version_unusual", {
        version: anthropicVersion,
        path: c.req.path,
      });
    }

    const hash = await hashToken(token);
    const db = createDb(c.env);
    const key = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.hash, hash),
    });
    if (!key) {
      logger.warn("gateway_auth_invalid_key", { path: c.req.path });
      return c.json({ error: { message: "Invalid API key" } }, 401);
    }
    if (key.status !== "active") {
      logger.warn("gateway_auth_revoked_key", { keyId: key.id, path: c.req.path });
      return c.json({ error: { message: "API key has been revoked" } }, 401);
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, key.userId),
    });
    if (!user) {
      logger.warn("gateway_auth_orphan_key", { keyId: key.id, path: c.req.path });
      return c.json({ error: { message: "Invalid API key" } }, 401);
    }
    if (user.status !== "active") {
      logger.warn("gateway_auth_disabled_user", { userId: user.id, path: c.req.path });
      return c.json({ error: { message: "Account disabled" } }, 403);
    }

    const ctx: GatewayAuthContext = { key, user };
    c.set("gatewayAuth", ctx);
    logger.info("gateway_authenticated", { keyId: key.id, userId: user.id });

    await next();
  };
};
