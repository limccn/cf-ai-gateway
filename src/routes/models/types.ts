// 价格表管理模块（M4 4.1，admin）：Zod schema + 类型定义。
// 单价单位：USD / 每百万 tokens（与 seed.sql 一致）；0 表示免费模型。
// 分层（M9）：未缓存输入 tokens > 128,000 时输入与输出均取 long 档，否则 short 档；缓存命中输入按 cached 计。
import { z } from "zod";

const priceField = z.number().min(0);

/** 模型级输出上限（tokens，09-01-stg-glm-ccswitch-fix）：NULL ≡ 不限制。
 * 请求 max_tokens 超上限时 proxy 层 clamp（防慢模型长生成撞上游超时）。 */
export const maxOutputTokensSchema = z.number().int().positive().nullable();

export const createModelInputSchema = z.object({
  model: z.string().min(1).max(200),
  inputPriceShort: priceField,
  inputPriceLong: priceField,
  inputPriceCached: priceField,
  outputPriceShort: priceField,
  outputPriceLong: priceField,
  maxOutputTokens: maxOutputTokensSchema.optional(),
});

export const updateModelInputSchema = z
  .object({
    inputPriceShort: priceField.optional(),
    inputPriceLong: priceField.optional(),
    inputPriceCached: priceField.optional(),
    outputPriceShort: priceField.optional(),
    outputPriceLong: priceField.optional(),
    // 显式传 null = 重置为不限制（省略 = 不改动）
    maxOutputTokens: maxOutputTokensSchema.optional(),
  })
  .refine(
    (v) =>
      v.inputPriceShort !== undefined ||
      v.inputPriceLong !== undefined ||
      v.inputPriceCached !== undefined ||
      v.outputPriceShort !== undefined ||
      v.outputPriceLong !== undefined ||
      v.maxOutputTokens !== undefined,
    { message: "At least one field is required" },
  );

export const modelIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ============= 输出 Schemas =============

export const modelResponseSchema = z.object({
  id: z.number().int(),
  model: z.string(),
  inputPriceShort: z.number(),
  inputPriceLong: z.number(),
  inputPriceCached: z.number(),
  outputPriceShort: z.number(),
  outputPriceLong: z.number(),
  // 模型级输出上限（null ≡ 不限制）
  maxOutputTokens: z.number().int().positive().nullable(),
  createdAt: z.string(), // ISO
  updatedAt: z.string(), // ISO
});

export const listModelsOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(modelResponseSchema),
  total: z.number().int(),
});

export const createModelOutputSchema = z.object({
  success: z.literal(true),
  model: modelResponseSchema,
});

export const updateModelOutputSchema = z.object({
  success: z.literal(true),
  model: modelResponseSchema,
});

export const deleteModelOutputSchema = z.object({
  success: z.literal(true),
});

// ============= 类型导出 =============

export type CreateModelInput = z.infer<typeof createModelInputSchema>;
export type UpdateModelInput = z.infer<typeof updateModelInputSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;
