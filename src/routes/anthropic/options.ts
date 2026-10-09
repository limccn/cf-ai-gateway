// Anthropic 入站共享端点选项（D12）：/anthropic/v1/messages、/anthropic/messages、/v1/messages
// 三入口共用同一份 ProxyEndpointOptions（行为等价，R1）。toInternal 的 AdapterError 在此包装为
// HTTPException(400)（proxy 管道只在 adapter.buildRequest 处捕获 AdapterError；toInternal 在
// 管道外执行，onError 兜底会映射为 500，必须在此提前归一）。
import { HTTPException } from "hono/http-exception";
import type { ProxyEndpointOptions } from "../v1/proxy";
import { AdapterError } from "../../providers/types";
import {
  buildInternalFromAnthropic,
  createStreamToAnthropicTransform,
  transformResponseToAnthropic,
} from "../../providers/anthropic-inbound";
import { anthropicMessagesInputSchema } from "./types";

/** 入站 Anthropic → 内部形态（统一入口 /v1/messages 复用；/anthropic/* 同函数）。
 * 统一 schema 不强制 max_tokens（两协议共有、不作检测信号），anthropic 分支在此补必填检查
 * （400 语义与现状 zod 一致）；/anthropic/* 两端点 zod schema 已强制，此检查不重复生效（恒真）。 */
export function toInternalSafe(body: Record<string, unknown>): Record<string, unknown> {
  const maxTokens = body["max_tokens"];
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new HTTPException(400, {
      message: "max_tokens is required and must be a positive integer",
    });
  }
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
  // R2.4 帧级转换：OpenAI 上游时在结算管线上消费同一批帧（消除往返编解码）；
  // anthropic 上游时协议短路（messages 面的流式直通门，批次 2 起由
  // activeEndpoint.streamPassthrough × 入站方言合取判定），不经过本转换。
  streamConsumer: createStreamToAnthropicTransform,
  // R1：顶层 thinking/output_config 直通 anthropic 上游（Claude Code effort 恢复）；
  // OpenAI 上游路径由适配器层天然忽略（extras 不进内部 body，零泄漏）。
  passthroughAnthropicExtras: true,
  cachePrefix: "anthropic:",
  // 入站面（批次 2，design §4.1 面映射）：Anthropic Messages 入站 = "messages" 面 ——
  // 偏好趟按「面表原生承载 messages 面」匹配，遗留 anthropic 记录经其 messages 面
  // 命中（与旧 providerType:"anthropic" 偏好逐条等价），仅配 openai provider 时回退
  // 转换转发（零回归）；流式直通门据此判定端点方言 === anthropic（messages 原生方言）。
  inboundFace: "messages",
};
