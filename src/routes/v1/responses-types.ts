// Responses API 入站（POST /v1/responses）输入校验（D6 / OR §3.1）。
// 宽松 passthrough 风格（仿 src/routes/v1/types.ts）：仅校验顶层必填字段，
// 细节（input items / tools / tool_choice）由转换层防御性处理（buildInternalFromResponses）。
import { z } from "zod";

export const responsesInputSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string().min(1), z.array(z.unknown()).min(1)]),
  stream: z.boolean().optional(),
}).passthrough();

export type ResponsesInput = z.infer<typeof responsesInputSchema>;
