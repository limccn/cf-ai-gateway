// 邀请码模块（批次 U，D28–D30）：注册前预校验的公开端点契约。
//
// 只有一个端点 GET /api/invites/validate —— 注册页在提交前把「码是否可用」提前告知用户，
// 把 Better Auth 注册 403（"Invalid, used or expired invite code"）从提交后的报错
// 提前为表单可见的警示（prd AC50）。
//
// 响应语义与注册侧 403 **同口径、不细分原因**（不存在 / 已用 / 过期 统一 valid:false）：
// 码空间 31^10 ≈ 2^49.5 枚举不可行，但细分原因只会给探测者多送信息
// （「这个码存在但已用」= 存在性预言机）。缺参 / 空码同样统一 false，少一个错误分支。
import { z } from "zod";

// ============= 输出 Schemas =============

export const validateInviteOutputSchema = z.object({
  success: z.literal(true),
  valid: z.boolean(),
});

// ============= 类型导出 =============

export type ValidateInviteOutput = z.infer<typeof validateInviteOutputSchema>;
