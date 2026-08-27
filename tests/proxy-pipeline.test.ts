// 代理面管道回归基线测试（PART A1）：mock openai 上游（vi.stubGlobal fetch），
// 覆盖 POST /v1/chat/completions 非流式/流式成功（含 usage 扣费）、401/404/429/402/502
// 错误路径、GET /v1/models，以及 A3 x-api-key 鉴权回退。
// 基线先行：作为 A2 proxyRoute 参数化「逐字节不变」的对照基准。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  clearKv,
  countTxByType,
  getBalance,
  latestLogStatus,
  selfFetch,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "gpt-4o-mini";
/** 测试价格（与 cache.test.ts 同口径）：输入 0.15/M、输出 0.6/M。 */
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  // 恢复真实 fetch，避免 stub 泄漏到其他用例（A2 参数化后行为不变的对照基准）
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

/** 上游非流式 chat.completion 响应（含 usage）。 */
const CHAT_RESPONSE = {
  id: "chatcmpl-baseline",
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

/** 预期费用 = 100×0.15 + 50×0.6 = 45 → /1e6 = 0.000045。 */
const EXPECTED_COST = (100 * INPUT_PRICE + 50 * OUTPUT_PRICE) / 1e6;

function chatBody(stream = false): string {
  return JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "hello" }],
    stream,
  });
}

async function postChat(plaintext: string, body?: string): Promise<Response> {
  return selfFetch("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
    body: body ?? chatBody(),
  });
}

describe("管道：/v1/chat/completions 非流式", () => {
  it("成功：透传上游响应、按 usage 扣费、明细记 success", async () => {
    const userId = await setupUser("pipeline-ok@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
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

    const res = await postChat(plaintext);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; choices: unknown[] };
    expect(json["id"]).toBe("chatcmpl-baseline");
    expect(json["choices"]).toHaveLength(1);

    // 上游请求形态：OpenAI 透传（模型名直通、body 原样、路径 /chat/completions）
    expect(capturedUrl).toMatch(/\/v1\/chat\/completions$/);
    const upstreamBody = JSON.parse(capturedBody) as { model: string };
    expect(upstreamBody["model"]).toBe(MODEL);

    // 计费：余额扣减 + usage 流水 + success 明细
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });

  it("404：模型不可路由 → 不转发、不扣费、明细记 rejected", async () => {
    const userId = await setupUser("pipeline-404@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    // 不注册该模型的 Provider
    const res = await postChat(
      plaintext,
      JSON.stringify({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toContain("no-such-model");
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("rejected");
  });

  it("402：余额不足 → 不转发、不扣费", async () => {
    const userId = await setupUser("pipeline-402@test.dev", 0);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);

    let upstreamCalled = false;
    stubUpstreamFetch(() => {
      upstreamCalled = true;
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    const res = await postChat(plaintext);
    expect(res.status).toBe(402);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBeTruthy();
    expect(upstreamCalled).toBe(false);
    expect(await countTxByType(userId, "usage")).toBe(0);
  });

  it("502：上游不可达 → 不扣费、明细记 error", async () => {
    const userId = await setupUser("pipeline-502@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // 不 stub fetch：走真实 fetch 到 127.0.0.1:1（不可达）
    const res = await postChat(plaintext);
    expect(res.status).toBe(502);
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("error");
  });
});

describe("管道：/v1/chat/completions 流式", () => {
  it("成功：SSE 透传 + 尾包 usage 结算扣费", async () => {
    const userId = await setupUser("pipeline-stream@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const sse =
      [
        'data: {"id":"chatcmpl-stream","object":"chat.completion","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-stream","object":"chat.completion","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-stream","object":"chat.completion","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: {"id":"chatcmpl-stream","object":"chat.completion","created":1700000000,"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postChat(plaintext, chatBody(true));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain('"delta":{"role":"assistant","content":"Hel"');
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}');

    // 尾包结算（流完整消费后 settle 回调已执行）
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });
});

describe("管道：鉴权与限流", () => {
  it("401：无 Key / 错误 Key", async () => {
    const userId = await setupUser("pipeline-401@test.dev", 10);
    await setupKey(userId);

    const noKey = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatBody(),
    });
    expect(noKey.status).toBe(401);
    const noKeyBody = (await noKey.json()) as { error?: { message?: string } };
    expect(noKeyBody["error"]?.["message"]).toBeTruthy();

    const badKey = await postChat("sk-wrong-key");
    expect(badKey.status).toBe(401);
    const badBody = (await badKey.json()) as { error?: { message?: string } };
    expect(badBody["error"]?.["message"]).toBeTruthy();
  });

  it("429：限流（qpsLimit=1，第二次请求超限）", async () => {
    const userId = await setupUser("pipeline-429@test.dev", 10);
    const { plaintext } = await setupKey(userId, { qpsLimit: 1 });
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubUpstreamFetch(() => new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 }));

    const first = await postChat(plaintext);
    expect(first.status).toBe(200);
    const second = await postChat(plaintext);
    expect(second.status).toBe(429);
    const json = (await second.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBeTruthy();
  });
});

describe("管道：GET /v1/models", () => {
  it("鉴权通过返回模型列表", async () => {
    const userId = await setupUser("pipeline-models@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);

    const res = await selfFetch("http://localhost/v1/models", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(json["object"]).toBe("list");
    expect(json["data"].some((m) => m["id"] === MODEL)).toBe(true);
  });
});

describe("管道：x-api-key 鉴权回退（A3）", () => {
  it("x-api-key 成功鉴权（Bearer 缺失时回退）", async () => {
    const userId = await setupUser("pipeline-xkey@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubUpstreamFetch(() => new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 }));

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": plaintext },
      body: chatBody(),
    });
    expect(res.status).toBe(200);
  });

  it("x-api-key 错误 → 401", async () => {
    const userId = await setupUser("pipeline-xkey-bad@test.dev", 10);
    await setupKey(userId);

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "sk-wrong-key" },
      body: chatBody(),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBeTruthy();
  });
});
