// DELETE /api/keys/:id — 删除 Key（member 仅自身，admin 全部）。删除后请求返回 401。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { apiKeys } from "../../../db/schema";
import { createDb } from "../../../db";
import { keyIdParamSchema } from "../types";
import { findAuthorizedKey } from "../lib/access";

export function deleteKeyRoute(app: Hono<AppEnv>): void {
  app.delete("/:id", zValidator("param", keyIdParamSchema), async (c) => {
    const logger = c.get("logger");
    const params = c.req.valid("param");
    const userId = Number(c.get("userId"));
    const role = c.get("role") ?? "member";
    const db = createDb(c.env);

    const existing = await findAuthorizedKey(db, params.id, userId, role);
    if (!existing) {
      throw new HTTPException(404, { message: "API key not found" });
    }

    await db.delete(apiKeys).where(eq(apiKeys.id, existing.id));

    logger.warn("api_key_deleted", { keyId: existing.id, userId });
    return c.json({ success: true as const });
  });
}
