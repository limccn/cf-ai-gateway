// GET /api/models — 价格表列表（admin）。
import { asc } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { models } from "../../../db/schema";
import { createDb } from "../../../db";
import { toModelResponse } from "../lib/convert";

export function listModelsRoute(app: Hono<AppEnv>): void {
  app.get("/", async (c) => {
    const logger = c.get("logger");
    const db = createDb(c.env);

    const rows = await db.select().from(models).orderBy(asc(models.model));

    logger.info("model_prices_listed", { total: rows.length });
    return c.json({
      success: true as const,
      items: rows.map(toModelResponse),
      total: rows.length,
    });
  });
}
