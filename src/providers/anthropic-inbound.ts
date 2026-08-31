// Anthropic 入站协议适配（D2）：Anthropic Messages API ↔ 网关内部 OpenAI Chat Completions 形态。
// 方向与正向 anthropicAdapter 相反，不复用其内部函数（仅复用 stop_reason 映射表的逆向查表）：
// - buildInternalFromAnthropic：入站 Anthropic 请求 → 内部 OpenAI chat 形态（AB §3.1）
// - transformResponseToAnthropic：内部 chat 响应 → Anthropic message（AB §3.2）
// - transformStreamToAnthropic：上游 OpenAI chat SSE → Anthropic SSE（AB §3.3，R2.4 走统一帧层）
// 合成响应 id 统一用 msg_ 前缀（D11；流式/非流式共用同一生成器）。
// 信息损失点（P5，丢弃 + 告警日志）：top_k / metadata / thinking / service_tier / output_config；
// image source.url → 400 invalid_request_error（零 SSRF 面）。
import type { Logger } from "../lib/logger";
import { logger as moduleLogger } from "../lib/logger";
import { AdapterError } from "./types";
import {
  pipeSseStream,
  type SseEvent,
  type SseFrameTransform,
} from "./sse-pipe";

type JsonObject = Record<string, unknown>;

/** 合成 Anthropic message id（D11）：msg_ 前缀 + UUID 去连字符（Worker 环境 crypto 可用）。 */
function newAnthropicMessageId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** 丢弃字段告警（structured logger，snake_case；不落任何 token 值）。 */
function logDropped(logger: Logger, field: string): void {
  logger.warn("anthropic_field_dropped", { field });
}

// ============ 入站转换（Anthropic Messages → 内部 OpenAI Chat 形态） ============

/**
 * 入站 Anthropic Messages 请求 → 内部 OpenAI Chat Completions body（AB §3.1）。
 * 字段级转换失败抛 AdapterError（proxy 管道映射为 400；字段级错误形态由入站协议错误
 * 重写中间件改写为 Anthropic invalid_request_error）。
 * logger 可选（默认模块级 logger）：toInternal 注入点无请求上下文，仅用于丢弃告警。
 */
export function buildInternalFromAnthropic(
  body: JsonObject,
  logger: Logger = moduleLogger,
): JsonObject {
  const messages: JsonObject[] = [];
  // system（string | text blocks）→ 多条 system 消息合并到 messages 最前；非 text block 丢弃
  for (const text of systemParts(body["system"])) {
    messages.push({ role: "system", content: text });
  }

  const rawMessages = body["messages"];
  if (Array.isArray(rawMessages)) {
    for (const raw of rawMessages) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const message = raw as JsonObject;
      const role = message["role"];
      if (role === "system") {
        // 消息级 system（新模型 mid-conversation）：并入 system 消息序列
        const text = messageTextContent(message["content"]);
        if (text.length > 0) {
          messages.push({ role: "system", content: text });
        }
        continue;
      }
      if (role === "user") {
        pushUserMessage(messages, message, logger);
        continue;
      }
      if (role === "assistant") {
        pushAssistantMessage(messages, message, logger);
        continue;
      }
      throw new AdapterError(`Unsupported message role '${String(role)}'`);
    }
  }

  const internal: JsonObject = { model: body["model"], messages };
  if (typeof body["max_tokens"] === "number") {
    internal["max_tokens"] = body["max_tokens"];
  }
  if (typeof body["temperature"] === "number") {
    internal["temperature"] = body["temperature"];
  }
  if (typeof body["top_p"] === "number") {
    internal["top_p"] = body["top_p"];
  }
  const stop = normalizeStopSequences(body["stop_sequences"]);
  if (stop.length > 0) {
    internal["stop"] = stop;
  }
  const tools = buildTools(body["tools"]);
  if (tools.length > 0) {
    internal["tools"] = tools;
  }
  const toolChoice = buildToolChoice(body["tool_choice"], tools.length, logger);
  if (toolChoice !== null) {
    internal["tool_choice"] = toolChoice;
  }
  if (body["stream"] === true) {
    internal["stream"] = true;
  }

  // 丢弃 + 告警日志（P5：首版不支持的 Anthropic 平台专属字段）
  for (const field of ["top_k", "metadata", "thinking", "service_tier", "output_config"]) {
    if (body[field] !== undefined) {
      logDropped(logger, field);
    }
  }

  return internal;
}

/** system 字段 → 纯文本列表（string 或 text block 数组；非 text block 丢弃）。 */
function systemParts(system: unknown): string[] {
  if (typeof system === "string") {
    return system.length > 0 ? [system] : [];
  }
  if (!Array.isArray(system)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of system) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as JsonObject;
    if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].length > 0) {
      parts.push(b["text"]);
    }
    // 非 text block（image/document 等）：丢弃（AB §3.1 信息损失点）
  }
  return parts;
}

/** user 消息：text/image blocks → 一条 user 消息；tool_result blocks → 独立 tool 消息。 */
function pushUserMessage(
  messages: JsonObject[],
  message: JsonObject,
  _logger: Logger,
): void {
  const content = message["content"];
  if (typeof content === "string") {
    messages.push({ role: "user", content });
    return;
  }
  if (!Array.isArray(content)) {
    throw new AdapterError("User message content must be a string or an array of content blocks");
  }
  const parts: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as JsonObject;
    const type = b["type"];
    if (type === "text") {
      if (typeof b["text"] === "string") {
        parts.push({ type: "text", text: b["text"] });
      }
    } else if (type === "image") {
      const image = imageToImageUrl(b["source"]);
      if (image !== null) {
        parts.push(image);
      }
    } else if (type === "tool_result") {
      // tool_result → OpenAI tool 消息（tool_use_id 即 tool_call_id；is_error 无对应字段）
      messages.push({
        role: "tool",
        tool_call_id: typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : "",
        content: toolResultContent(b["content"]),
      });
    }
    // 其他 block 类型（document 等）：丢弃
  }
  if (parts.length > 0) {
    // tool 消息先行（紧随 assistant tool_calls），文本 parts 汇总为一条 user 消息
    messages.push({ role: "user", content: parts });
  }
}

/** Anthropic image block（base64 源）→ OpenAI image_url part；url 源 → 400（零 SSRF 面，P5）。 */
function imageToImageUrl(source: unknown): unknown | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const s = source as JsonObject;
  const type = s["type"];
  if (type === "base64") {
    const mediaType = typeof s["media_type"] === "string" ? s["media_type"] : "image/png";
    const data = s["data"];
    if (typeof data === "string") {
      return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
    }
    return null;
  }
  if (type === "url") {
    throw new AdapterError(
      "Image source type 'url' is not supported; please use a base64 data URL",
    );
  }
  return null;
}

/** tool_result content（string | blocks）→ OpenAI tool 消息 content（string）。 */
function toolResultContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as JsonObject;
        if (b["type"] === "text" && typeof b["text"] === "string") {
          textParts.push(b["text"]);
        }
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
    return JSON.stringify(content);
  }
  return JSON.stringify(content);
}

/** assistant 消息：text blocks → content；tool_use → tool_calls；thinking 丢弃 + 日志。 */
function pushAssistantMessage(
  messages: JsonObject[],
  message: JsonObject,
  logger: Logger,
): void {
  const content = message["content"];
  let text = "";
  const toolCalls: JsonObject[] = [];
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as JsonObject;
      const type = b["type"];
      if (type === "text" && typeof b["text"] === "string") {
        text += b["text"];
      } else if (type === "tool_use") {
        const name = b["name"];
        if (typeof name === "string") {
          toolCalls.push({
            id: typeof b["id"] === "string" ? b["id"] : `toolu_${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(b["input"] ?? {}) },
          });
        }
      } else if (type === "thinking") {
        logDropped(logger, "thinking");
      }
    }
  } else if (content !== undefined && content !== null) {
    throw new AdapterError("Assistant message content must be a string or an array of content blocks");
  }
  const out: JsonObject = { role: "assistant", content: text };
  if (toolCalls.length > 0) {
    out["tool_calls"] = toolCalls;
  }
  messages.push(out);
}

/** Anthropic tools（扁平）→ OpenAI tools（function 嵌套；parameters ← input_schema）。 */
function buildTools(toolsRaw: unknown): JsonObject[] {
  if (!Array.isArray(toolsRaw)) {
    return [];
  }
  const tools: JsonObject[] = [];
  for (const raw of toolsRaw) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const tool = raw as JsonObject;
    if (typeof tool["name"] !== "string") {
      continue;
    }
    const inputSchema = tool["input_schema"];
    const parameters =
      inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
        ? inputSchema
        : { type: "object", properties: {} };
    const fn: JsonObject = { name: tool["name"], parameters };
    if (typeof tool["description"] === "string") {
      fn["description"] = tool["description"];
    }
    tools.push({ type: "function", function: fn });
  }
  return tools;
}

/**
 * tool_choice 逆向映射 + D8 守卫：
 *   {type:"auto"} → "auto"；{type:"any"} → "required"（无工具时降级 "none" 防上游 400）；
 *   {type:"tool",name} → {type:"function",function:{name}}（无工具时 400）；
 *   {type:"none"} → "none"；其他形态降级 "auto"。未提供 → null（不输出）。
 */
function buildToolChoice(
  toolChoice: unknown,
  toolCount: number,
  logger: Logger,
): unknown {
  if (!toolChoice || typeof toolChoice !== "object") {
    return null;
  }
  const tc = toolChoice as JsonObject;
  const type = tc["type"];
  if (type === "auto") {
    return "auto";
  }
  if (type === "none") {
    return "none";
  }
  if (type === "any") {
    if (toolCount === 0) {
      // D8 守卫：OpenAI 上游 required + 无工具会 400 → 降级 none
      logger.warn("anthropic_tool_choice_downgraded", { from: "any", to: "none" });
      return "none";
    }
    return "required";
  }
  if (type === "tool") {
    const name = tc["name"];
    if (typeof name !== "string") {
      throw new AdapterError("tool_choice {type:'tool'} requires a 'name'");
    }
    if (toolCount === 0) {
      throw new AdapterError(
        "tool_choice {type:'tool'} requires tools to be provided in the request",
      );
    }
    return { type: "function", function: { name } };
  }
  // 其他形态：降级 auto + 告警
  logger.warn("anthropic_tool_choice_downgraded", { from: String(type), to: "auto" });
  return "auto";
}

/** stop_sequences → stop（透传；元素类型净化，非字符串过滤）。 */
function normalizeStopSequences(stop: unknown): string[] {
  if (typeof stop === "string") {
    return [stop];
  }
  if (Array.isArray(stop)) {
    return stop.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** 纯文本内容抽取（消息级 system 用）。 */
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

// ============ 非流式出站转换（内部 chat 响应 → Anthropic message） ============

/** OpenAI finish_reason → Anthropic stop_reason（AB §3.2 双射表；content_filter 保守映射 end_turn）。 */
function mapToAnthropicStopReason(finishReason: unknown): string {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** tool_calls[].function.arguments（JSON 字符串）→ tool_use input（object）；解析失败降级 {}。 */
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

/** OpenAI 形态 usage.prompt_tokens_details.cached_tokens → cache_read_input_tokens（缺失不伪造 0）。 */
function extractCachedTokens(usage: JsonObject): number | undefined {
  const details = usage["prompt_tokens_details"];
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const cached = (details as JsonObject)["cached_tokens"];
  return typeof cached === "number" && Number.isFinite(cached) && cached > 0
    ? cached
    : undefined;
}

/**
 * 内部/上游 OpenAI chat.completion 响应 → Anthropic message（AB §3.2）。
 * 仅取首 choice；usage 换算（input/output + cache_read 按上游实际值透传）。
 */
export function transformResponseToAnthropic(data: unknown): unknown {
  if (!data || typeof data !== "object") {
    return data;
  }
  const response = data as JsonObject;
  const choices = response["choices"];
  const choice =
    Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object"
      ? (choices[0] as JsonObject)
      : null;

  const content: unknown[] = [];
  const message = choice?.["message"];
  if (message && typeof message === "object") {
    const m = message as JsonObject;
    const text = m["content"];
    if (typeof text === "string" && text.length > 0) {
      content.push({ type: "text", text });
    }
    const refusal = m["refusal"];
    if (typeof refusal === "string" && refusal.length > 0) {
      content.push({ type: "text", text: refusal });
    }
    const toolCalls = m["tool_calls"];
    if (Array.isArray(toolCalls)) {
      for (const rawCall of toolCalls) {
        if (!rawCall || typeof rawCall !== "object") {
          continue;
        }
        const call = rawCall as JsonObject;
        const fn = call["function"];
        if (!fn || typeof fn !== "object") {
          continue;
        }
        const f = fn as JsonObject;
        if (typeof f["name"] !== "string") {
          continue;
        }
        content.push({
          type: "tool_use",
          id: typeof call["id"] === "string" ? call["id"] : "",
          name: f["name"],
          input: parseToolArguments(f["arguments"]),
        });
      }
    }
  }

  const result: JsonObject = {
    id: newAnthropicMessageId(),
    type: "message",
    role: "assistant",
    content,
    model: typeof response["model"] === "string" ? response["model"] : "",
    stop_reason: mapToAnthropicStopReason(choice?.["finish_reason"]),
    stop_sequence: null,
  };
  const usage = response["usage"];
  if (usage && typeof usage === "object") {
    const u = usage as JsonObject;
    const prompt = u["prompt_tokens"];
    const completion = u["completion_tokens"];
    if (typeof prompt === "number" && typeof completion === "number") {
      const anthropicUsage: JsonObject = {
        input_tokens: prompt,
        output_tokens: completion,
      };
      const cached = extractCachedTokens(u);
      if (cached !== undefined) {
        anthropicUsage["cache_read_input_tokens"] = cached;
      }
      result["usage"] = anthropicUsage;
    }
  }
  return result;
}

// ============ 流式出站转换（上游 OpenAI SSE → Anthropic SSE） ============

interface StreamBlockState {
  index: number;
  type: "text" | "tool_use";
  closed: boolean;
}

/**
 * 上游 OpenAI chat.completion.chunk SSE 事件 → Anthropic SSE 帧转换（AB §3.3 状态机，
 * R2.4 统一 SsePipe 帧层，消除转换器自有 decode/parse）。
 * 事件序列：message_start → content_block_start/delta/stop（text 与 tool_use 按块 index）→
 * message_delta（finish_reason 双射 + output_tokens=上游尾包值）→ message_stop；
 * 无 [DONE]（终事件即 message_stop）；流内错误 → error 事件注入并终止。
 * 帧格式：`event: <type>\ndata: <json>\n\n`（与 Anthropic 官方一致，客户端按 event 名区分）。
 * 每次调用创建独立状态机；consume 返回 false 后 pump 继续排空上游（结算需看到流结束）。
 */
export function createStreamToAnthropicTransform(): SseFrameTransform {
  const encoder = new TextEncoder();
  const messageId = newAnthropicMessageId();
  let model = "";
  let messageStartSent = false;
  let messageDeltaSent = false;
  let finished = false;
  let pendingStopReason: string | null = null;
  let outputTokens: number | null = null;
  const blocks: StreamBlockState[] = [];
  const toolBlocks = new Map<number, StreamBlockState>();
  let nextBlockIndex = 0;
  let currentTextBlock: StreamBlockState | null = null;
  let terminated = false;

  function enqueue(
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: string,
    payload: unknown,
  ): void {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
    );
  }

  function sendMessageStart(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    if (messageStartSent) {
      return;
    }
    messageStartSent = true;
    // 输入计数在 OpenAI 流起始不可知（D7）：input_tokens 置 0，output 计数在 message_delta 携带
    enqueue(controller, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        usage: { input_tokens: 0 },
      },
    });
  }

  function closeAllBlocks(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    for (const block of blocks) {
      if (!block.closed) {
        block.closed = true;
        enqueue(controller, "content_block_stop", {
          type: "content_block_stop",
          index: block.index,
        });
      }
    }
    currentTextBlock = null;
  }

  /** 关闭所有 content 块并发送 message_delta（幂等；stop_reason 缺失兜底 end_turn）。 */
  function maybeSendMessageDelta(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    if (messageDeltaSent || !messageStartSent) {
      return;
    }
    messageDeltaSent = true;
    closeAllBlocks(controller);
    enqueue(controller, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: pendingStopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens ?? 0 },
    });
  }

  function sendErrorEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: string,
  ): void {
    terminated = true;
    enqueue(controller, "error", {
      type: "error",
      error: { type: "api_error", message },
    });
  }

  function handleEvent(
    event: SseEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    const data = event.data;
    if (data === null) {
      // [DONE] / 空事件：终态（message_delta 兜底后 message_stop；无 [DONE] 输出）
      maybeSendMessageDelta(controller);
      if (messageStartSent) {
        enqueue(controller, "message_stop", { type: "message_stop" });
      }
      terminated = true;
      return;
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      return; // ping / 未知事件 / 非 JSON 帧（容错跳过，不打断流）
    }
    const obj = data as JsonObject;
    // 模型名取自首 chunk（上游模型名；message_start 快照使用）
    const chunkModel = obj["model"];
    if (typeof chunkModel === "string" && chunkModel.length > 0 && model.length === 0) {
      model = chunkModel;
    }
    // 流内错误通知（OpenAI 形态 {error:{message}}，正向适配器/透传的错误 data 块）
    const err = obj["error"];
    if (err && typeof err === "object") {
      const rawMessage = (err as JsonObject)["message"];
      sendErrorEvent(
        controller,
        typeof rawMessage === "string" ? rawMessage : "Upstream stream error",
      );
      return;
    }
    // usage 尾包（choices 空数组或合并进 finish chunk）：记录 output_tokens，触发 message_delta
    const usage = obj["usage"];
    if (usage && typeof usage === "object") {
      const output = (usage as JsonObject)["completion_tokens"];
      if (typeof output === "number") {
        outputTokens = output;
      }
      if (finished) {
        maybeSendMessageDelta(controller);
      }
    }

    const choices = obj["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      return; // usage 尾包已处理
    }
    const choice = choices[0];
    if (!choice || typeof choice !== "object") {
      return;
    }
    if (finished) {
      return; // finish 之后的 chunk（不应出现）防御性忽略
    }
    sendMessageStart(controller);

    const delta = (choice as JsonObject)["delta"];
    if (delta && typeof delta === "object") {
      const d = delta as JsonObject;
      const content = d["content"];
      if (typeof content === "string" && content.length > 0) {
        if (currentTextBlock === null) {
          currentTextBlock = { index: nextBlockIndex++, type: "text", closed: false };
          blocks.push(currentTextBlock);
          enqueue(controller, "content_block_start", {
            type: "content_block_start",
            index: currentTextBlock.index,
            content_block: { type: "text" },
          });
        }
        enqueue(controller, "content_block_delta", {
          type: "content_block_delta",
          index: currentTextBlock.index,
          delta: { type: "text_delta", text: content },
        });
      }
      const toolCallsRaw = d["tool_calls"];
      if (Array.isArray(toolCallsRaw)) {
        for (const rawCall of toolCallsRaw) {
          if (!rawCall || typeof rawCall !== "object") {
            continue;
          }
          const call = rawCall as JsonObject;
          const toolIndex = typeof call["index"] === "number" ? call["index"] : 0;
          const fn = call["function"];
          const fnObj = fn && typeof fn === "object" ? (fn as JsonObject) : null;
          const fnName = fnObj !== null && typeof fnObj["name"] === "string"
            ? fnObj["name"]
            : "";
          const fnArgs = fnObj !== null ? fnObj["arguments"] : undefined;

          let block = toolBlocks.get(toolIndex);
          if (block === undefined) {
            const id =
              typeof call["id"] === "string"
                ? call["id"]
                : fnName.length > 0
                  ? `toolu_${fnName}`
                  : "";
            block = { index: nextBlockIndex++, type: "tool_use", closed: false };
            blocks.push(block);
            toolBlocks.set(toolIndex, block);
            enqueue(controller, "content_block_start", {
              type: "content_block_start",
              index: block.index,
              content_block: { type: "tool_use", id, name: fnName },
            });
          }
          if (typeof fnArgs === "string" && fnArgs.length > 0) {
            // partial_json 逐段透传，客户端自行拼接解析（与官方 SDK 一致）
            enqueue(controller, "content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: fnArgs },
            });
          }
        }
      }
    }

    const finishReason = (choice as JsonObject)["finish_reason"];
    if (typeof finishReason === "string") {
      pendingStopReason = mapToAnthropicStopReason(finishReason);
      finished = true;
      closeAllBlocks(controller);
      // message_delta 延后到 usage 尾包（output_tokens 精确值）或 [DONE]（兜底 0）时再发：
      // OpenAI 流 finish chunk 之后必然跟 usage 尾包（或 [DONE]），此处立即发会拿到 0。
    }
  }

  return {
    consume(event, controller) {
      handleEvent(event, controller);
      return !terminated;
    },
    onError(error, controller) {
      const message =
        error instanceof Error ? error.message : "Upstream stream error";
      sendErrorEvent(controller, message); // 输出 error 事件后由 pipe 正常关闭（旧语义）
    },
    onEnd(controller) {
      // 上游正常结束（未到终态）：合成 data:null 终事件（message_delta 兜底 + message_stop）
      if (!terminated) {
        handleEvent({ event: "message", data: null }, controller);
      }
    },
  };
}

/**
 * 上游 OpenAI chat SSE 字节流 → Anthropic SSE（字节级包装，供 backward-compat；
 * 主路径由代理管线直接消费 createStreamToAnthropicTransform 的帧）。
 */
export function transformStreamToAnthropic(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return pipeSseStream(body, { transform: createStreamToAnthropicTransform() });
}
