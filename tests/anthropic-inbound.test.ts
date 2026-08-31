// Anthropic 入站适配测试（R1-R10 / D1-D12）：纯函数转换单测 + 端到端（selfFetch）。
// 覆盖：buildInternalFromAnthropic（入站映射 + 守卫/拒绝）、transformResponseToAnthropic
// （非流式全字段）、transformStreamToAnthropic（逐事件序列）、三路径等价、
// x-api-key/Bearer 鉴权、错误重写（401/404/402/429/502/400）、openai 与 anthropic 两类上游、
// 流式结算、缓存（anthropic: 前缀隔离）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { AdapterError } from "../src/providers/types";
import {
  buildInternalFromAnthropic,
  transformResponseToAnthropic,
  transformStreamToAnthropic,
} from "../src/providers/anthropic-inbound";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { encryptSecret } from "../src/lib/security";
import { buildCacheKey, hashRequestBody } from "../src/lib/response-cache";
import {
  applyMigrations,
  clearKv,
  countTxByType,
  getBalance,
  latestLogStatus,
  selfFetch,
  settleDelayedBilling,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "gpt-4o-mini";
const ANTHROPIC_MODEL = "claude-sonnet-test";
/** 测试价格（与 proxy-pipeline.test.ts 同口径）：输入 0.15/M、输出 0.6/M。 */
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;
const EXPECTED_COST = (100 * INPUT_PRICE + 50 * OUTPUT_PRICE) / 1e6;

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

/** 注册 anthropic 类型 Provider（mock 上游；模型路由键与 openai mock 隔离）。 */
async function setupAnthropicProviderWithModel(model: string): Promise<number> {
  const db = createDb(env);
  const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, "mock-anthropic-provider"),
    columns: { id: true },
  });
  if (existing) {
    await db
      .update(providers)
      .set({
        type: "anthropic",
        baseUrl: "http://127.0.0.1:1",
        apiKeyEnc,
        models: JSON.stringify({ [model]: model }),
      })
      .where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(providers)
    .values({
      name: "mock-anthropic-provider",
      type: "anthropic",
      baseUrl: "http://127.0.0.1:1",
      apiKeyEnc,
      models: JSON.stringify({ [model]: model }),
    })
    .returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert anthropic test provider");
  }
  return row.id;
}

function anthropicBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 100,
    system: "Be brief.",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  });
}

async function postAnthropic(
  path: string,
  plaintext: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return selfFetch(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": plaintext,
      ...extraHeaders,
    },
    body: body ?? anthropicBody(),
  });
}

/** OpenAI chat.completion 上游响应（含 usage）。 */
const CHAT_RESPONSE = {
  id: "chatcmpl-anthropic-inbound",
  object: "chat.completion",
  created: 1_700_000_000,
  model: MODEL,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi there" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
};

/** Anthropic message 上游响应（正向适配器回译路径）。 */
const ANTHROPIC_UPSTREAM_RESPONSE = {
  id: "msg_01upstream",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi from claude" }],
  model: ANTHROPIC_MODEL,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50 },
};

/** 组装 SSE 字节流（OpenAI chat 形态，纯 data: 行 + [DONE]）。 */
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

/** 解析 Anthropic SSE 输出为 {event, data} 列表（断言用）。 */
function parseSseEvents(
  text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.trim().split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    events.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
  }
  return events;
}

// ============ 1. buildInternalFromAnthropic（入站 Anthropic → 内部 chat 形态） ============

describe("buildInternalFromAnthropic（入站映射）", () => {
  it("system string + user/assistant 消息 → 内部 chat body（model/max_tokens 直通）", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 100,
      system: "Be brief.",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
    expect(result).toEqual({
      model: MODEL,
      max_tokens: 100,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
  });

  it("system 多 block → 多条 system 消息合并到最前；非 text block 丢弃", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      system: [
        { type: "text", text: "A" },
        { type: "text", text: "B" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result["messages"]).toEqual([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hello" },
    ]);
  });

  it("user content blocks：text + base64 image → parts（data URL 形态）", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    });
    const userMsg = (result["messages"] as Array<Record<string, unknown>>).find(
      (m) => m["role"] === "user",
    );
    expect(userMsg?.["content"]).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
  });

  it("image source url → AdapterError（零 SSRF 面）", () => {
    expect(() =>
      buildInternalFromAnthropic({
        model: MODEL,
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "http://evil.example/x.png" } },
            ],
          },
        ],
      }),
    ).toThrow(AdapterError);
  });

  it("tool_result → tool 消息（tool_use_id 关联 tool_call_id）；无文本时不出 user 消息", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "42" }],
        },
      ],
    });
    expect(result["messages"]).toEqual([
      { role: "tool", tool_call_id: "toolu_01", content: "42" },
    ]);
  });

  it("assistant：text + tool_use → content + tool_calls；thinking 丢弃", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "sure" },
            { type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "shanghai" } },
            { type: "thinking", thinking: "internal chain" },
          ],
        },
      ],
    });
    expect(result["messages"]).toEqual([
      {
        role: "assistant",
        content: "sure",
        tool_calls: [
          {
            id: "toolu_01",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"shanghai"}' },
          },
        ],
      },
    ]);
  });

  it("tools（扁平）→ function 嵌套（input_schema → parameters）；description 保留", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "get_weather",
          description: "weather lookup",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(result["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "weather lookup",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
  });

  it("tool_choice 逆向：auto/any/none/{type:tool} → OpenAI 形态", () => {
    const tools = [{ name: "f", input_schema: { type: "object", properties: {} } }];
    const base = {
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools,
    };
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "auto" } })["tool_choice"]).toBe("auto");
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "any" } })["tool_choice"]).toBe("required");
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "none" } })["tool_choice"]).toBe("none");
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "tool", name: "f" } })["tool_choice"]).toEqual({
      type: "function",
      function: { name: "f" },
    });
  });

  it("D8 守卫：any 无 tools → 降级 none；{type:tool} 无 tools → AdapterError", () => {
    const base = {
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    };
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "any" } })["tool_choice"]).toBe("none");
    expect(() =>
      buildInternalFromAnthropic({ ...base, tool_choice: { type: "tool", name: "f" } }),
    ).toThrow(AdapterError);
  });

  it("stop_sequences → stop；temperature/top_p/stream 直通", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["END", "STOP"],
      temperature: 0.5,
      top_p: 0.9,
      stream: true,
    });
    expect(result["stop"]).toEqual(["END", "STOP"]);
    expect(result["temperature"]).toBe(0.5);
    expect(result["top_p"]).toBe(0.9);
    expect(result["stream"]).toBe(true);
  });

  it("平台专属字段（top_k/metadata/service_tier/output_config）丢弃，不进内部形态", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      top_k: 5,
      metadata: { user_id: "u1" },
      service_tier: "standard",
      output_config: { effort: "low" },
    });
    expect(result["top_k"]).toBeUndefined();
    expect(result["metadata"]).toBeUndefined();
    expect(result["service_tier"]).toBeUndefined();
    expect(result["output_config"]).toBeUndefined();
  });

  it("未知消息 role → AdapterError", () => {
    expect(() =>
      buildInternalFromAnthropic({
        model: MODEL,
        max_tokens: 10,
        messages: [{ role: "developer", content: "hi" }],
      }),
    ).toThrow(AdapterError);
  });
});

// ============ 2. transformResponseToAnthropic（内部 chat 响应 → Anthropic message） ============

describe("transformResponseToAnthropic（非流式出站）", () => {
  it("文本响应全字段：msg_ id / type / role / content / stop_reason / usage 换算", () => {
    const result = transformResponseToAnthropic(CHAT_RESPONSE) as Record<string, unknown>;
    expect(String(result["id"])).toMatch(/^msg_/);
    expect(result["type"]).toBe("message");
    expect(result["role"]).toBe("assistant");
    expect(result["content"]).toEqual([{ type: "text", text: "hi there" }]);
    expect(result["stop_reason"]).toBe("end_turn");
    expect(result["stop_sequence"]).toBeNull();
    expect(result["model"]).toBe(MODEL);
    expect(result["usage"]).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it("finish_reason → stop_reason 映射矩阵", () => {
    const base = { id: "x", object: "chat.completion", created: 1, model: MODEL, choices: [] };
    const cases: Array<[string | null, string]> = [
      ["stop", "end_turn"],
      ["tool_calls", "tool_use"],
      ["length", "max_tokens"],
      ["refusal", "refusal"],
      ["content_filter", "end_turn"],
      [null, "end_turn"],
    ];
    for (const [finish, expected] of cases) {
      const result = transformResponseToAnthropic({
        ...base,
        choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: finish }],
      }) as Record<string, unknown>;
      expect(result["stop_reason"]).toBe(expected);
    }
  });

  it("tool_calls → tool_use blocks（arguments JSON 解析为 input）", () => {
    const result = transformResponseToAnthropic({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "calling",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"shanghai"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) as Record<string, unknown>;
    expect(result["stop_reason"]).toBe("tool_use");
    expect(result["content"]).toEqual([
      { type: "text", text: "calling" },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "shanghai" } },
    ]);
  });

  it("arguments 非法 JSON → input 降级空对象；usage.cached_tokens → cache_read_input_tokens", () => {
    const result = transformResponseToAnthropic({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: "{broken" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    }) as Record<string, unknown>;
    const content = result["content"] as Array<Record<string, unknown>>;
    expect(content[0]?.["input"]).toEqual({});
    expect(result["usage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
    });
  });

  it("usage 缺失 → 不输出 usage（免计路径）", () => {
    const result = transformResponseToAnthropic({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    }) as Record<string, unknown>;
    expect(result["usage"]).toBeUndefined();
    expect(result["content"]).toEqual([]);
  });
});

// ============ 3. transformStreamToAnthropic（上游 OpenAI SSE → Anthropic SSE） ============

describe("transformStreamToAnthropic（流式出站）", () => {
  const CHUNK_BASE =
    '{"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini"';

  function openaiChunk(payload: string): string {
    return `data: ${CHUNK_BASE},"choices":${payload}}`;
  }

  it("文本流：message_start → content_block 系列 → message_delta（output_tokens 尾包值）→ message_stop；无 [DONE]", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
      openaiChunk('[]').replace('"choices":[]', '"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    expect(text).not.toContain("[DONE]");
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = events[0]?.data as Record<string, unknown>;
    const startMessage = start["message"] as Record<string, unknown>;
    expect(String(startMessage["id"])).toMatch(/^msg_/);
    expect(startMessage["type"]).toBe("message");
    expect(startMessage["role"]).toBe("assistant");
    expect(startMessage["content"]).toEqual([]);
    expect(startMessage["stop_reason"]).toBeNull();
    expect(startMessage["model"]).toBe("gpt-4o-mini");
    expect((startMessage["usage"] as Record<string, unknown>)["input_tokens"]).toBe(0);

    const blockStart = events[1]?.data as Record<string, unknown>;
    expect(blockStart["index"]).toBe(0);
    expect(blockStart["content_block"]).toEqual({ type: "text" });
    expect(events[2]?.data["delta"]).toEqual({ type: "text_delta", text: "Hel" });
    expect(events[3]?.data["delta"]).toEqual({ type: "text_delta", text: "lo" });
    expect(events[4]?.data["index"]).toBe(0);

    const delta = events[5]?.data as Record<string, unknown>;
    expect(delta["delta"]).toEqual({ stop_reason: "end_turn", stop_sequence: null });
    expect(delta["usage"]).toEqual({ output_tokens: 50 });
    expect(events[6]?.event).toBe("message_stop");
  });

  it("工具流：tool_use start（id/name）→ input_json_delta 逐段透传 → done；message_delta stop_reason=tool_use", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"sha"}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nghai\\"}"}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"tool_calls"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const blockStart = events[1]?.data as Record<string, unknown>;
    expect(blockStart["index"]).toBe(0);
    expect(blockStart["content_block"]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
    });
    expect(events[2]?.data["delta"]).toEqual({
      type: "input_json_delta",
      partial_json: '{"city":"sha',
    });
    expect(events[3]?.data["delta"]).toEqual({
      type: "input_json_delta",
      partial_json: 'nghai"}',
    });
    const delta = events[5]?.data as Record<string, unknown>;
    expect(delta["delta"]).toEqual({ stop_reason: "tool_use", stop_sequence: null });
  });

  it("无 usage 尾包：message_delta output_tokens 兜底 0", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    const delta = events.find((e) => e["event"] === "message_delta");
    expect((delta?.data["usage"] as Record<string, unknown>)["output_tokens"]).toBe(0);
  });

  it("流内错误：error 事件注入并终止（无 message_stop）", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]'),
      'data: {"error":{"message":"upstream broke"}}',
    ].join("\n\n") + "\n\n";
    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toContain("error");
    expect(events.map((e) => e["event"])).not.toContain("message_stop");
    const errorEvent = events.find((e) => e["event"] === "error");
    expect(errorEvent?.data["error"]).toEqual({ type: "api_error", message: "upstream broke" });
  });
});

// ============ 4. 端到端（selfFetch）：三路径 / 鉴权 / 错误重写 / 双上游 / 流式 / 缓存 ============

describe("端到端：三路径等价（openai 上游）", () => {
  it("/anthropic/v1/messages 与 /anthropic/messages 与 /v1/messages 均返回 Anthropic message 形态", async () => {
    const userId = await setupUser("anthro-paths@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedUrl = "";
    let capturedBody = "";
    stubUpstreamFetch((url, init) => {
      capturedUrl = url;
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const paths = ["/anthropic/v1/messages", "/anthropic/messages", "/v1/messages"];
    for (const path of paths) {
      const res = await postAnthropic(path, plaintext);
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        type: string;
        role: string;
        content: Array<{ type: string; text: string }>;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(json["type"]).toBe("message");
      expect(json["role"]).toBe("assistant");
      expect(json["content"]).toEqual([{ type: "text", text: "hi there" }]);
      expect(json["stop_reason"]).toBe("end_turn");
      expect(json["usage"]).toEqual({ input_tokens: 100, output_tokens: 50 });
    }

    // 入站翻译后的上游请求：system → 顶部 system 消息、max_tokens 直通、/chat/completions 路径
    expect(capturedUrl).toMatch(/\/v1\/chat\/completions$/);
    const upstreamBody = JSON.parse(capturedBody) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string }>;
    };
    expect(upstreamBody["model"]).toBe(MODEL);
    expect(upstreamBody["max_tokens"]).toBe(100);
    expect(upstreamBody["messages"]).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
    ]);

    // 延迟计费：三路径各发一次计费事件，响应路径 0 同步 D1 写
    expect(await latestLogStatus(userId)).toBeNull();

    // 消费者批内落账（usage 从上游 raw body 提取）：三路径各计费一次
    await settleDelayedBilling([
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - 3 * EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(3);
    expect(await latestLogStatus(userId)).toBe("success");
  });
});

describe("端到端：鉴权（x-api-key / Bearer）与错误重写", () => {
  it("x-api-key 与 Authorization: Bearer 均可鉴权", async () => {
    const userId = await setupUser("anthro-auth@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubUpstreamFetch(() => new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 }));

    const viaXKey = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(viaXKey.status).toBe(200);
    const viaBearer = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintext}`,
      },
      body: anthropicBody(),
    });
    expect(viaBearer.status).toBe(200);
  });

  it("错误 Key → Anthropic 形态 401（authentication_error）", async () => {
    const res = await postAnthropic("/anthropic/v1/messages", "sk-wrong-key");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("authentication_error");
  });

  it("/v1/messages 缺失 Key → 同样 Anthropic 形态 401（error-adapt 先于全局 gatewayAuth）", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: anthropicBody(),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("authentication_error");
  });

  it("404 模型不可路由 → Anthropic not_found_error", async () => {
    const userId = await setupUser("anthro-404@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({ model: "no-such-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type?: string; error?: { type?: string; message?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("not_found_error");
    expect(body["error"]?.["message"]).toContain("no-such-model");
    expect(await latestLogStatus(userId)).toBe("rejected");
  });

  it("402 余额不足 → Anthropic permission_error（保留 402 状态码）", async () => {
    const userId = await setupUser("anthro-402@test.dev", 0);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    const res = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("permission_error");
  });

  it("429 限流 → Anthropic rate_limit_error", async () => {
    const userId = await setupUser("anthro-429@test.dev", 10);
    const { plaintext } = await setupKey(userId, { qpsLimit: 1 });
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubUpstreamFetch(() => new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 }));

    const first = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(first.status).toBe(200);
    const second = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(second.status).toBe(429);
    const body = (await second.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("rate_limit_error");
  });

  it("502 上游不可达 → Anthropic api_error（不扣费，明细 error）", async () => {
    const userId = await setupUser("anthro-502@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const res = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("api_error");
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("error");
  });

  it("400 入站转换拒绝（image url source）→ Anthropic invalid_request_error", async () => {
    const userId = await setupUser("anthro-400@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({
        model: MODEL,
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "http://evil.example/x.png" } },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("invalid_request_error");
  });

  it("zod 400（缺失 max_tokens）→ Anthropic invalid_request_error", async () => {
    const userId = await setupUser("anthro-zod@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string; error?: { type?: string; message?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("invalid_request_error");
    expect(body["error"]?.["message"]).toContain("max_tokens");
  });
});

describe("端到端：anthropic 上游（正向适配器自洽闭环）", () => {
  it("非流式：上游 Anthropic message → 回译 Anthropic message（usage 换算入账）", async () => {
    const userId = await setupUser("anthro-upstream@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupAnthropicProviderWithModel(ANTHROPIC_MODEL);
    await setupPrice(ANTHROPIC_MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedUrl = "";
    stubUpstreamFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify(ANTHROPIC_UPSTREAM_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(res.status).toBe(200);
    // 上游地址为 Anthropic 形态（正向适配器构造 /v1/messages）
    expect(capturedUrl).toMatch(/\/v1\/messages$/);

    const json = (await res.json()) as {
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(json["type"]).toBe("message");
    expect(json["content"]).toEqual([{ type: "text", text: "hi from claude" }]);
    expect(json["stop_reason"]).toBe("end_turn");
    expect(json["usage"]).toEqual({ input_tokens: 100, output_tokens: 50 });

    // 延迟计费：消费者批内落账
    await settleDelayedBilling([
      { userId, keyId, providerId, model: ANTHROPIC_MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });

  it("流式：anthropic 上游 → P2a 协议短路（原样透传）+ Anthropic 提取器结算", async () => {
    const userId = await setupUser("anthro-upstream-stream@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupAnthropicProviderWithModel(ANTHROPIC_MODEL);
    await setupPrice(ANTHROPIC_MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const upstreamSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01s","type":"message","role":"assistant","content":[],"model":"claude-sonnet-test","stop_reason":null,"usage":{"input_tokens":100}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":50}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(upstreamSse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).not.toContain("[DONE]");
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const start = events[0]?.data["message"] as Record<string, unknown>;
    // P2a 短路：事件原样透传（id/usage 来自上游原值；旧行为为合成 msg_ id + input_tokens:0，
    // 见 design §3.3 兼容性变更 1）
    expect(String(start["id"])).toBe("msg_01s");
    expect((start["usage"] as Record<string, unknown>)["input_tokens"]).toBe(100);
    const delta = events[5]?.data as Record<string, unknown>;
    expect(delta["delta"]).toEqual({ stop_reason: "end_turn", stop_sequence: null });
    expect(delta["usage"]).toEqual({ output_tokens: 50 });

    // 结算：Anthropic 提取器（message_start 100 + message_delta 50 合成）→ 延迟计费消费者落账
    await settleDelayedBilling([
      { userId, keyId, providerId, model: ANTHROPIC_MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });
});

describe("端到端：openai 上游流式", () => {
  it("上游 OpenAI SSE → Anthropic SSE（message_start…message_stop）+ 尾包结算", async () => {
    const userId = await setupUser("anthro-openai-stream@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const sse = [
      'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      anthropicBodyWithStream(),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta","text":"Hel"');
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("[DONE]");

    // 延迟计费：消费者批内落账
    await settleDelayedBilling([
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });
});

describe("端到端：缓存（anthropic: 前缀隔离，R10/D9）", () => {
  it("预置缓存命中 → 返回 Anthropic 形态缓存体、不转发、不扣费", async () => {
    const userId = await setupUser("anthro-cache@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const body = {
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    };
    const bodyHash = await hashRequestBody(body);
    const cacheKey = buildCacheKey(keyId, MODEL, bodyHash, "anthropic:");
    const cachedPayload = {
      id: "msg_cached",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "cached anthropic reply" }],
      model: MODEL,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    await env.CACHE_KV.put(cacheKey, JSON.stringify(cachedPayload));

    let upstreamCalled = false;
    stubUpstreamFetch(() => {
      upstreamCalled = true;
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    const res = await postAnthropic("/anthropic/v1/messages", plaintext, JSON.stringify(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; content: Array<{ type: string; text: string }> };
    expect(json["id"]).toBe("msg_cached");
    expect(json["content"]).toEqual([{ type: "text", text: "cached anthropic reply" }]);
    expect(upstreamCalled).toBe(false);
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("cached");
  });
});

/** 流式 Anthropic 入站 body（model 用 openai 测试模型）。 */
function anthropicBodyWithStream(): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
}
