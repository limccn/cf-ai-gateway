// Provider 管理模块（M3 3.2，admin）：Zod schema + 类型定义。
import { z } from "zod";

export const providerTypeSchema = z.enum(["openai", "anthropic"]);

/** models 路由映射：内部模型名 -> 上游模型名（JSON 落库）。 */
export const modelsMapSchema = z
  .record(z.string(), z.string())
  .refine((m) => Object.keys(m).length > 0, {
    message: "At least one model mapping is required",
  });

/** 负载均衡权重：多 provider 供同一模型时按比例分配（1-1000，默认 1 均分）。 */
export const providerWeightSchema = z.number().int().min(1).max(1000);

export const createProviderInputSchema = z.object({
  name: z.string().min(1).max(100),
  type: providerTypeSchema,
  baseUrl: z.string().url().max(500),
  apiKey: z.string().min(1).max(1000),
  models: modelsMapSchema,
  enabled: z.boolean().default(true),
  weight: providerWeightSchema.default(1),
});

export const updateProviderInputSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    type: providerTypeSchema.optional(),
    baseUrl: z.string().url().max(500).optional(),
    // 更新时若提供则重新加密；省略则保持原密文
    apiKey: z.string().min(1).max(1000).optional(),
    models: modelsMapSchema.optional(),
    enabled: z.boolean().optional(),
    weight: providerWeightSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  });

export const providerIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ============= 输出 Schemas =============

export const providerResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.enum(["openai", "anthropic"]),
  baseUrl: z.string(),
  apiKeyMasked: z.string(), // 如 `sk-****abcd`；明文永不下发
  models: z.record(z.string(), z.string()),
  weight: z.number().int().min(1).max(1000),
  enabled: z.boolean(),
  // 断路器状态（仅 list 返回）：provider 当前是否处于断路窗口（TTL 内跳过分配）
  circuitBroken: z.boolean().optional(),
  circuitReason: z.string().optional(),
  createdAt: z.string(),
});

export const createProviderOutputSchema = z.object({
  success: z.literal(true),
  provider: providerResponseSchema,
});

export const listProvidersOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(providerResponseSchema),
});

export const updateProviderOutputSchema = z.object({
  success: z.literal(true),
  provider: providerResponseSchema,
});

export const deleteProviderOutputSchema = z.object({
  success: z.literal(true),
});

// ============= 类型导出 =============

export type ProviderType = z.infer<typeof providerTypeSchema>;
export type CreateProviderInput = z.infer<typeof createProviderInputSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderInputSchema>;
export type ProviderResponse = z.infer<typeof providerResponseSchema>;
