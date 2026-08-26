// GET /api/providers — Provider 列表（admin）。密钥一律 mask，明文永不下发。
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
import { createDb } from "../../../db";
import { toProviderResponse } from "../lib/convert";

export function listProvidersRoute(app: Hono<AppEnv>): void {
  app.get("/", async (c) => {
    const logger = c.get("logger");
    const db = createDb(c.env);
    const rows = await db.select().from(providers);
    logger.info("providers_listed", { total: rows.length });
    return c.json({
      success: true as const,
      items: rows.map(toProviderResponse),
    });
  });
}
