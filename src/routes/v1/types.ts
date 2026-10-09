// 代理面（/v1/*）输入校验（M3 3.3）。OpenAI 兼容请求体：宽松校验顶层结构，
// 细节（消息/工具格式）由适配器负责转换；未知字段 passthrough 透传给上游。
import { z } from "zod";

/** chat.completions：messages 宽松数组（元素结构由 Anthropic 适配器防御性处理）。 */
export const chatCompletionsInputSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
}).passthrough();

export const completionsInputSchema = z.object({
  model: z.string().min(1),
  prompt: z.union([z.string(), z.array(z.string()).min(1)]),
  stream: z.boolean().optional(),
}).passthrough();

export const embeddingsInputSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1)]),
}).passthrough();

export type ChatCompletionsInput = z.infer<typeof chatCompletionsInputSchema>;
export type CompletionsInput = z.infer<typeof completionsInputSchema>;
export type EmbeddingsInput = z.infer<typeof embeddingsInputSchema>;
