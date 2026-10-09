// POST /api/me/onboarding/welcome-seen —— 标记首登欢迎弹窗已读（幂等、空 body、无参数）。
//
// 条件 UPDATE（WHERE welcome_seen_at IS NULL）而非无条件写入：
// - 并发双开标签页各自关闭弹窗时都发一次本请求，只有先到的命中，**不改写首次阅读时间**；
// - 与仓库既有的「乐观锁 / 条件写入」模式一致（见 src/lib/bonus.ts 的标记列用法）。
//
// 无论是否命中都返回 success：语义是「已读」这一状态已达成（幂等），重复调用不是错误 —— 前端
// 无需区分首次/重复，减少一个失败分支。
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { users } from "../../../db/schema";
import type { MarkWelcomeSeenOutput } from "../types";

export function markWelcomeSeenRoute(app: Hono<AppEnv>): void {
  app.post("/me/onboarding/welcome-seen", async (c) => {
    const logger = c.get("logger");
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      // requireSession 正常已注入；防御性兜底（同 me-transactions）
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const db = createDb(c.env);
    const now = new Date();

    const marked = await db
      .update(users)
      .set({ welcomeSeenAt: now, updatedAt: now })
      .where(and(eq(users.id, userId), isNull(users.welcomeSeenAt)))
      .returning({ id: users.id });

    logger.info("welcome_seen_marked", {
      userId,
      firstMark: marked.length > 0,
    });
    const output: MarkWelcomeSeenOutput = { success: true };
    return c.json(output);
  });
}
