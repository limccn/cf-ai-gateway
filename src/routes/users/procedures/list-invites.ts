// GET /api/users/invites — 邀请码列表（admin；code 脱敏展示，含使用/过期状态）。
import { desc } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { inviteCodes } from "../../../db/schema";
import { createDb } from "../../../db";
import { toInviteCodeResponse } from "../lib/convert";

export function listInvitesRoute(app: Hono<AppEnv>): void {
  app.get("/invites", async (c) => {
    const db = createDb(c.env);
    const rows = await db
      .select()
      .from(inviteCodes)
      .orderBy(desc(inviteCodes.id))
      .limit(100);
    // mask=true：列表不回显完整 code
    return c.json({
      success: true as const,
      items: rows.map((row) => toInviteCodeResponse(row, true)),
    });
  });
}
