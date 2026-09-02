// R3a（09-01-stream-thinking-interop）：Anthropic 上游 thinking 块 → OpenAI reasoning_content 测试。
// 覆盖：转换器帧序列（thinking start/delta/stop/signature_delta/text/tool_use）、
// 块外 thinking_delta 防御忽略、无 thinking 流零回归、E2E（openai 入站 + anthropic 上游流式
// → 客户端收到 delta.reasoning_content）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { createStreamToOpenAITransform } from "../src/providers/anthropic";
import { pipeSseStream, type SseEvent } from "../src/providers/sse-pipe";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { encryptSecret } from "../src/lib/security";
import {
  applyMigrations,
  clearKv,
  selfFetch,
  setupKey,
  setupPrice,
  setupUser,
} from "./helpers";

const MODEL = "claude-r3a-test";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 用 canned 上游响应替换全局 fetch（miniflare 内主 worker 与测试同 isolate）。 */
function stubUpstreamFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init ?? {}),
    ),
  );
}

async function setupAnthropicProviderWithModel(model: string): Promise<number> {
  const db = createDb(env);
  const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, "mock-r3a-provider"),
    columns: { id: true },
  });
  const base = {
    type: "anthropic" as const,
    baseUrl: "http://127.0.0.1:1",
    apiKeyEnc,
    models: JSON.stringify({ [model]: model }),
  };
  if (existing) {
    await db.update(providers).set(base).where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(providers)
    .values({ name: "mock-r3a-provider", ...base })
    .returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert r3a test provider");
  }
  return row.id;
}

/** 帧序列 → 转换器输出 OpenAI chunk data 列表（跳过 [DONE]）。 */
async function transformEvents(
  events: SseEvent[],
): Promise<Array<Record<string, unknown>>> {
  const sseText = events
    .map((e) =>
      e.data === null
        ? "data: [DONE]\n\n"
        : `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
    )
    .join("");
  const stream = pipeSseStream(
    new Response(sseText).body as ReadableStream<Uint8Array>,
    { transform: createStreamToOpenAITransform() },
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  const chunks: Array<Record<string, unknown>> = [];
  for (const block of text.split("\n\n")) {
    if (!block.startsWith("data: ")) {
      continue;
    }
    const payload = block.slice(6);
    if (payload === "[DONE]") {
      continue;
    }
    chunks.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return chunks;
}

function sseEvent(event: string, data: Record<string, unknown>): SseEvent {
  return { event, data };
}

const MESSAGE_START = sseEvent("message_start", {
  type: "message_start",
  message: {
    id: "msg_r3a",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 25, output_tokens: 1 },
  },
});

/** thinking 块 + text 块 + tool_use 块完整流（mock-upstream 同构）。 */
const THINKING_EVENTS: SseEvent[] = [
  MESSAGE_START,
  sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
  sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason" } }),
  sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " about the plan" } }),
  sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_mock_01" } }),
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
  sseEvent("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  sseEvent("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello with thinking" } }),
  sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
  sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }),
  sseEvent("message_stop", { type: "message_stop" }),
];

// ============ 1. 转换器帧序列 ============

describe("createStreamToOpenAITransform（R3a thinking 块 → reasoning_content）", () => {
  it("thinking 块：thinking_delta → delta.reasoning_content（跨段拼接）；signature_delta 不输出", async () => {
    const chunks = await transformEvents(THINKING_EVENTS);
    const reasoningDeltas = chunks
      .filter((c) => {
        const choices = c["choices"] as Array<{ delta?: Record<string, unknown> }>;
        return choices[0]?.delta?.reasoning_content !== undefined;
      })
      .map((c) => {
        const choices = (c["choices"] as Array<Record<string, unknown>>) ?? [];
        const delta = (choices[0]?.["delta"] as Record<string, unknown>) ?? {};
        return String(delta["reasoning_content"] ?? "");
      });
    // 两段 thinking_delta 顺序输出，signature_delta 不产生 reasoning_content
    expect(reasoningDeltas).toEqual(["Let me reason", " about the plan"]);

    // 完整序列：首 chunk → thinking×2 → text → finish → usage 尾包
    const types = chunks.map((c) => {
      const choice = ((c["choices"] as Array<Record<string, unknown>>) ?? [])[0];
      const delta = (choice?.["delta"] as Record<string, unknown>) ?? {};
      if (choice === undefined) {
        return c["usage"] !== undefined ? "usage" : "other";
      }
      if (delta["reasoning_content"] !== undefined) return "reasoning";
      if (delta["role"] !== undefined) return "role"; // 首 chunk 同时带 role 与 content("")，role 优先
      if (delta["content"] !== undefined) return "text";
      if (choice["finish_reason"] !== null) return "finish";
      return "other";
    });
    expect(types).toEqual(["role", "reasoning", "reasoning", "text", "finish", "usage"]);
  });

  it("tool_use 块紧随 thinking 块：tool_calls 序列不受影响（零回归）", async () => {
    const events: SseEvent[] = [
      MESSAGE_START,
      sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "checking" } }),
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseEvent("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_r3a", name: "get_weather", input: {} } }),
      sseEvent("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"Bei' } }),
      sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }),
      sseEvent("message_stop", { type: "message_stop" }),
    ];
    const chunks = await transformEvents(events);
    const toolCallChunks = chunks.filter((c) => {
      const choices = c["choices"] as Array<{ delta?: { tool_calls?: unknown } }>;
      return choices[0]?.delta?.tool_calls !== undefined;
    });
    expect(toolCallChunks.length).toBe(2);
    const first = toolCallChunks[0] as { choices?: Array<Record<string, unknown>> } | undefined;
    const delta = (first?.choices?.[0]?.["delta"] as Record<string, unknown>) ?? {};
    const toolCalls = (delta["tool_calls"] as Array<Record<string, unknown>>) ?? [];
    const fn = (toolCalls[0]?.["function"] as Record<string, unknown>) ?? {};
    expect(fn["name"]).toBe("get_weather");
  });

  it("块外 thinking_delta（防御）→ 不输出", async () => {
    const events: SseEvent[] = [
      MESSAGE_START,
      // 无 content_block_start(thinking) 直接发 thinking_delta（异常上游）
      sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "stray" } }),
      sseEvent("message_stop", { type: "message_stop" }),
    ];
    const chunks = await transformEvents(events);
    const reasoningDeltas = chunks.filter((c) => {
      const choices = (c["choices"] as Array<Record<string, unknown>>) ?? [];
      const delta = (choices[0]?.["delta"] as Record<string, unknown>) ?? {};
      return delta["reasoning_content"] !== undefined;
    });
    expect(reasoningDeltas).toEqual([]);
  });

  it("无 thinking 流（纯文本）→ 与现状 chunk 序列逐字节一致（零回归）", async () => {
    const events: SseEvent[] = [
      MESSAGE_START,
      sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }),
      sseEvent("message_stop", { type: "message_stop" }),
    ];
    const chunks = await transformEvents(events);
    const types = chunks.map((c) => {
      const choice = ((c["choices"] as Array<Record<string, unknown>>) ?? [])[0];
      const delta = (choice?.["delta"] as Record<string, unknown>) ?? {};
      if (choice === undefined) return c["usage"] !== undefined ? "usage" : "other";
      if (delta["role"] !== undefined) return "role"; // 首 chunk 同时带 role 与 content("")，role 优先
      if (delta["content"] !== undefined) return "text";
      if (choice["finish_reason"] !== null) return "finish";
      return "other";
    });
    expect(types).toEqual(["role", "text", "finish", "usage"]);
  });
});

// ============ 2. E2E：openai 入站 + anthropic 上游流式 → reasoning_content ============

describe("端到端：/v1/chat/completions + anthropic 上游流式 thinking → reasoning_content", () => {
  it("客户端 SSE 收到 delta.reasoning_content（P2a 之外的正向转换路径）", async () => {
    const userId = await setupUser("r3a-e2e@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAnthropicProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // 上游返回 thinking 流（anthropic SSE）
    const upstreamSse = THINKING_EVENTS.map((e) =>
      e.data === null
        ? "data: [DONE]\n\n"
        : `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
    ).join("");
    stubUpstreamFetch((_url, _init) => {
      return new Response(upstreamSse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": plaintext },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"reasoning_content":"Let me reason"');
    expect(text).toContain('"reasoning_content":" about the plan"');
    // signature 不泄漏到 OpenAI 流
    expect(text).not.toContain("sig_mock_01");
    expect(text).toContain('"content":"Hello with thinking"');
    expect(text).toContain("data: [DONE]");
  });
});
