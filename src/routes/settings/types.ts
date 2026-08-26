// 系统设置模块（M8 journal 延期项 2）：GET /api/admin/settings（admin 只读）。
// 返回当前生效的运行时默认配置（代码常量聚合；无运行时修改机制 → 只读，PATCH 不做，
// 已记录为已知偏差，见 README）。时间戳不涉及；数值字段均为整数。
import { z } from "zod";

// ============= 输出 Schemas =============

export const runtimeSettingsSchema = z.object({
  /** 响应缓存默认 TTL（秒），对应 api_keys.cache_ttl 的 schema 默认值。 */
  cacheTtlSeconds: z.number().int().positive(),
  /** 限流固定窗口长度（秒），对应 src/routes/v1/rate-limit.ts WINDOW_SECONDS。 */
  rateLimitWindowSeconds: z.number().int().positive(),
  /** request_logs 明细保留天数（REQUEST_LOG_RETENTION_DAYS env 覆盖，缺省 30）。 */
  requestLogRetentionDays: z.number().int().positive(),
});

export const settingsOutputSchema = z.object({
  success: z.literal(true),
  settings: runtimeSettingsSchema,
});

// ============= 类型导出 =============

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export type SettingsOutput = z.infer<typeof settingsOutputSchema>;
