// 价格表管理模块（M4 4.1，admin）：Zod schema + 类型定义。
// 单价单位：USD / 每百万 tokens（与 seed.sql 一致）；0 表示免费模型。
import { z } from "zod";

export const createModelInputSchema = z.object({
  model: z.string().min(1).max(200),
  inputPrice: z.number().min(0),
  outputPrice: z.number().min(0),
});

export const updateModelInputSchema = z
  .object({
    inputPrice: z.number().min(0).optional(),
    outputPrice: z.number().min(0).optional(),
  })
  .refine((v) => v.inputPrice !== undefined || v.outputPrice !== undefined, {
    message: "At least one of inputPrice or outputPrice is required",
  });

export const modelIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ============= 输出 Schemas =============

export const modelResponseSchema = z.object({
  id: z.number().int(),
  model: z.string(),
  inputPrice: z.number(),
  outputPrice: z.number(),
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
