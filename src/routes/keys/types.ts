// 密钥管理模块（M3 3.1）：Zod schema + 类型定义（api-patterns spec）。
// 时间戳一律 ISO 字符串（type-safety spec）。
import { z } from "zod";

// ============= 输入 Schemas =============

export const createKeyInputSchema = z.object({
  name: z.string().min(1).max(100),
  qpsLimit: z.number().int().min(1).max(100000).default(60),
  cacheEnabled: z.boolean().default(false),
  cacheTtl: z.number().int().min(1).max(86400).default(3600),
});

export const updateKeyInputSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    qpsLimit: z.number().int().min(1).max(100000).optional(),
    cacheEnabled: z.boolean().optional(),
    cacheTtl: z.number().int().min(1).max(86400).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  });

export const listKeysQuerySchema = z.object({
  // admin 可按用户过滤；member 忽略（强制自身）
  userId: z.coerce.number().int().positive().optional(),
  status: z.enum(["active", "revoked"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const keyIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ============= 输出 Schemas =============

export const keyResponseSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  name: z.string(),
  prefix: z.string(), // 已脱敏（prefix + ****）
  status: z.enum(["active", "revoked"]),
  qpsLimit: z.number().int(),
  cacheEnabled: z.boolean(),
  cacheTtl: z.number().int(),
  createdAt: z.string(),
});

export const createKeyOutputSchema = z.object({
  success: z.literal(true),
  key: keyResponseSchema,
  // 明文仅在本响应中出现一次；丢失后只能 revoke 重建
  plaintext: z.string(),
});

export const listKeysOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(keyResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const updateKeyOutputSchema = z.object({
  success: z.literal(true),
  key: keyResponseSchema,
});

export const revokeKeyOutputSchema = z.object({
  success: z.literal(true),
  key: keyResponseSchema,
});

// 无 deleteKeyOutputSchema：本模块**不提供删除**（2026-09-18 用户裁决，理由见 router.ts 文件头）。
// 原 delete 路由撤除后该 schema 已无引用，一并删除 —— 留着会让人以为「只是路由漏挂了」而把它补回来。

// ============= 类型导出 =============

export type CreateKeyInput = z.infer<typeof createKeyInputSchema>;
export type UpdateKeyInput = z.infer<typeof updateKeyInputSchema>;
export type ListKeysQuery = z.infer<typeof listKeysQuerySchema>;
export type KeyResponse = z.infer<typeof keyResponseSchema>;
