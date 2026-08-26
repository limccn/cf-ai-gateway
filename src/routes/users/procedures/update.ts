// PATCH /api/users/:id — 角色变更 / 停用启用（admin）。
// 防护：不允许 admin 停用自己或将自己降级为 member（避免管理员自锁）。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { users } from "../../../db/schema";
import { createDb } from "../../../db";
import { updateUserInputSchema, userIdParamSchema } from "../types";
import { toUserResponse } from "../lib/convert";

export function updateUserRoute(app: Hono<AppEnv>): void {
  app.patch(
    "/:id",
    zValidator("param", userIdParamSchema),
    zValidator("json", updateUserInputSchema),
    async (c) => {
      const logger = c.get("logger");
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      const currentUserId = c.get("userId");
      const db = createDb(c.env);

      const existing = await db.query.users.findFirst({
        where: eq(users.id, params.id),
      });
      if (!existing) {
        throw new HTTPException(404, { message: "User not found" });
      }

      const isSelf = currentUserId === String(existing.id);
      if (isSelf && body.status === "disabled") {
        throw new HTTPException(400, {
          message: "Cannot disable your own account",
        });
      }
      if (isSelf && body.role !== undefined && body.role !== "admin") {
        throw new HTTPException(400, {
          message: "Cannot demote your own account",
        });
      }

      const [updated] = await db
        .update(users)
        .set({
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, params.id))
        .returning();
      if (!updated) {
        throw new HTTPException(404, { message: "User not found" });
      }

      logger.info("user_updated", {
        targetUserId: updated.id,
        byUserId: currentUserId,
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      return c.json({ success: true as const, user: toUserResponse(updated) });
    },
  );
}
