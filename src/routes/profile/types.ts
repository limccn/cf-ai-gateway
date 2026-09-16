// 账户 Profile 模块（09-16-account-menu）：GET /api/me/profile（member 自己，只读）。
//
// 为什么只读、为什么不复用 session（design §1）：
// - name 的写入走 Better Auth 内置 POST /api/auth/update-user —— 库内部硬拦 email 改动
//   （结构性满足「不支持改邮箱」），且更新后回写 session cookie → 前端 session store
//   立即拿到新值。自建写端点只会多一条与库行为可能漂移的路径。
// - session 下发的 SessionUser（app/lib/session.ts）不含 emailVerified 与验证开关，
//   且可能因 staleTime 滞后；本端点一次给全 Dialog 渲染所需的服务端最新值。
//
// 前后端唯一真源：前端 app/modules/profile/types.ts 从本文件 re-export（type-safety spec），
// 前端不另写一份字段联合 —— 改契约只改这里。
import { z } from "zod";

// ============= 输出 Schemas =============

export const profileSchema = z.object({
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  /**
   * 邮箱验证功能总开关（EMAIL_VERIFICATION_ENABLED env 经 isEmailVerificationEnabled 解析的
   * 生效值，非原始字符串）。关闭时前端不展示「重新发送验证邮件」入口（R7/AC9）——
   * 该判断必须走本字段，不能靠调用失败来发现（开关关闭时 emailVerification 段整段不存在）。
   */
  emailVerificationEnabled: z.boolean(),
});

export const profileOutputSchema = z.object({
  success: z.literal(true),
  profile: profileSchema,
});

// ============= 类型导出 =============

export type Profile = z.infer<typeof profileSchema>;
export type ProfileOutput = z.infer<typeof profileOutputSchema>;
