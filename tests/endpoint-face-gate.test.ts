// 流式直通门合取（批次 2，design §4.1）——入站面缺省支的判别测试。
// 生产四个入口（chat/completions/embeddings/responses/messages）现在全部声明 inboundFace，
// 「入站面缺省」只有未来调用方能触达：本文件用最小中间件链（requestContext + gatewayAuth +
// proxyRouteWithOptions）构造临时 app 复现该调用形态（error-adapt.test.ts 同款技法）。
//
// 判别设计：同一把 custom 行只声明 chat 面（policy 缺省 verbatim ⇒ streamPassthrough=true、
// openai 方言），上游恒吐 openai 分帧，options 带一个 anthropic 帧级转换器（streamConsumer）：
//   - inboundFace: "chat" → 门合取命中（方言 openai === 入站方言）→ 字节直通，streamConsumer
//     被跳过（原始 chat.completion.chunk 分帧 + [DONE] 原样透出）；
//   - inboundFace 缺省 → 门恒不命中（design §4.1：无面声明即无方言配对依据）→ 帧级转换链
//     （出站为 anthropic 事件形态 message_start…message_stop，无 [DONE]）。
// 两用例出站字节形态互斥：任何一支失效（门恒真 / 门恒假）都会让对方变红。
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { AppEnv } from "../src/types";
import { gatewayAuth } from "../src/middleware/gateway-auth";
import { requestContext } from "../src/middleware/request-context";
import { proxyRouteWithOptions } from "../src/routes/v1/proxy";
import { chatCompletionsInputSchema } from "../src/routes/v1/types";
import { createStreamToAnthropicTransform } from "../src/providers/anthropic-inbound";
import {
  applyMigrations,
  clearKv,
  setupKey,
  setupPrice,
  setupProvider,
  setupUser,
} from "./helpers";

const MODEL = "face-gate-model";
const CUSTOM_BASE = "http://face-gate-upstream.test/v1";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 临时 app：入站面可选的 chat 入口（streamConsumer 用 anthropic 帧级转换器，判别直通是否跳过它）。 */
function buildApp(inboundFace?: "chat"): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext());
  app.use("*", gatewayAuth());
  proxyRouteWithOptions(app, "/gate/chat/completions", {
    inputSchema: chatCompletionsInputSchema,
    kind: "chat",
    streamConsumer: createStreamToAnthropicTransform,
    ...(inboundFace !== undefined ? { inboundFace } : {}),
  });
  return app;
}

/** 无真 executionCtx 的替身（settle 旁路只吞 promise，本文件不断言计费）。 */
const execCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function postGate(plaintext: string, app: Hono<AppEnv>): Promise<Response> {
  return app.request(
    "http://localhost/gate/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    },
    env,
    execCtx,
  );
}

/** OpenAI chat 分帧上游响应（含 usage 尾包 + [DONE]）。 */
const OPENAI_SSE =
  [
    `data: {"id":"chatcmpl-gate","object":"chat.completion.chunk","created":1700000000,"model":"${MODEL}","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-gate","object":"chat.completion.chunk","created":1700000000,"model":"${MODEL}","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}`,
    `data: {"id":"chatcmpl-gate","object":"chat.completion.chunk","created":1700000000,"model":"${MODEL}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: {"id":"chatcmpl-gate","object":"chat.completion.chunk","created":1700000000,"model":"${MODEL}","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n";

describe("流式直通门合取（design §4.1）：入站面缺省 ⇒ 恒不直通", () => {
  it("inboundFace 缺省 + streamPassthrough=true 端点 → 不直通，帧级转换出 anthropic SSE", async () => {
    const userId = await setupUser("face-gate-noface@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProvider("face-gate-custom", MODEL, {
      type: "custom",
      baseUrl: CUSTOM_BASE,
      protocols: JSON.stringify({ chat: {} }),
    });
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(OPENAI_SSE, { headers: { "Content-Type": "text/event-stream" } })),
    );

    const res = await postGate(plaintext, buildApp(undefined));
    expect(res.status).toBe(200);
    const text = await res.text();
    // 判别点：出站经过帧级转换（anthropic 事件形态），而非原始 openai 分帧直通
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain('"object":"chat.completion.chunk"');
  });

  it("inboundFace='chat' + 同端点（verbatim ⇒ streamPassthrough=true）→ 门命中，字节直通", async () => {
    const userId = await setupUser("face-gate-chat@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProvider("face-gate-custom", MODEL, {
      type: "custom",
      baseUrl: CUSTOM_BASE,
      protocols: JSON.stringify({ chat: {} }),
    });
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(OPENAI_SSE, { headers: { "Content-Type": "text/event-stream" } })),
    );

    const res = await postGate(plaintext, buildApp("chat"));
    expect(res.status).toBe(200);
    const text = await res.text();
    // 判别点：streamConsumer 被直通跳过 —— 原始 openai 分帧（含 [DONE]）原样透出
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("event: message_start");
  });
});
