// Anthropic 入站共享端点选项（D12）：/anthropic/v1/messages、/anthropic/messages、/v1/messages
// 三入口共用同一份 ProxyEndpointOptions（行为等价，R1）。toInternal 的 AdapterError 在此包装为
// HTTPException(400)（proxy 管道只在 adapter.buildRequest 处捕获 AdapterError；toInternal 在
// 管道外执行，onError 兜底会映射为 500，必须在此提前归一）。
import { HTTPException } from "hono/http-exception";
import type { ProxyEndpointOptions } from "../v1/proxy";
import { AdapterError } from "../../providers/types";
import {
  buildInternalFromAnthropic,
  transformResponseToAnthropic,
  transformStreamToAnthropic,
} from "../../providers/anthropic-inbound";
import { anthropicMessagesInputSchema } from "./types";

function toInternalSafe(body: Record<string, unknown>): Record<string, unknown> {
  try {
    return buildInternalFromAnthropic(body);
  } catch (error) {
    if (error instanceof AdapterError) {
      // 字段级转换失败 → 400（OpenAI 统一形态，由协议错误重写中间件改写为 Anthropic 形态）
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }
}

export const anthropicProxyOptions: ProxyEndpointOptions = {
  inputSchema: anthropicMessagesInputSchema,
  toInternal: toInternalSafe,
  transformResponse: transformResponseToAnthropic,
  transformStream: transformStreamToAnthropic,
  cachePrefix: "anthropic:",
  // 协议偏好：Anthropic 入站优先 type=anthropic 的 provider（上游原生 Anthropic 端点，
  // 如 DeepSeek /anthropic），仅配 openai provider 时回退转换转发（零回归）。
  providerType: "anthropic",
};
