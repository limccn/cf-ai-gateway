// 引导模块（09-16-first-login-welcome）：GET /api/me/onboarding（读首登欢迎状态）、
// POST /api/me/onboarding/welcome-seen（标记已读）。
// 前后端唯一真源：前端 app/modules/onboarding/types.ts 从本文件 re-export（type-safety spec），
// 前端不另写一份字段联合 —— 改契约只改这里。
import { z } from "zod";

// ============= 输出 Schemas =============

/**
 * 首登欢迎状态。
 * - pending=true：应展示首登弹窗；此时 bonusAmount 为该用户 signup_bonus 流水的实际金额。
 * - pending=false：不展示；bonusAmount 恒为 null（无待展示金额，前端无需再判）。
 *
 * 用 `boolean + nullable number` 而非可辨识联合：pending=false 的两个来源（已读过标记 /
 * 无赠金流水）前端处理完全相同，联合只会让消费侧多一层分支。
 */
export const onboardingWelcomeSchema = z.object({
  pending: z.boolean(),
  bonusAmount: z.number().nullable(),
});

export const onboardingOutputSchema = z.object({
  success: z.literal(true),
  welcome: onboardingWelcomeSchema,
});

/** 标记已读响应：空 body、无请求参数；重复调用同样 success（幂等语义）。 */
export const markWelcomeSeenOutputSchema = z.object({
  success: z.literal(true),
});

// ============= 类型导出 =============

export type OnboardingWelcome = z.infer<typeof onboardingWelcomeSchema>;
export type OnboardingOutput = z.infer<typeof onboardingOutputSchema>;
export type MarkWelcomeSeenOutput = z.infer<typeof markWelcomeSeenOutputSchema>;
