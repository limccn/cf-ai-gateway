// GET /api/me/onboarding —— 首登欢迎状态（是否该弹「赠金已到账」+ 展示金额）。
// userId 取自会话（/me 路径天然 self；admin 也看自己的首登状态）。
//
// 判定顺序短路（design §2.1）—— 顺序即成本/语义优先级：
//   1. users.welcome_seen_at 非 NULL → 已读过（绝大多数请求止步于此：单表主键查询）
//   2. balance_tx 无 signup_bonus 行 → 赠金关闭 / 存量用户 / 赠金发放失败，一律不弹
//   3. 有流水 → pending=true，金额取**该流水行的实际金额**
//
// 金额为什么读流水而不读 env：用户在赠金为 8 时注册、之后开关改成 5，弹窗仍应显示他实际拿到的 8；
// 且天然覆盖「配置是 5 但赠金发放失败（无流水）」的场景 —— 展示与实际到账恒一致。
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { balanceTx, users } from "../../../db/schema";
import type { OnboardingOutput } from "../types";

/** 不展示（已读过 / 无赠金流水）的共用响应体。 */
const NOT_PENDING: OnboardingOutput = {
  success: true,
  welcome: { pending: false, bonusAmount: null },
};

export function getOnboardingRoute(app: Hono<AppEnv>): void {
  app.get("/me/onboarding", async (c) => {
    const logger = c.get("logger");
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      // requireSession 正常已注入；防御性兜底（同 me-transactions）
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const db = createDb(c.env);

    // 短路 1：已读过欢迎弹窗 → 不再查流水
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { welcomeSeenAt: true },
    });
    if (!user || user.welcomeSeenAt !== null) {
      return c.json(NOT_PENDING);
    }

    // 短路 2/3：注册赠金流水。balance_tx_bonus_once_idx（部分唯一索引）保证同档至多一行，
    // 故 findFirst 无歧义（无需 orderBy）。
    const bonus = await db.query.balanceTx.findFirst({
      where: and(
        eq(balanceTx.userId, userId),
        eq(balanceTx.type, "signup_bonus"),
      ),
      columns: { amount: true },
    });
    if (!bonus) {
      return c.json(NOT_PENDING);
    }

    logger.info("me_onboarding_reported", {
      userId,
      pending: true,
      bonusAmount: bonus.amount,
    });
    const output: OnboardingOutput = {
      success: true,
      welcome: { pending: true, bonusAmount: bonus.amount },
    };
    return c.json(output);
  });
}
