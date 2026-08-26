// PATCH /api/models/:id — 更新价格（admin）。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { models } from "../../../db/schema";
import { createDb } from "../../../db";
import { modelIdParamSchema, updateModelInputSchema } from "../types";
import { toModelResponse } from "../lib/convert";

export function updateModelRoute(app: Hono<AppEnv>): void {
  app.patch(
    "/:id",
    zValidator("param", modelIdParamSchema),
    zValidator("json", updateModelInputSchema),
    async (c) => {
      const logger = c.get("logger");
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      const db = createDb(c.env);

      const updated = await db
        .update(models)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(models.id, params.id))
        .returning();
      const row = updated[0];
      if (!row) {
        throw new HTTPException(404, { message: "Model price not found" });
      }

      logger.info("model_price_updated", { id: row.id, model: row.model });
      return c.json({ success: true as const, model: toModelResponse(row) });
    },
  );
}
