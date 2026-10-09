// OpenAI Responses API 入站路由（R1/D1）：POST /v1/responses。
// 中间件链复用 proxyRouteWithOptions（gatewayAuth 已在 v1Router 全挂 /v1/*）；
// 不注册 error-adapt（D6：Responses 错误体即 OpenAI 通用风格 {error:{message}}，现有管道零改动）。
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ProxyEndpointOptions } from "./proxy";
import { AdapterError } from "../../providers/types";
import type { AppEnv } from "../../types";
import { logger as moduleLogger } from "../../lib/logger";
import {
  buildInternalFromResponses,
  createStreamToResponsesTransform,
  parseIncludeReasoning,
  transformResponseToResponses,
  transformStreamToResponses,
} from "../../providers/responses";
import { responsesInputSchema } from "./responses-types";

/** toInternal 的 AdapterError → HTTPException(400)（proxy 管道在候选循环的构造 try/catch 处
 * 捕获 AdapterError 归一 400——adapter.buildRequest 与 verbatimRequest 同一 catch；
 * toInternal 在该管道外执行，onError 兜底会映射为 500，必须在此提前归一）。 */
function toInternalSafe(body: Record<string, unknown>): Record<string, unknown> {
  try {
    return buildInternalFromResponses(body);
  } catch (error) {
    if (error instanceof AdapterError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }
}

/** 出站非流式：内部 model 名从入站原始 body 提取（D2；纯函数只收 data + model，便于单测）。
 * 注：`c.req.valid` 的 target 泛型依赖路由内 zValidator 注入的输入类型，此处 Context<AppEnv>
 * 上推导为 never，需窄化断言（valid("json") 在 proxyRouteWithOptions 处理器内已执行）。 */
function transformResponseWithModel(
  data: unknown,
  c: Context<AppEnv>,
): unknown {
  // 必须 bind：valid 是 HonoRequest 原型方法（依赖 this.#validatedData 私有字段），脱离实例调用会抛错
  const validJson = c.req.valid.bind(c.req) as (target: "json") => unknown;
  const raw = validJson("json") as Record<string, unknown> | undefined;
  const model = raw !== undefined && typeof raw["model"] === "string" ? raw["model"] : "";
  // R4：非流式 reasoning item 合成信号（include 白名单命中；与 buildInternalFromResponses 同源）
  const includeReasoning = parseIncludeReasoning(raw ?? {}, moduleLogger);
  return transformResponseToResponses(data, model, includeReasoning);
}

export const responsesProxyOptions: ProxyEndpointOptions = {
  inputSchema: responsesInputSchema,
  toInternal: toInternalSafe,
  transformResponse: transformResponseWithModel,
  // R2.4 帧级转换：OpenAI 上游时在结算管线上消费同一批帧（主路径）；
  // 保留字节级 transformStream 供 anthropic 上游 corner 使用（proxy 按上游类型分支）。
  // R4：工厂接收入站 rawBody（proxy 传参），解析 include 白名单信号后创建转换器
  streamConsumer: (body?: Record<string, unknown>) =>
    createStreamToResponsesTransform(parseIncludeReasoning(body ?? {}, moduleLogger)),
  transformStream: transformStreamToResponses,
  cachePrefix: "responses:",
  // 入站面（批次 2，design §4.1 面映射）：/v1/responses = "responses" 面 —— 偏好趟按
  // 「面表原生承载 responses 面」匹配（遗留 openai 记录经其 openai 方言 chat 面命中，
  // supportsProtocol 的 responses 等价支与旧 providerType:"openai" 偏好逐条等价）；
  // 仅配 anthropic provider 时回退转换转发（responses 角例字节链不变）。
  inboundFace: "responses",
};
