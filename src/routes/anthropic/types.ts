// Anthropic 入站（/anthropic/* + /v1/messages）输入校验（D12 / AB §2.2）。
// 宽松 passthrough 风格（仿 src/routes/v1/types.ts）：仅校验顶层必填字段，
// 细节（content blocks / tools / tool_choice）由转换层防御性处理（buildInternalFromAnthropic）。
import { z } from "zod";

export const anthropicMessagesInputSchema = z.object({
  model: z.string().min(1),
  /** Anthropic 必填；缺失/非法由 zod 400（错误体经 error-adapt 改写为 Anthropic 形态）。 */
  max_tokens: z.number().int().positive(),
  /** 元素结构不校验（unknown），由转换层逐条防御性处理。 */
  messages: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
}).passthrough();

export type AnthropicMessagesInput = z.infer<typeof anthropicMessagesInputSchema>;
