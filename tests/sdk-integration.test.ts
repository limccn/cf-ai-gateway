// PART C1 集成验收：真实官方 SDK 客户端直连网关。
// 双 SDK（Anthropic TS SDK + OpenAI TS SDK）以 baseURL 指向网关虚构地址，
// vi.stubGlobal("fetch") 分流：127.0.0.1:1（mock provider 上游）→ canned chat 响应，
// 其余（gateway.test）→ 转发主 worker（selfFetch 等价路径）。
// 验证 SDK 生成的请求被网关接受、网关响应能被 SDK 原生解析（协议级兼容，AC6）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  applyMigrations,
  clearKv,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "sdk-model";
/** mock provider 的 baseUrl（setupProviderWithModel 固定值），stub 按此前缀回上游 mock。 */
const UPSTREAM_BASE = "http://127.0.0.1:1";
const GATEWAY = "http://gateway.test";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 拦截 fetch：上游前缀 → canned chat 响应；其余 → 转发主 worker（网关路径）。 */
function stubRouting(upstreamHandler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(UPSTREAM_BASE)) {
        return upstreamHandler(url, init ?? {});
      }
      // 网关请求（SDK baseURL 指向 gateway.test）→ 直接进 worker
      const app = exports.default as { fetch(request: Request): Promise<Response> };
      return app.fetch(new Request(url, init));
    }),
  );
}

/** 上游非流式 chat.completion（内部形态，usage 计价用）。 */
function chatCompletion(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-sdk",
      object: "chat.completion",
      created: 1_700_000_000,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi from upstream" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 上游流式 chat SSE（含 usage 尾包）。 */
function chatSse(overrides: string[] = []): string {
  const frames = [
    `data: {"id":"chatcmpl-sdk-stream","object":"chat.completion","created":1700000000,"model":"${MODEL}","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-sdk-stream","object":"chat.completion","created":1700000000,"model":"${MODEL}","choices":[{"index":0,"delta":{"content":"lo from stream"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-sdk-stream","object":"chat.completion","created":1700000000,"model":"${MODEL}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: {"id":"chatcmpl-sdk-stream","object":"chat.completion","created":1700000000,"model":"${MODEL}","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
    "data: [DONE]",
    ...overrides,
  ];
  return frames.join("\n\n") + "\n\n";
}

describe("Anthropic TS SDK 直连（baseURL=网关/anthropic）", () => {
  it("非流式 messages.create：SDK 原生解析 Message，x-api-key 鉴权，usage 计费", async () => {
    const userId = await setupUser("sdk-anthropic@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubRouting(() => chatCompletion());

    // Anthropic SDK 默认发 x-api-key + anthropic-version 头 → 验证 A3 回退鉴权
    const client = new Anthropic({ apiKey: plaintext, baseURL: `${GATEWAY}/anthropic` });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type === "text") {
      expect(msg.content[0].text).toContain("hi from upstream");
    }
    expect(msg.stop_reason).toBe("end_turn");
    // usage 换算：input_tokens ← prompt_tokens、output_tokens ← completion_tokens
    expect(msg.usage.input_tokens).toBe(10);
    expect(msg.usage.output_tokens).toBe(5);
    expect(msg.id).toMatch(/^msg_/);
  });

  it("流式 create({stream:true})：SDK 解析 message_start/delta/stop 完整事件序列", async () => {
    const userId = await setupUser("sdk-anthropic-stream@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubRouting(() => new Response(chatSse(), { headers: { "Content-Type": "text/event-stream" } }));

    const client = new Anthropic({ apiKey: plaintext, baseURL: `${GATEWAY}/anthropic` });
    // 0.120 流式 API：client.messages.stream() → MessageStream（async iterable）
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    });

    const seen = new Set<string>();
    let text = "";
    for await (const event of stream) {
      seen.add(event.type);
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
      }
    }
    // SDK 原生事件类型齐全（协议级兼容）
    expect(seen.has("message_start")).toBe(true);
    expect(seen.has("content_block_start")).toBe(true);
    expect(seen.has("content_block_delta")).toBe(true);
    expect(seen.has("content_block_stop")).toBe(true);
    expect(seen.has("message_delta")).toBe(true);
    expect(seen.has("message_stop")).toBe(true);
    expect(text).toContain("Hel");
    expect(text).toContain("lo from stream");
  });

  it("工具调用：上游 tool_calls → SDK 解析 tool_use block", async () => {
    const userId = await setupUser("sdk-anthropic-tools@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubRouting(() =>
      chatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"beijing"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const client = new Anthropic({ apiKey: plaintext, baseURL: `${GATEWAY}/anthropic` });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        { name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } },
      ],
    });

    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content.some((b) => b.type === "tool_use")).toBe(true);
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use") {
      expect(toolUse.name).toBe("get_weather");
      expect(toolUse.input).toEqual({ city: "beijing" });
    }
  });

  it("错误形态：错 key → SDK 抛 APIError(401)，error.type=authentication_error", async () => {
    const userId = await setupUser("sdk-anthropic-401@test.dev", 10);
    await setupKey(userId);
    stubRouting(() => chatCompletion());

    const client = new Anthropic({ apiKey: "sk-wrong-key", baseURL: `${GATEWAY}/anthropic` });
    await expect(
      client.messages.create({
        model: MODEL,
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({
      status: 401,
      // SDK 的 error 属性 = 整个响应体：顶层 type:"error" + error.type 分类
      error: { type: "error", error: { type: "authentication_error" } },
    });
  });
});

describe("OpenAI TS SDK 直连（baseURL=网关/v1）", () => {
  it("非流式 responses.create：SDK 原生解析 Response（status completed + output_text）", async () => {
    const userId = await setupUser("sdk-openai-resp@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubRouting(() => chatCompletion());

    const client = new OpenAI({ apiKey: plaintext, baseURL: `${GATEWAY}/v1` });
    const res = await client.responses.create({ model: MODEL, input: "hello" });

    expect(res.object).toBe("response");
    expect(res.id).toMatch(/^resp_/);
    expect(res.status).toBe("completed");
    expect(res.output_text).toContain("hi from upstream");
    expect(res.usage?.input_tokens).toBe(10);
    expect(res.usage?.output_tokens).toBe(5);
    expect(res.usage?.total_tokens).toBe(15);
  });

  it("流式 responses.create({stream:true})：SDK 解析 created/delta/completed 事件，无 [DONE] 兼容", async () => {
    const userId = await setupUser("sdk-openai-resp-stream@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubRouting(() => new Response(chatSse(), { headers: { "Content-Type": "text/event-stream" } }));

    const client = new OpenAI({ apiKey: plaintext, baseURL: `${GATEWAY}/v1` });
    const stream = await client.responses.create({
      model: MODEL,
      input: "hello",
      stream: true,
    });

    const seen = new Set<string>();
    let text = "";
    for await (const event of stream) {
      seen.add(event.type);
      if (event.type === "response.output_text.delta") {
        text += event.delta;
      }
    }
    // 官方事件序列齐全；SDK 以 response.completed 为终态（无 [DONE] 不报错即协议正确）
    expect(seen.has("response.created")).toBe(true);
    expect(seen.has("response.in_progress")).toBe(true);
    expect(seen.has("response.output_item.added")).toBe(true);
    expect(seen.has("response.content_part.added")).toBe(true);
    expect(seen.has("response.output_text.delta")).toBe(true);
    expect(seen.has("response.completed")).toBe(true);
    expect(text).toContain("lo from stream");
  });

  it("工具调用：responses.create 携带 function tools → 上游 tool_calls → function_call item", async () => {
    const userId = await setupUser("sdk-openai-resp-tools@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubRouting(() =>
      chatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_xyz",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"beijing"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const client = new OpenAI({ apiKey: plaintext, baseURL: `${GATEWAY}/v1` });
    const res = await client.responses.create({
      model: MODEL,
      input: "weather?",
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          strict: true,
        },
      ],
    });

    expect(res.status).toBe("completed");
    const call = res.output.find((item) => item.type === "function_call");
    expect(call).toBeDefined();
    if (call && call.type === "function_call") {
      expect(call.name).toBe("get_weather");
      expect(call.arguments).toBe('{"city":"beijing"}');
    }
  });

  it("chat.completions 不回归：SDK 原生解析非流式", async () => {
    const userId = await setupUser("sdk-openai-chat@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubRouting(() => chatCompletion());

    const client = new OpenAI({ apiKey: plaintext, baseURL: `${GATEWAY}/v1` });
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.id).toBe("chatcmpl-sdk");
    expect(res.choices[0]?.message?.content).toContain("hi from upstream");
  });

  it("错误形态：错 key → SDK 抛 APIError(401)", async () => {
    const userId = await setupUser("sdk-openai-401@test.dev", 10);
    await setupKey(userId);
    stubRouting(() => chatCompletion());

    const client = new OpenAI({ apiKey: "sk-wrong-key", baseURL: `${GATEWAY}/v1` });
    await expect(client.responses.create({ model: MODEL, input: "hi" })).rejects.toMatchObject({
      status: 401,
    });
  });
});
