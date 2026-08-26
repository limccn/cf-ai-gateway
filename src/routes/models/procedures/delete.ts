// DELETE /api/models/:id — 删除价格（admin）。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { models } from "../../../db/schema";
import { createDb } from "../../../db";
import { modelIdParamSchema } from "../types";

export function deleteModelRoute(app: Hono<AppEnv>): void {
  app.delete("/:id", zValidator("param", modelIdParamSchema), async (c) => {
    const logger = c.get("logger");
    const params = c.req.valid("param");
    const db = createDb(c.env);

    const deleted = await db
      .delete(models)
      .where(eq(models.id, params.id))
      .returning({ id: models.id, model: models.model });
    const row = deleted[0];
    if (!row) {
      throw new HTTPException(404, { message: "Model price not found" });
    }

    logger.info("model_price_deleted", { id: row.id, model: row.model });
    return c.json({ success: true as const });
  });
}
