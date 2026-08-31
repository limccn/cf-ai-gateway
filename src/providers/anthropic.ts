// Anthropic 原生适配器（3.5）：OpenAI 格式请求 ↔ Anthropic Messages API。
// - buildRequest：分离 system、max_tokens（Anthropic 必需）、tools/tool_choice 映射
// - transformResponse：非流式 `{content:[{type:'text'|'tool_use'}]}` → OpenAI chat.completion
// - transformStreamToOpenAI：message_start/content_block_delta/message_delta/message_stop
//   等 SSE 事件 → OpenAI chat.completion.chunk 流（末尾合成 usage 尾包 + [DONE]）
import type {
  EndpointKind,
  InternalRequest,
  ProviderAdapter,
  ProviderConfig,
  TokenUsage,
  UpstreamRequest,
} from "./types";
import { AdapterError } from "./types";
import { parseOpenAiUsage } from "./openai";
import { applyHttpBody, buildUpstreamHeaders } from "./http-options";
import { resolveModelId } from "../lib/model-id";
import {
  pipeSseStream,
  type SseEvent,
  type SseFrameTransform,
} from "./sse-pipe";

const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
/** Anthropic 要求 max_tokens 必填；未提供时取此默认值（M4 起按模型默认配置）。 */
const DEFAULT_MAX_TOKENS = 4096;

type JsonObject = Record<string, unknown>;

// ============ 请求转换（OpenAI chat → Anthropic messages） ============

function buildRequest(
  req: InternalRequest,
  cfg: ProviderConfig,
): UpstreamRequest {
  if (req.kind !== "chat") {
    throw new AdapterError(
      `Anthropic adapter does not support endpoint kind '${req.kind}'`,
    );
  }
  // 上游模型名保留 `[1m]` 后缀（路由映射后缀感知，PRD R1.2）
  const upstreamModel = resolveModelId(cfg.models, req.model).upstream;
  const body = req.body;
  const messagesRaw = body["messages"];
  if (!Array.isArray(messagesRaw)) {
    throw new Error("Anthropic adapter: 'messages' must be an array");
  }

  const { system, messages } = convertMessages(messagesRaw);
  const tools = convertTools(body["tools"]);
  const toolChoice = convertToolChoice(body["tool_choice"], tools.length);

  const anthropicBody: JsonObject = {
    model: upstreamModel,
    max_tokens: pickMaxTokens(body),
    messages,
  };
  if (system.length > 0) {
    anthropicBody["system"] = system;
  }
  if (typeof body["temperature"] === "number") {
    anthropicBody["temperature"] = body["temperature"];
  }
  if (typeof body["top_p"] === "number") {
    anthropicBody["top_p"] = body["top_p"];
  }
  if (body["stop"] !== undefined) {
    anthropicBody["stop_sequences"] = normalizeStopSequences(body["stop"]);
  }
  if (tools.length > 0) {
    anthropicBody["tools"] = tools;
  }
  if (toolChoice) {
    anthropicBody["tool_choice"] = toolChoice;
  }
  if (req.stream) {
    anthropicBody["stream"] = true;
  }

  // baseUrl 两种配置风格均兼容：`https://api.anthropic.com` 或
  // `https://api.anthropic.com/v1`（与 OpenAI 系配置风格统一时以 /v1 结尾）
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  const messagesPath = baseUrl.endsWith("/v1")
    ? "/messages"
    : ANTHROPIC_MESSAGES_PATH;
  return {
    url: `${baseUrl}${messagesPath}`,
    init: {
      method: "POST",
      headers: buildUpstreamHeaders(
        {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        cfg,
      ),
      body: JSON.stringify(applyHttpBody(anthropicBody, cfg)),
    },
  };
}

function pickMaxTokens(body: JsonObject): number {
  const maxTokens = body["max_tokens"];
  const maxCompletion = body["max_completion_tokens"];
  if (typeof maxTokens === "number" && maxTokens > 0) {
    return Math.floor(maxTokens);
  }
  if (typeof maxCompletion === "number" && maxCompletion > 0) {
    return Math.floor(maxCompletion);
  }
  return DEFAULT_MAX_TOKENS;
}

function normalizeStopSequences(stop: unknown): string[] {
  if (typeof stop === "string") {
    return [stop];
  }
  if (Array.isArray(stop)) {
    return stop.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** OpenAI messages → Anthropic messages（分离 system；tool 角色 → tool_result）。 */
function convertMessages(messages: unknown[]): {
  system: string;
  messages: JsonObject[];
} {
  const systemParts: string[] = [];
  const converted: JsonObject[] = [];

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as JsonObject;
    const role = message["role"];
    if (role === "system") {
      const text = messageTextContent(message["content"]);
      if (text.length > 0) {
        systemParts.push(text);
      }
      continue;
    }
    if (role === "user") {
      converted.push({
        role: "user",
        content: convertUserContent(message["content"]),
      });
      continue;
    }
    if (role === "assistant") {
      converted.push(convertAssistantMessage(message));
      continue;
    }
    if (role === "tool") {
      converted.push(convertToolMessage(message));
      continue;
    }
    throw new AdapterError(`Unsupported message role '${String(role)}'`);
  }

  return { system: systemParts.join("\n\n"), messages: converted };
}

/** 纯文本内容抽取（system 消息用）。 */
function messageTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const p = part as JsonObject;
    if (p["type"] === "text" && typeof p["text"] === "string") {
      parts.push(p["text"]);
    }
  }
  return parts.join("\n");
}

/** user 消息内容 → Anthropic content blocks（文本 + data URL 图片）。 */
function convertUserContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const blocks: unknown[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const p = part as JsonObject;
    const type = p["type"];
    if (type === "text") {
      if (typeof p["text"] === "string") {
        blocks.push({ type: "text", text: p["text"] });
      }
    } else if (type === "input_text") {
      if (typeof p["text"] === "string") {
        blocks.push({ type: "text", text: p["text"] });
      }
    } else if (type === "image_url" || type === "input_image") {
      const image = p["image_url"];
      if (image && typeof image === "object") {
        const block = dataUrlToImageBlock((image as JsonObject)["url"]);
        if (block) {
          blocks.push(block);
        }
      }
    }
    // 其他 part 类型：跳过（Anthropic 不支持，网关不伪造）
  }
  return blocks;
}

/** `data:image/<ext>;base64,...` → Anthropic image block；非 data URL 返回 null（跳过）。 */
function dataUrlToImageBlock(url: unknown): JsonObject | null {
  if (typeof url !== "string" || !url.startsWith("data:")) {
    return null;
  }
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }
  const meta = url.slice(5, commaIndex);
  const data = url.slice(commaIndex + 1);
  const mediaType = meta.split(";")[0] ?? "image/png";
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

/** assistant 消息：文本 content + tool_calls → tool_use blocks。 */
function convertAssistantMessage(message: JsonObject): JsonObject {
  const blocks: unknown[] = [];
  const content = message["content"];
  if (typeof content === "string" && content.length > 0) {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const p = part as JsonObject;
      if (p["type"] === "text" && typeof p["text"] === "string") {
        blocks.push({ type: "text", text: p["text"] });
      }
    }
  }

  const toolCalls = message["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") {
        continue;
      }
      const call = rawCall as JsonObject;
      const fn = call["function"];
      const name = fn && typeof fn === "object"
        ? (fn as JsonObject)["name"]
        : undefined;
      const argumentsRaw = fn && typeof fn === "object"
        ? (fn as JsonObject)["arguments"]
        : undefined;
      if (typeof name === "string") {
        blocks.push({
          type: "tool_use",
          id: typeof call["id"] === "string" ? call["id"] : `toolu_${name}`,
          name,
          input: parseToolArguments(argumentsRaw),
        });
      }
    }
  }

  return { role: "assistant", content: blocks };
}

/** 工具调用 arguments（JSON 字符串）→ object；解析失败降级为空对象。 */
function parseToolArguments(argumentsRaw: unknown): JsonObject {
  if (typeof argumentsRaw !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(argumentsRaw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return {};
  } catch {
    return {};
  }
}

/** tool 角色消息 → user 消息 + tool_result block。 */
function convertToolMessage(message: JsonObject): JsonObject {
  const toolUseId = message["tool_call_id"];
  const content = message["content"];
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: typeof toolUseId === "string" ? toolUseId : "",
        content: typeof content === "string" ? content : JSON.stringify(content),
      },
    ],
  };
}

/** OpenAI tools → Anthropic tools（仅 function 类型）。 */
function convertTools(toolsRaw: unknown): JsonObject[] {
  if (!Array.isArray(toolsRaw)) {
    return [];
  }
  const tools: JsonObject[] = [];
  for (const raw of toolsRaw) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const tool = raw as JsonObject;
    if (tool["type"] !== "function") {
      continue;
    }
    const fn = tool["function"];
    if (!fn || typeof fn !== "object") {
      continue;
    }
    const f = fn as JsonObject;
    if (typeof f["name"] !== "string") {
      continue;
    }
    const parameters = f["parameters"];
    const inputSchema =
      parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? parameters
        : { type: "object", properties: {} };
    tools.push({
      name: f["name"],
      description: typeof f["description"] === "string" ? f["description"] : undefined,
      input_schema: inputSchema,
    });
  }
  return tools;
}

/** OpenAI tool_choice → Anthropic tool_choice（无工具时忽略）。 */
function convertToolChoice(toolChoice: unknown, toolCount: number): JsonObject | null {
  if (toolCount === 0) {
    return null;
  }
  if (typeof toolChoice === "string") {
    if (toolChoice === "none") {
      return { type: "none" };
    }
    if (toolChoice === "required") {
      return { type: "any" };
    }
    return { type: "auto" };
  }
  if (toolChoice && typeof toolChoice === "object") {
    const tc = toolChoice as JsonObject;
    if (tc["type"] === "function") {
      const fn = tc["function"];
      if (fn && typeof fn === "object") {
        const name = (fn as JsonObject)["name"];
        if (typeof name === "string") {
          return { type: "tool", name };
        }
      }
    }
    if (tc["type"] === "none") {
      return { type: "none" };
    }
  }
  return { type: "auto" };
}

// ============ 非流式响应转换（Anthropic message → OpenAI chat.completion） ============

/** stop_reason 映射（OpenAI finish_reason）。 */
function mapFinishReason(stopReason: unknown): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "refusal";
    default:
      return null;
  }
}

function transformResponse(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body;
  }
  const message = body as JsonObject;
  const contentRaw = message["content"];
  const content = Array.isArray(contentRaw) ? contentRaw : [];

  let text = "";
  const toolCalls: JsonObject[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const p = part as JsonObject;
    if (p["type"] === "text" && typeof p["text"] === "string") {
      text += p["text"];
    } else if (p["type"] === "tool_use") {
      toolCalls.push({
        id: typeof p["id"] === "string" ? p["id"] : "",
        type: "function",
        function: {
          name: typeof p["name"] === "string" ? p["name"] : "",
          arguments: JSON.stringify(p["input"] ?? {}),
        },
      });
    }
  }

  const msg: JsonObject = { role: "assistant", content: text };
  if (toolCalls.length > 0) {
    msg["tool_calls"] = toolCalls;
  }

  const usage = message["usage"];
  const promptTokens =
    usage && typeof usage === "object"
      ? (usage as JsonObject)["input_tokens"]
      : undefined;
  const completionTokens =
    usage && typeof usage === "object"
      ? (usage as JsonObject)["output_tokens"]
      : undefined;

  const result: JsonObject = {
    id: typeof message["id"] === "string" ? `chatcmpl-${message["id"]}` : "chatcmpl",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof message["model"] === "string" ? message["model"] : "",
    choices: [
      {
        index: 0,
        message: msg,
        finish_reason: mapFinishReason(message["stop_reason"]),
      },
    ],
  };
  if (typeof promptTokens === "number" && typeof completionTokens === "number") {
    result["usage"] = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }
  return result;
}

// ============ 流式转换（Anthropic SSE → OpenAI chunk SSE） ============

/**
 * Anthropic SSE 事件 → OpenAI chat.completion.chunk SSE 帧转换（统一 SsePipe 帧层，
 * 08-31-1102 R2.4：消除转换器自有 decode/parse）。
 * 事件映射：
 *   message_start          → 首 chunk（delta.role/content 占位）+ 记录 input_tokens
 *   content_block_start    → tool_use 块 → delta.tool_calls（含 name）
 *   content_block_delta    → text_delta → delta.content；input_json_delta → tool_calls.arguments
 *   message_delta          → finish_reason chunk + 记录 output_tokens
 *   message_stop           → usage 尾包 chunk + data: [DONE]
 *   error                  → OpenAI 风格 error data 块（尽力通知客户端）
 * 每次调用创建独立状态机（转换器可被代理管线在结算管线上消费同一批帧）。
 * 无 onError：上游读错误沿用旧行为（输出 error），由 pipe 默认处理。
 */
export function createStreamToOpenAITransform(): SseFrameTransform {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  let id = "chatcmpl";
  let model = "";
  let promptTokens: number | null = null;
  let cachedTokens: number | null = null;
  let completionTokens: number | null = null;
  let doneSent = false;

  function enqueue(
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: unknown,
  ): void {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  function baseChunk(choices: unknown): JsonObject {
    return { id, object: "chat.completion.chunk", created, model, choices };
  }

  /** 逐帧消费：false = 已终态（[DONE] 已发），停止投喂后续事件。 */
  function consume(
    event: SseEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    // [DONE] 已发送后忽略后续事件（message_stop/error 之后上游不应再有事件）
    if (doneSent) {
      return false;
    }
    const data = event.data;
    if (!data || typeof data !== "object") {
      return true; // ping / 空事件 / 非 JSON 帧（容错跳过，不打断流）
    }
    const obj = data as JsonObject;
    const type = obj["type"];

    if (event.event === "message_start" || type === "message_start") {
      const message = obj["message"];
      if (message && typeof message === "object") {
        const m = message as JsonObject;
        if (typeof m["id"] === "string") {
          id = `chatcmpl-${m["id"]}`;
        }
        if (typeof m["model"] === "string") {
          model = m["model"];
        }
        const usage = m["usage"];
        if (usage && typeof usage === "object") {
          const u = usage as JsonObject;
          const input = u["input_tokens"];
          if (typeof input === "number") {
            promptTokens = input;
          }
          // 缓存命中输入（流式在 message_start 上报 cache_read；写入量 cache_creation 留在输入内按普通计）
          const cached = u["cache_read_input_tokens"];
          if (typeof cached === "number") {
            cachedTokens = cached;
          }
        }
      }
      enqueue(controller, baseChunk(
        [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      ));
      return true;
    }

    if (event.event === "content_block_start" || type === "content_block_start") {
      const block = obj["content_block"];
      if (block && typeof block === "object") {
        const b = block as JsonObject;
        if (b["type"] === "tool_use" && typeof b["name"] === "string") {
          const index = typeof obj["index"] === "number" ? obj["index"] : 0;
          enqueue(controller, baseChunk(
            [{
              index,
              delta: {
                tool_calls: [{
                  index,
                  id: typeof b["id"] === "string" ? b["id"] : "",
                  type: "function",
                  function: { name: b["name"], arguments: "" },
                }],
              },
              finish_reason: null,
            }],
          ));
        }
      }
      return true;
    }

    if (event.event === "content_block_delta" || type === "content_block_delta") {
      const delta = obj["delta"];
      if (!delta || typeof delta !== "object") {
        return true;
      }
      const d = delta as JsonObject;
      const index = typeof obj["index"] === "number" ? obj["index"] : 0;
      if (d["type"] === "text_delta" && typeof d["text"] === "string") {
        enqueue(controller, baseChunk(
          [{ index, delta: { content: d["text"] }, finish_reason: null }],
        ));
      } else if (d["type"] === "input_json_delta" && typeof d["partial_json"] === "string") {
        enqueue(controller, baseChunk(
          [{
            index,
            delta: { tool_calls: [{ index, function: { arguments: d["partial_json"] } }] },
            finish_reason: null,
          }],
        ));
      }
      return true;
    }

    if (event.event === "message_delta" || type === "message_delta") {
      const delta = obj["delta"];
      const stopReason = delta && typeof delta === "object"
        ? (delta as JsonObject)["stop_reason"]
        : undefined;
      const usage = obj["usage"];
      if (usage && typeof usage === "object") {
        const output = (usage as JsonObject)["output_tokens"];
        if (typeof output === "number") {
          completionTokens = output;
        }
      }
      enqueue(controller, baseChunk(
        [{ index: 0, delta: {}, finish_reason: mapFinishReason(stopReason) }],
      ));
      return true;
    }

    if (event.event === "message_stop" || type === "message_stop") {
      const usageChunk: JsonObject = {
        id, object: "chat.completion.chunk", created, model, choices: [],
      };
      if (promptTokens !== null && completionTokens !== null) {
        usageChunk["usage"] = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          ...(cachedTokens !== null && cachedTokens > 0
            ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
            : {}),
        };
      }
      enqueue(controller, usageChunk);
      doneSent = true;
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return false; // 终态：停止投喂
    }

    if (event.event === "error" || type === "error") {
      const err = obj["error"];
      let message = "Upstream stream error";
      if (err && typeof err === "object") {
        const raw = (err as JsonObject)["message"];
        if (typeof raw === "string") {
          message = raw;
        }
      }
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`),
      );
      doneSent = true;
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return false; // 终态：停止投喂
    }

    // content_block_stop / ping 等：无输出
    return true;
  }

  return {
    consume,
    onEnd(controller) {
      // 上游正常结束但未到终态（如截断流）：补 [DONE]（旧语义）
      if (!doneSent) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    },
  };
}

/**
 * 上游 Anthropic SSE 字节流 → OpenAI chunk SSE（字节级包装，供适配器接口与
 * corner 路径使用；主路径由代理管线直接消费 createStreamToOpenAITransform 的帧）。
 */
export function transformStreamToOpenAI(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return pipeSseStream(body, { transform: createStreamToOpenAITransform() });
}

export const anthropicAdapter: ProviderAdapter = {
  type: "anthropic",

  supports(kind: EndpointKind): boolean {
    return kind === "chat";
  },

  buildRequest,

  transformResponse,

  parseUsage(body: unknown): TokenUsage | null {
    // Anthropic 非流式 usage 字段名不同，需单独提取
    if (!body || typeof body !== "object") {
      return null;
    }
    const usage = (body as JsonObject)["usage"];
    if (!usage || typeof usage !== "object") {
      return null;
    }
    const u = usage as JsonObject;
    const prompt = u["input_tokens"];
    const completion = u["output_tokens"];
    if (typeof prompt !== "number" || typeof completion !== "number") {
      return null;
    }
    // 缓存命中输入（cache_read）；cache_creation（缓存写入）留在 input_tokens 内按普通输入计费。
    const cachedRead = u["cache_read_input_tokens"];
    return {
      promptTokens: prompt,
      completionTokens: completion,
      cachedTokens:
        typeof cachedRead === "number" && Number.isFinite(cachedRead) && cachedRead > 0
          ? cachedRead
          : undefined,
    };
  },

  parseStreamUsage: parseOpenAiUsage, // 变换后的尾包已是 OpenAI 形态

  transformStreamToOpenAI,

  // R2.4：帧级转换器（代理管线在结算管线上消费同一批帧，消除重复编解码）
  createStreamToOpenAI: createStreamToOpenAITransform,
};
