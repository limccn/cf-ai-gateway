// POST /api/models — 新增价格（admin 覆盖 seed 默认；model 唯一冲突 409）。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { models, type Model } from "../../../db/schema";
import { createDb } from "../../../db";
import { createModelInputSchema } from "../types";
import { toModelResponse } from "../lib/convert";

export function createModelRoute(app: Hono<AppEnv>): void {
  app.post("/", zValidator("json", createModelInputSchema), async (c) => {
    const logger = c.get("logger");
    const body = c.req.valid("json");
    const db = createDb(c.env);

    // 唯一约束预检（并发下仍可能撞约束，由 catch 兜底 409）
    const existing = await db.query.models.findFirst({
      where: eq(models.model, body.model),
    });
    if (existing) {
      throw new HTTPException(409, {
        message: `Model price '${body.model}' already exists`,
      });
    }

    let row: Model | undefined;
    try {
      const inserted = await db.insert(models).values(body).returning();
      row = inserted[0];
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new HTTPException(409, {
          message: `Model price '${body.model}' already exists`,
        });
      }
      throw error;
    }
    if (!row) {
      throw new HTTPException(500, { message: "Failed to create model price" });
    }

    logger.info("model_price_created", { model: row.model });
    return c.json({ success: true as const, model: toModelResponse(row) });
  });
}
