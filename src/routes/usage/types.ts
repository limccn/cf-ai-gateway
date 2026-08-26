// 用量报表模块（M5 5.3）：Zod schema + 类型定义（api-module spec：集中式类型）。
// 约定：from/to 为 YYYY-MM-DD（含当日，UTC 日界，与 usage_daily.date 口径一致）；
// 时间戳统一 ISO 字符串（type-safety spec）；响应格式 { aggregates, details, total, limit, offset }（M6 前端消费）。
import { z } from "zod";

export const usageGroupBySchema = z.enum(["date", "model"]);

export const meUsageQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  keyId: z.coerce.number().int().positive().optional(),
  model: z.string().max(200).optional(),
  groupBy: usageGroupBySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminUsageQuerySchema = meUsageQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
});

// ============= 输出 Schemas =============

export const usageAggregateSchema = z.object({
  group: z.string().nullable(), // model 名 / YYYY-MM-DD；null = 未分组总览
  requests: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  cost: z.number(),
});

export const usageDetailSchema = z.object({
  id: z.number().int(),
  keyId: z.number().int().nullable(),
  model: z.string().nullable(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  cost: z.number(),
  latencyMs: z.number().int().nullable(),
  upstreamLatencyMs: z.number().int().nullable(),
  status: z.enum(["success", "error", "cached", "rejected"]),
  createdAt: z.string(), // ISO
});

export const usageOutputSchema = z.object({
  success: z.literal(true),
  aggregates: z.array(usageAggregateSchema),
  details: z.array(usageDetailSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

// ============= 类型导出 =============

export type UsageGroupBy = z.infer<typeof usageGroupBySchema>;
export type MeUsageQuery = z.infer<typeof meUsageQuerySchema>;
export type AdminUsageQuery = z.infer<typeof adminUsageQuerySchema>;
export type UsageAggregate = z.infer<typeof usageAggregateSchema>;
export type UsageDetail = z.infer<typeof usageDetailSchema>;
export type UsageOutput = z.infer<typeof usageOutputSchema>;
