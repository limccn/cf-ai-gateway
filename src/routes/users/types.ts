// 用户管理模块（M2 2.6，admin）：Zod schema + 类型定义（api-module spec）。
// 时间戳一律 ISO 字符串（type-safety spec：全 API 统一格式）。
import { z } from "zod";

// ============= 输入 Schemas =============

export const listUsersQuerySchema = z.object({
  search: z.string().max(100).optional(),
  role: z.enum(["admin", "member"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const updateUserInputSchema = z
  .object({
    role: z.enum(["admin", "member"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "At least one of role or status is required",
  });

export const createInviteInputSchema = z.object({
  expiresInDays: z.coerce.number().int().min(1).max(90).default(30),
});

export const userIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** 管理员代充/扣减（R5.1）：amount 带符号（±），不允许 0。 */
export const adjustBalanceInputSchema = z.object({
  amount: z.number().refine((v) => v !== 0, {
    message: "amount must not be zero",
  }),
  note: z.string().max(500).optional(),
});

// ============= 输出 Schemas =============

export const userResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
  status: z.enum(["active", "disabled"]),
  balance: z.number(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listUsersOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(userResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const updateUserOutputSchema = z.object({
  success: z.literal(true),
  user: userResponseSchema,
});

export const adjustBalanceOutputSchema = z.object({
  success: z.literal(true),
  balance: z.number(),
  tx: z.object({
    id: z.number().int(),
    amount: z.number(),
    type: z.literal("adjust"),
    note: z.string().nullable(),
    createdAt: z.string(), // ISO
  }),
});

export const inviteCodeResponseSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  status: z.enum(["active", "used", "expired"]),
  createdBy: z.number().int(),
  createdAt: z.string(),
  usedAt: z.string().nullable(),
  expiresAt: z.string(),
});

export const createInviteOutputSchema = z.object({
  success: z.literal(true),
  invite: inviteCodeResponseSchema,
});

export const listInvitesOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(inviteCodeResponseSchema),
});

// ============= 类型导出 =============

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;
export type AdjustBalanceInput = z.infer<typeof adjustBalanceInputSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;
export type InviteCodeResponse = z.infer<typeof inviteCodeResponseSchema>;
