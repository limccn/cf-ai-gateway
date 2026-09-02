// R4（09-01-responses-reasoning-visibility）：Responses include 白名单 + reasoning 事件合成。
// 覆盖：include 白名单解析（buildInternalFromResponses 保留键 + 非白名单丢弃）、
// 流式 reasoning 事件序列（output_item.added → reasoning_summary_text.delta×N → done → output_item.done）、
// 缺省零回归（无 include → reasoning_content 不产生事件）、非流式 reasoning item 合成、
// E2E：/v1/responses include + stream → reasoning 事件出现；不带 include → 无；
// openai 适配器剥离 _gateway_ 保留键（不进上游 body）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildInternalFromResponses,
  createStreamToResponsesTransform,
  transformResponseToResponses,
} from "../src/providers/responses";
import { pipeSseStream } from "../src/providers/sse-pipe";
import {
  applyMigrations,
  clearKv,
  selfFetch,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "gpt-4o-mini-r4";
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

function responsesBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: MODEL, input: "hello", ...overrides });
}

async function postResponses(
  plaintext: string,
  body?: string,
): Promise<Response> {
  return selfFetch("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${plaintext}`,
    },
    body: body ?? responsesBody(),
  });
}

function sseStream(sse: string): ReadableStream<Uint8Array> {
  const body = new Response(sse).body;
  if (body === null) {
    throw new Error("test response body is null");
  }
  return body;
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
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
  return text;
}

function parseResponsesEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.trim().split("\n\n")) {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    events.push(JSON.parse(dataLines.join("\n")) as Record<string, unknown>);
  }
  return events;
}

/** OpenAI chat 流式 SSE（带 reasoning_content 段）：reasoning×2 → text → finish → usage → [DONE]。 */
const REASONING_SSE = [
  'data: {"id":"chatcmpl-r4","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini-r4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-r4","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini-r4","choices":[{"index":0,"delta":{"reasoning_content":"Let me reason"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-r4","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini-r4","choices":[{"index":0,"delta":{"reasoning_content":" about the plan"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-r4","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini-r4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-r4","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini-r4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"id":"chatcmpl-r4","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini-r4","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
  "data: [DONE]",
].join("\n\n") + "\n\n";

// ============ 1. include 白名单解析（buildInternalFromResponses） ============

describe("buildInternalFromResponses（R4 include 白名单）", () => {
  it("include: reasoning.summary_text / reasoning.raw → 保留键信号", () => {
    const body1 = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      include: ["reasoning.summary_text"],
    });
    expect(body1["_gateway_resp_include_reasoning"]).toBe(true);

    const body2 = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      include: ["reasoning.raw"],
    });
    expect(body2["_gateway_resp_include_reasoning"]).toBe(true);
  });

  it("白名单 + 非白名单混合：保留键置位（非白名单项丢弃不报错）", () => {
    const body = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      include: ["reasoning.summary_text", "output_annotation.text", "metadata"],
    });
    expect(body["_gateway_resp_include_reasoning"]).toBe(true);
    expect(body["include"]).toBeUndefined();
  });

  it("include 非数组（字符串/数字）→ 无保留键（零回归）", () => {
    const body1 = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      include: "reasoning.summary_text",
    });
    expect(body1["_gateway_resp_include_reasoning"]).toBeUndefined();

    const body2 = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      include: 42,
    });
    expect(body2["_gateway_resp_include_reasoning"]).toBeUndefined();
  });

  it("缺省（无 include）→ 无保留键（现状零回归）", () => {
    const body = buildInternalFromResponses({ model: MODEL, input: "hi" });
    expect(body["_gateway_resp_include_reasoning"]).toBeUndefined();
  });
});

// ============ 2. 流式 reasoning 事件序列（帧级转换器） ============

describe("createStreamToResponsesTransform（R4 reasoning 事件）", () => {
  async function run(includeReasoning: boolean): Promise<Array<Record<string, unknown>>> {
    const out = pipeSseStream(sseStream(REASONING_SSE), {
      transform: createStreamToResponsesTransform(includeReasoning),
    });
    return parseResponsesEvents(await streamToText(out));
  }

  it("include=true：output_item.added(reasoning) → delta×2 → done → output_item.done 完整序列", async () => {
    const events = await run(true);
    expect(events.map((e) => e["type"])).toEqual([
      "response.created",
      "response.in_progress",
      // reasoning 项建立 + 两段 delta（先于 message 建项——上游 reasoning 先于 content）
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      // finish → 关闭：reasoning 先关（outputIndex 0），message 后关
      "response.reasoning_summary_text.done",
      "response.output_item.done",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    // reasoning item 结构：summary 累积两段 delta 原文
    const reasoningAdded = events[2] as Record<string, unknown>;
    const reasoningItem = reasoningAdded["item"] as Record<string, unknown>;
    expect(reasoningItem["type"]).toBe("reasoning");
    expect(reasoningItem["summary"]).toEqual([]);
    const reasoningIndex = reasoningAdded["output_index"];

    const deltaEvents = [events[3], events[4]] as Array<Record<string, unknown>>;
    expect(deltaEvents.map((e) => e["delta"])).toEqual([
      "Let me reason",
      " about the plan",
    ]);
    expect(deltaEvents[0]?.["item_id"]).toBe(reasoningItem["id"]);
    expect(deltaEvents[0]?.["output_index"]).toBe(reasoningIndex);

    // done 事件携带完整累积文本
    const doneEvent = events[8] as Record<string, unknown>;
    expect(doneEvent["type"]).toBe("response.reasoning_summary_text.done");
    expect(doneEvent["text"]).toBe("Let me reason about the plan");
    expect(doneEvent["output_index"]).toBe(reasoningIndex);

    // output_item.done：reasoning 终态 item 含 summary
    const reasoningDoneEvent = events[9] as Record<string, unknown>;
    const doneItem = reasoningDoneEvent["item"] as Record<string, unknown>;
    expect(doneItem["type"]).toBe("reasoning");
    expect(doneItem["summary"]).toEqual([
      { type: "summary_text", text: "Let me reason about the plan" },
    ]);
    expect(doneItem["status"]).toBe("completed");

    // 终态 response 快照 output 含 reasoning 项
    const completed = events[13] as Record<string, unknown>;
    const snapshot = completed["response"] as Record<string, unknown>;
    const output = snapshot["output"] as Array<Record<string, unknown>>;
    expect(output[0]?.["type"]).toBe("reasoning");
    expect(output[1]?.["type"]).toBe("message");
    expect(snapshot["usage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
  });

  it("include=false（缺省）：reasoning_content 不产生任何事件（零回归）", async () => {
    const events = await run(false);
    const types = events.map((e) => e["type"]);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(
      events.some((e) => e["type"]?.toString().includes("reasoning")),
    ).toBe(false);
  });
});

// ============ 3. 非流式 reasoning item 合成 ============

describe("transformResponseToResponses（R4 非流式 reasoning item）", () => {
  const CHAT_WITH_REASONING = {
    id: "chatcmpl-r4ns",
    object: "chat.completion",
    created: 1_700_000_000,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "hi there",
          reasoning_content: "thought about it",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };

  it("include=true + 上游 reasoning_content → reasoning item 在 message 之前", () => {
    const result = transformResponseToResponses(CHAT_WITH_REASONING, MODEL, true) as {
      output: Array<Record<string, unknown>>;
    };
    expect(result["output"][0]?.["type"]).toBe("reasoning");
    expect(result["output"][0]?.["summary"]).toEqual([
      { type: "summary_text", text: "thought about it" },
    ]);
    expect(result["output"][0]?.["status"]).toBe("completed");
    expect(result["output"][1]?.["type"]).toBe("message");
    expect(result["output"][1]?.["content"]).toEqual([
      { type: "output_text", text: "hi there", annotations: [] },
    ]);
  });

  it("include=false：reasoning_content 不合成（零回归）", () => {
    const result = transformResponseToResponses(CHAT_WITH_REASONING, MODEL, false) as {
      output: Array<Record<string, unknown>>;
    };
    expect(result["output"].some((item) => item["type"] === "reasoning")).toBe(false);
    expect(result["output"].map((item) => item["type"])).toEqual(["message"]);
  });

  it("include=true 但上游无 reasoning_content → 无 reasoning item（空串/缺失均不合成）", () => {
    const noReasoning = {
      ...CHAT_WITH_REASONING,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "plain", reasoning_content: "" },
          finish_reason: "stop",
        },
      ],
    };
    const result = transformResponseToResponses(noReasoning, MODEL, true) as {
      output: Array<Record<string, unknown>>;
    };
    expect(result["output"].map((item) => item["type"])).toEqual(["message"]);
  });
});

// ============ 4. 端到端：/v1/responses include + 流式 ============

describe("端到端：/v1/responses include reasoning", () => {
  it("include: reasoning.summary_text + stream → 客户端收到 reasoning 事件；保留键不进上游 body", async () => {
    const userId = await setupUser("r4-e2e-stream@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(REASONING_SSE, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const res = await postResponses(
      plaintext,
      responsesBody({ stream: true, include: ["reasoning.summary_text"] }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseResponsesEvents(text);
    expect(
      events.filter((e) => e["type"] === "response.reasoning_summary_text.delta").length,
    ).toBe(2);
    expect(
      events.some((e) => e["type"] === "response.output_item.done" &&
        (e["item"] as Record<string, unknown>)?.["type"] === "reasoning"),
    ).toBe(true);

    // openai 适配器剥离 _gateway_ 保留键：上游 body 不含本地信号
    expect(capturedBody).not.toContain("_gateway_");
  });

  it("不带 include → 无 reasoning 事件（proxy 调用点零回归：工厂接 rawBody 后兼容缺省）", async () => {
    const userId = await setupUser("r4-e2e-noreason@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    stubUpstreamFetch(
      () => new Response(REASONING_SSE, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await postResponses(plaintext, responsesBody({ stream: true }));
    expect(res.status).toBe(200);
    const events = parseResponsesEvents(await res.text());
    expect(
      events.some((e) => e["type"]?.toString().includes("reasoning")),
    ).toBe(false);
    expect(events.map((e) => e["type"]).filter((t) => t === "response.completed").length).toBe(1);
  });

  it("include + 非流式：上游 message.reasoning_content → output reasoning item", async () => {
    const userId = await setupUser("r4-e2e-ns@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    stubUpstreamFetch((_url, _init) =>
      new Response(JSON.stringify({
        id: "chatcmpl-r4ns",
        object: "chat.completion",
        created: 1_700_000_000,
        model: MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "hi there",
              reasoning_content: "thought about it",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const res = await postResponses(
      plaintext,
      responsesBody({ include: ["reasoning.raw"] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: Array<Record<string, unknown>> };
    expect(body["output"][0]?.["type"]).toBe("reasoning");
    expect(body["output"][0]?.["summary"]).toEqual([
      { type: "summary_text", text: "thought about it" },
    ]);
    expect(body["output"][1]?.["type"]).toBe("message");
  });
});
