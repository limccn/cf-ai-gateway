// POST /api/keys/:id/revoke — 撤销 Key（member 仅自身，admin 全部）。撤销后请求返回 401。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { apiKeys } from "../../../db/schema";
import { createDb } from "../../../db";
import { keyIdParamSchema } from "../types";
import { toKeyResponse } from "../lib/convert";
import { findAuthorizedKey } from "../lib/access";

export function revokeKeyRoute(app: Hono<AppEnv>): void {
  app.post(
    "/:id/revoke",
    zValidator("param", keyIdParamSchema),
    async (c) => {
      const logger = c.get("logger");
      const params = c.req.valid("param");
      const userId = Number(c.get("userId"));
      const role = c.get("role") ?? "member";
      const db = createDb(c.env);

      const existing = await findAuthorizedKey(db, params.id, userId, role);
      if (!existing) {
        throw new HTTPException(404, { message: "API key not found" });
      }
      if (existing.status === "revoked") {
        throw new HTTPException(409, { message: "API key already revoked" });
      }

      const [revoked] = await db
        .update(apiKeys)
        .set({ status: "revoked" })
        .where(eq(apiKeys.id, existing.id))
        .returning();
      if (!revoked) {
        throw new HTTPException(500, { message: "Failed to revoke API key" });
      }

      logger.warn("api_key_revoked", { keyId: revoked.id, userId });
      return c.json({ success: true as const, key: toKeyResponse(revoked) });
    },
  );
}
