// PATCH /api/keys/:id — 更新 Key 配置（名称/限流/缓存开关；member 仅自身，admin 全部）。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { apiKeys } from "../../../db/schema";
import { createDb } from "../../../db";
import { updateKeyInputSchema, keyIdParamSchema } from "../types";
import { toKeyResponse } from "../lib/convert";
import { findAuthorizedKey } from "../lib/access";

export function updateKeyRoute(app: Hono<AppEnv>): void {
  app.patch(
    "/:id",
    zValidator("param", keyIdParamSchema),
    zValidator("json", updateKeyInputSchema),
    async (c) => {
      const logger = c.get("logger");
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      const userId = Number(c.get("userId"));
      const role = c.get("role") ?? "member";
      const db = createDb(c.env);

      const existing = await findAuthorizedKey(db, params.id, userId, role);
      if (!existing) {
        throw new HTTPException(404, { message: "API key not found" });
      }
      if (existing.status === "revoked") {
        throw new HTTPException(409, { message: "Cannot update a revoked key" });
      }

      const [updated] = await db
        .update(apiKeys)
        .set(body)
        .where(eq(apiKeys.id, existing.id))
        .returning();
      if (!updated) {
        throw new HTTPException(500, { message: "Failed to update API key" });
      }

      logger.info("api_key_updated", { keyId: updated.id, userId });
      return c.json({ success: true as const, key: toKeyResponse(updated) });
    },
  );
}
