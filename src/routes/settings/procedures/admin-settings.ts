// GET /api/admin/settings — 当前生效的运行时默认配置（admin 只读，无修改端点）。
// 数值来自各模块的唯一来源：DEFAULT_CACHE_TTL_SECONDS（schema 默认值）、
// WINDOW_SECONDS（rate-limit.ts）、parseRetentionDays（cleanup.ts，env 覆盖）。
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { DEFAULT_CACHE_TTL_SECONDS } from "../../../db/schema";
import { WINDOW_SECONDS } from "../../v1/rate-limit";
import { parseRetentionDays } from "../../../lib/cleanup";

export function adminSettingsRoute(app: Hono<AppEnv>): void {
  app.get("/settings", async (c) => {
    const logger = c.get("logger");
    const requestLogRetentionDays = parseRetentionDays(
      c.env.REQUEST_LOG_RETENTION_DAYS,
    );

    logger.info("admin_settings_reported", {
      cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
      rateLimitWindowSeconds: WINDOW_SECONDS,
      requestLogRetentionDays,
    });

    return c.json({
      success: true as const,
      settings: {
        cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
        rateLimitWindowSeconds: WINDOW_SECONDS,
        requestLogRetentionDays,
      },
    });
  });
}
