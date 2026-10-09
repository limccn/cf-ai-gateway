// POST /api/users/invites — 生成邀请码（admin）。完整 code 仅在本次响应中展示一次。
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { inviteCodes } from "../../../db/schema";
import { createDb } from "../../../db";
import { generateInviteCode } from "../../../lib/invites";
import { createInviteInputSchema } from "../types";
import { toInviteCodeResponse } from "../lib/convert";

export function createInviteRoute(app: Hono<AppEnv>): void {
  app.post("/invites", zValidator("json", createInviteInputSchema), async (c) => {
    const logger = c.get("logger");
    const body = c.req.valid("json");
    const adminUserId = c.get("userId");
    const db = createDb(c.env);

    const code = generateInviteCode();
    const expiresAt = new Date(
      Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000,
    );
    const [invite] = await db
      .insert(inviteCodes)
      .values({ code, createdBy: Number(adminUserId), expiresAt })
      .returning();
    if (!invite) {
      throw new HTTPException(500, { message: "Failed to create invite code" });
    }

    logger.info("invite_created", {
      inviteId: invite.id,
      byUserId: adminUserId,
      expiresInDays: body.expiresInDays,
    });
    // 创建响应回显完整 code（仅展示一次）
    return c.json({
      success: true as const,
      invite: toInviteCodeResponse(invite),
    });
  });
}
