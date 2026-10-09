// 认证与权限中间件（M2 2.2 / 2.5）。
// - requireSession：Bearer/会话 Cookie 鉴权（Better Auth getSession），注入 userId + role；未登录 401。
// - adminOnly：要求 role === 'admin'，否则 403。
// - selfOrAdmin：admin 放行；member 仅当路径参数 :id 等于自身 userId 时放行，否则 403。
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, UserRole } from "../types";
import { createAuth } from "../lib/auth";
import { createDb } from "../db";

export const requireSession = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const logger = c.get("logger");
    const auth = createAuth(c.env, createDb(c.env));
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      logger.warn("unauthorized_access", { path: c.req.path });
      throw new HTTPException(401, { message: "Unauthorized" });
    }

    if (session.user.status === "disabled") {
      logger.warn("disabled_user_access", {
        userId: session.user.id,
        path: c.req.path,
      });
      throw new HTTPException(403, { message: "Account disabled" });
    }

    const role: UserRole = session.user.role === "admin" ? "admin" : "member";
    c.set("session", session.session);
    c.set("user", session.user);
    c.set("userId", session.user.id);
    c.set("role", role);

    logger.info("authenticated_request", {
      userId: session.user.id,
      role,
      path: c.req.path,
    });
    await next();
  };
};

export const adminOnly = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (c.get("role") !== "admin") {
      c.get("logger").warn("admin_only_access_denied", {
        userId: c.get("userId"),
        path: c.req.path,
      });
      throw new HTTPException(403, { message: "Forbidden" });
    }
    await next();
  };
};

export const selfOrAdmin = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (c.get("role") === "admin") {
      await next();
      return;
    }
    const userId = c.get("userId");
    const targetId = c.req.param("id");
    if (!targetId || targetId !== userId) {
      c.get("logger").warn("self_or_admin_access_denied", {
        userId,
        targetId,
        path: c.req.path,
      });
      throw new HTTPException(403, { message: "Forbidden" });
    }
    await next();
  };
};
