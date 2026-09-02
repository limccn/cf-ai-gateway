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

/** 思考模式（R2 + H3/H6）：NULL ≡ 不映射（零变更契约，未配置不注入 thinking）；枚举校验拦非法值。 */
export const thinkingModeSchema = z
  .enum(["adaptive", "budget", "off"])
  .nullable();

/** reasoning 回传（Workstream B）：true → 保留 assistant.reasoning_content 给上游
 * （deepseek 思考模式要求回传）；false/省略 → 剥离（默认，上游零变化）。 */
export const reasoningRoundtripSchema = z.boolean();

/** 上游超时（毫秒，09-01-stg-glm-ccswitch-fix）：NULL ≡ 默认 60s。
 * 慢模型长生成（如 b.ai glm-5.3-flash）按 provider 调大，防 60s 默认超时切断。 */
export const upstreamTimeoutMsSchema = z
  .number()
  .int()
  .min(1_000)
  .max(600_000)
  .nullable();

/** Header 名：RFC 7230 token 字符集（防注入）。 */
const httpHeaderNameSchema = z
  .string()
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, {
    message: "Invalid HTTP header name",
  });

/** Header 值：禁 CR/LF（响应头注入防护），长度上限。 */
const httpHeaderValueSchema = z
  .string()
  .max(2000)
  .refine((v) => !v.includes("\r") && !v.includes("\n"), {
    message: "Header value must not contain CR/LF",
  });

/**
 * 高级 HTTP 选项（PRD R2）：覆盖 User-Agent、强制覆盖/新增 Header 与 body 字段。
 * headers 值可能含上游认证信息 → DB 中 AES-GCM 加密存储；API 响应值一律掩码。
 */
export const httpOptionsSchema = z
  .object({
    userAgent: z.string().max(500).optional(),
    headers: z.record(httpHeaderNameSchema, httpHeaderValueSchema).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createProviderInputSchema = z.object({
  name: z.string().min(1).max(100),
  type: providerTypeSchema,
  baseUrl: z.string().url().max(500),
  apiKey: z.string().min(1).max(1000),
  models: modelsMapSchema,
  enabled: z.boolean().default(true),
  weight: providerWeightSchema.default(1),
  httpOptions: httpOptionsSchema.optional(),
  thinkingMode: thinkingModeSchema.optional(),
  reasoningRoundtrip: reasoningRoundtripSchema.optional(),
  upstreamTimeoutMs: upstreamTimeoutMsSchema.optional(),
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
    // 更新时整体替换（省略保持原密文，与 apiKey 语义一致）
    httpOptions: httpOptionsSchema.optional(),
    // 显式传 null = 重置为不映射（H3；省略 = 不改动）
    thinkingMode: thinkingModeSchema.optional(),
    // 显式传 false = 关闭回传（省略 = 不改动）
    reasoningRoundtrip: reasoningRoundtripSchema.optional(),
    // 显式传 null = 重置为默认 60s（省略 = 不改动）
    upstreamTimeoutMs: upstreamTimeoutMsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  });

export const providerIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ============= 输出 Schemas =============

/** 响应形态：headers 值为掩码（`****abcd`），body 与 userAgent 明文。 */
export const httpOptionsResponseSchema = z.object({
  userAgent: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  body: z.record(z.string(), z.unknown()),
});

export const providerResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.enum(["openai", "anthropic"]),
  baseUrl: z.string(),
  apiKeyMasked: z.string(), // 如 `sk-****abcd`；明文永不下发
  models: z.record(z.string(), z.string()),
  weight: z.number().int().min(1).max(1000),
  enabled: z.boolean(),
  // 思考模式（R2）：null ≡ auto（adaptive 线优先）
  thinkingMode: z.enum(["adaptive", "budget", "off"]).nullable(),
  // reasoning 回传（Workstream B）：openai 面上游是否接收 assistant.reasoning_content
  reasoningRoundtrip: z.boolean(),
  // 上游超时（毫秒；null ≡ 默认 60s）
  upstreamTimeoutMs: z.number().int().min(1_000).max(600_000).nullable(),
  // 高级 HTTP 选项（headers 值掩码；未配置为空对象）
  httpOptions: httpOptionsResponseSchema,
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
export type ThinkingMode = z.infer<typeof thinkingModeSchema>;
export type CreateProviderInput = z.infer<typeof createProviderInputSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderInputSchema>;
export type ProviderResponse = z.infer<typeof providerResponseSchema>;
