// /v1/messages 统一入口端点选项（08-31-protocol-auto-detect，R1）：同一路径双协议自动感知。
// - openai 分支（base）：恒等转换（OpenAI Chat 形态即默认 /v1/chat/completions 语义），
//   providerType="openai"（原生 openai 上游优先），缓存键空前缀（与 chat 同语义请求共享缓存）。
// - anthropic 分支（protocolVariants）：= 现状 anthropicProxyOptions 语义（09-01-review：
//   spread 复用单一事实来源，消除字段复制漂移；inputSchema 不入变体——统一入口用统一 schema）。
// - 入站 schema 宽松（model + messages + stream，passthrough）：协议特定校验（如 anthropic 的
//   max_tokens 必填）后置到 toInternalSafe（400 语义与现状 zod 一致）。
import { z } from "zod";
import type { ProxyEndpointOptions } from "./proxy";
import { anthropicProxyOptions } from "../anthropic/options";

/** 统一入口宽松 schema：两协议共有字段（model + messages + stream），细节 passthrough
 * 由检测后各分支的转换层防御性处理。 */
export const unifiedMessagesInputSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
}).passthrough();

export type UnifiedMessagesInput = z.infer<typeof unifiedMessagesInputSchema>;

// inputSchema 不入变体（design §5：统一入口用统一 schema）；rest 恰好是变体需要的 7 个字段
const { inputSchema: _baseInputSchema, ...anthropicVariantFields } = anthropicProxyOptions;
void _baseInputSchema;

export const unifiedMessagesProxyOptions: ProxyEndpointOptions = {
  inputSchema: unifiedMessagesInputSchema,
  kind: "chat",
  // openai 分支（base）：恒等转换即 OpenAI 形态
  cachePrefix: "",
  providerType: "openai",
  protocolVariants: {
    protocol: "anthropic",
    // = 现状 anthropicProxyOptions 语义（toInternalSafe 含 max_tokens 必填检查、
    // 缓存前缀 "anthropic:"、provider 偏好 anthropic、R1 extras 透传、协议短路）
    ...anthropicVariantFields,
  },
};
