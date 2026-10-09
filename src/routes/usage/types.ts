// 用量报表模块（M5 5.3）：Zod schema + 类型定义（api-module spec：集中式类型）。
// 约定：from/to 为 YYYY-MM-DD（含当日，UTC 日界，与 usage_daily.date 口径一致）；
// 时间戳统一 ISO 字符串（type-safety spec）；响应格式 { aggregates, details, total, limit, offset }（M6 前端消费）。
// range/tzOffsetMin（08-31-usage-stats-dimensions）：预设快捷窗口（今日/昨日/最近14天/最近30天，
// 含今日，本地时区日界），优先于 from/to（宽松处理不报错）；groupBy=model|status 在 range 窗口内
// 分组、date|hour|未传 仍走固定分桶（09-14 批次 A 收窄，原「range 忽略 groupBy」已不成立）；
// tzOffsetMin = 客户端时区偏移分钟（UTC+8 → 480，±840 校验，缺省 0 = UTC）。
import { z } from "zod";

export const usageGroupBySchema = z.enum(["date", "model", "hour", "status"]);

export const usageRangeSchema = z.enum(["today", "yesterday", "last14", "last30"]);

export const meUsageQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  range: usageRangeSchema.optional(),
  tzOffsetMin: z.coerce.number().int().min(-840).max(840).optional(),
  keyId: z.coerce.number().int().positive().optional(),
  model: z.string().max(200).optional(),
  status: z.enum(["success", "error", "cached", "rejected"]).optional(),
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

/** GET /api/me/usage/lifetime 的输出：账户累计消费（全时段，不分页、无筛选）。
 *  **刻意不并进 usageOutputSchema**：那份 schema 是 /api/me/usage 与 /api/admin/usage 的**共享契约**
 *  （dashboard、usage 页、既有单测与 stg E2E 都在消费它，见 app/modules/usage/hooks/use-usage-report.ts
 *  开头），改形状 = 全链路契约迁移；且 admin 端 userId 可缺省（那时求和的语义变成全员合计，与本端点
 *  的「单账户累计」根本不是一回事）。故独立端点、独立 schema。
 *  字段名沿用后端既有 `cost` 词汇（用户 2026-09-18 裁决：spend/cost 的用词统一只作用于**用户可见文案**，
 *  不动后端字段与表；面向用户的措辞在前端统一成 spend）。 */
export const lifetimeCostOutputSchema = z.object({
  success: z.literal(true),
  totalCost: z.number(),
});

// ============= 类型导出 =============

export type UsageGroupBy = z.infer<typeof usageGroupBySchema>;
export type UsageRange = z.infer<typeof usageRangeSchema>;
export type MeUsageQuery = z.infer<typeof meUsageQuerySchema>;
export type AdminUsageQuery = z.infer<typeof adminUsageQuerySchema>;
export type UsageAggregate = z.infer<typeof usageAggregateSchema>;
export type UsageDetail = z.infer<typeof usageDetailSchema>;
export type UsageOutput = z.infer<typeof usageOutputSchema>;
export type LifetimeCostOutput = z.infer<typeof lifetimeCostOutputSchema>;
