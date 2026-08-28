// 模型伪装 mapping 测试（08-27-disguised-mapping）：
// 别名映射（内部名 -> 上游名）下，响应侧所有输出位置的模型名回写为请求内部名。
// 覆盖：OpenAI 非流式/流式、Anthropic 正向（openai 请求 → anthropic 上游）、
// Anthropic 入站（anthropic 请求 → openai 上游）非流式/流式、/v1/models owned_by、
// 4xx 错误消息替换、流式 error 块替换、缓存命中伪装一致性。
// 关键设计点：mock 上游返回的 model 与映射值不同（如映射 deepseek-v4-pro 但上游
// 返回 deepseek-chat）→ 证明回写以请求名为准，与上游返回名无关。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { encryptSecret } from "../src/lib/security";
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

const MODEL = "claude-sonnet-5"; // 客户请求的内部模型名
const UPSTREAM_MODEL = "deepseek-v4-pro"; // 请求侧映射值（buildRequest 发出的名字）
const UPSTREAM_RETURNS = "deepseek-chat"; // 上游实际返回的名字（与映射值不同）
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

/**
 * 注册别名映射 provider（internal -> upstream；恒等由 helpers.setupProviderWithModel 覆盖）。
 * 默认固定 name（mock-alias-provider，与恒等 mock-provider 隔离）：update-if-exists 语义保证
 * 任意时刻最多一个 alias provider —— 多候选池（resolveCandidates 按 id 升序）因此唯一。
 * name/baseUrl 可覆盖（故障转移用例需要两个同模型键、不同上游地址的 provider）。
 */
async function setupAliasProvider(
  internal: string,
  upstream: string,
  type: "openai" | "anthropic" = "openai",
  name = "mock-alias-provider",
  baseUrlOverride?: string,
): Promise<number> {
  const db = createDb(env);
  const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
  const baseUrl =
    baseUrlOverride ?? (type === "openai" ? "http://127.0.0.1:1/v1" : "http://127.0.0.1:1");
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, name),
    columns: { id: true },
  });
  const values = {
    type,
    baseUrl,
    apiKeyEnc,
    models: JSON.stringify({ [internal]: upstream }),
  };
  if (existing) {
    await db.update(providers).set(values).where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(providers)
    .values({ name, ...values })
    .returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert alias test provider");
  }
  return row.id;
}

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

function anthropicBody(stream = false): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }],
    stream,
  });
}

async function postAnthropic(plaintext: string, body?: string): Promise<Response> {
  return selfFetch("http://localhost/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": plaintext },
    body: body ?? anthropicBody(),
  });
}

/** OpenAI chat.completion 上游响应（model 故意与映射值不同）。 */
function chatResponse(): Record<string, unknown> {
  return {
    id: "chatcmpl-disguise",
    object: "chat.completion",
    created: 1_700_000_000,
    model: UPSTREAM_RETURNS,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi there" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe("伪装：OpenAI 非流式", () => {
  it("T1 别名映射：响应 model 回写为请求名；请求侧仍发映射值；计费按内部名", async () => {
    const userId = await setupUser("disguise-ns@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(chatResponse()), { status: 200 });
    });

    const res = await postChat(plaintext);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string; choices: unknown[] };
    expect(json["model"]).toBe(MODEL); // 伪装：客户看到请求名
    expect(json["choices"]).toHaveLength(1);

    // 请求侧：upstream 收到的仍是映射值
    const upstreamBody = JSON.parse(capturedBody) as { model: string };
    expect(upstreamBody["model"]).toBe(UPSTREAM_MODEL);

    // 计费/日志按内部名（价格已按 MODEL 注册）
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });

  it("T9 缓存命中：首次与命中响应均为伪装名，命中不触发上游", async () => {
    const userId = await setupUser("disguise-cache@test.dev", 10);
    const { plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let upstreamCalls = 0;
    stubUpstreamFetch(() => {
      upstreamCalls += 1;
      return new Response(JSON.stringify(chatResponse()), { status: 200 });
    });

    const first = await postChat(plaintext);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { model: string })["model"]).toBe(MODEL);
    expect(upstreamCalls).toBe(1);

    const second = await postChat(plaintext);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { model: string })["model"]).toBe(MODEL);
    expect(upstreamCalls).toBe(1); // 缓存命中，未再转发
    expect(await latestLogStatus(userId)).toBe("cached");
  });
});

describe("伪装：OpenAI 流式", () => {
  it("T2 别名映射：每 chunk model 回写；[DONE] 与 usage 尾包正常；结算扣费", async () => {
    const userId = await setupUser("disguise-sse@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const chunk = (payload: string): string =>
      `data: {"id":"chatcmpl-disguise","object":"chat.completion.chunk","created":1700000000,"model":"${UPSTREAM_RETURNS}",${payload}}`;
    const sse =
      [
        chunk('"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]'),
        chunk('"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]'),
        chunk('"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]'),
        chunk('"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}'),
      ].join("\n\n") + "\n\ndata: [DONE]\n\n";
    stubUpstreamFetch(
      () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postChat(plaintext, chatBody(true));
    expect(res.status).toBe(200);

    const text = await res.text();
    // 所有 chunk 的 model 均回写为请求名
    const modelRefs = [...text.matchAll(/"model":"([^"]+)"/g)].map((m) => m[1]);
    expect(modelRefs.length).toBeGreaterThan(0);
    for (const name of modelRefs) {
      expect(name).toBe(MODEL);
    }
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}');

    // 流式结算正常（按内部名价格）
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });
});

describe("伪装：Anthropic 正向（OpenAI 请求 → anthropic 上游）", () => {
  it("T3 非流式：transformResponse 后的 model 回写为请求名", async () => {
    const userId = await setupUser("disguise-anth-fwd@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, "claude-sonnet-5-upstream", "anthropic");
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // Anthropic 上游 message 响应（model 与映射值不同）
    const upstreamBody = {
      id: "msg_01upstream",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi from claude" }],
      model: "claude-3-5-sonnet-latest",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    stubUpstreamFetch(
      () => new Response(JSON.stringify(upstreamBody), { status: 200 }),
    );

    const res = await postChat(plaintext);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string; object: string };
    expect(json["object"]).toBe("chat.completion");
    expect(json["model"]).toBe(MODEL); // 伪装
  });

  it("T3b 流式：Anthropic SSE 转换后每 chunk model 回写", async () => {
    const userId = await setupUser("disguise-anth-fwd-sse@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, "claude-sonnet-5-upstream", "anthropic");
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const frame = (event: string, payload: string): string =>
      `event: ${event}\ndata: ${payload}`;
    const sse =
      [
        frame('message_start', JSON.stringify({ type: "message_start", message: { id: "msg_01", type: "message", role: "assistant", content: [], model: "claude-3-5-sonnet-latest", stop_reason: null, usage: { input_tokens: 100 } } })),
        frame('content_block_start', JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })),
        frame('content_block_delta', JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } })),
        frame('content_block_delta', JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } })),
        frame('content_block_stop', JSON.stringify({ type: "content_block_stop", index: 0 })),
        frame('message_delta', JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } })),
        frame('message_stop', JSON.stringify({ type: "message_stop" })),
      ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postChat(plaintext, chatBody(true));
    expect(res.status).toBe(200);

    const text = await res.text();
    // OpenAI 出站 chunk：model 全部回写为请求名
    const modelRefs = [...text.matchAll(/"model":"([^"]+)"/g)].map((m) => m[1]);
    expect(modelRefs.length).toBeGreaterThan(0);
    for (const name of modelRefs) {
      expect(name).toBe(MODEL);
    }
    expect(text).toContain("data: [DONE]");

    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });
});

describe("伪装：Anthropic 入站（Anthropic 请求 → openai 上游）", () => {
  it("T4 非流式：message.model 回写为请求名", async () => {
    const userId = await setupUser("disguise-anth-in@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    stubUpstreamFetch(
      () => new Response(JSON.stringify(chatResponse()), { status: 200 }),
    );

    const res = await postAnthropic(plaintext);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: string; model: string };
    expect(json["type"]).toBe("message");
    expect(json["model"]).toBe(MODEL); // 伪装
  });

  it("T4b 流式：message_start.message.model 回写，其余事件不受影响", async () => {
    const userId = await setupUser("disguise-anth-in-sse@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const chunk = (payload: string): string =>
      `data: {"id":"chatcmpl-disguise","object":"chat.completion.chunk","created":1700000000,"model":"${UPSTREAM_RETURNS}",${payload}}`;
    const sse =
      [
        chunk('"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]'),
        chunk('"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]'),
        chunk('"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]'),
        chunk('"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}'),
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postAnthropic(plaintext, anthropicBody(true));
    expect(res.status).toBe(200);

    const text = await res.text();
    // message_start.message.model 伪装（data 为单行 JSON，贪婪匹配整行避免嵌套对象截断）
    const start = text.match(/event: message_start\r?\ndata: ({.+})/);
    expect(start).not.toBeNull();
    expect(JSON.parse(start?.[1] ?? "{}")["message"]?.["model"]).toBe(MODEL);
    // 其余事件不含 model 字段（不被伪造），content 流正常
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("text_delta");
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("data: [DONE]"); // Anthropic 出站无 [DONE]

    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });
});

describe("伪装：/v1/models 与错误消息", () => {
  it("T6 owned_by 统一为 gateway", async () => {
    const userId = await setupUser("disguise-models@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");
    await setupProviderWithModel("gpt-5.6-sol"); // 恒等映射模型也在列表内

    const res = await selfFetch("http://localhost/v1/models", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ id: string; owned_by: string }> };
    expect(json["data"].length).toBeGreaterThanOrEqual(2);
    for (const item of json["data"]) {
      expect(item["owned_by"]).toBe("gateway");
    }
  });

  it("T7 上游 400 错误消息中的上游模型名替换为请求名；状态码不变", async () => {
    const userId = await setupUser("disguise-4xx@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");

    stubUpstreamFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: `Model '${UPSTREAM_MODEL}' does not exist` },
          }),
          { status: 400 },
        ),
    );

    const res = await postChat(plaintext);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBe(`Model '${MODEL}' does not exist`);
    expect(await latestLogStatus(userId)).toBe("error");
  });

  it("T7b 上游 400 错误消息不含模型名：原样透传", async () => {
    const userId = await setupUser("disguise-4xx-plain@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");

    stubUpstreamFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "Invalid request body" } }), {
          status: 400,
        }),
    );

    const res = await postChat(plaintext);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBe("Invalid request body");
  });

  it("T8 流式 error 块：error.message 文本替换后流终止", async () => {
    const userId = await setupUser("disguise-sse-err@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAliasProvider(MODEL, UPSTREAM_MODEL, "openai");

    const sse =
      [
        `data: {"id":"chatcmpl-disguise","object":"chat.completion.chunk","created":1700000000,"model":"${UPSTREAM_RETURNS}","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}`,
        `data: {"error":{"message":"Upstream ${UPSTREAM_MODEL} overloaded"}}`,
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postChat(plaintext, chatBody(true));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(`Upstream ${MODEL} overloaded`);
    expect(text).not.toContain(UPSTREAM_MODEL);
    expect(text).toContain("data: [DONE]");
  });
});

describe("伪装：multi-upstream 故障转移错误消息（实际执行 provider 的映射值）", () => {
  // 专用模型键（仅本 describe 使用，避免与 mock-alias-provider 的 MODEL 候选池互相污染）。
  // 两个 provider 映射同一内部名、上游名不同（failover-400-model / failover-429-model）、
  // baseUrl 端口不同（fetch stub 按 URL 区分）—— 断言与 keyId 哈希选中顺序无关。
  const FAULT = "failover-req-model";
  const PROVIDER_400_NAME = "mock-alias-failover-400";
  const PROVIDER_429_NAME = "mock-alias-failover-429";

  async function setupFailoverProviders(): Promise<void> {
    await setupAliasProvider(
      FAULT, "failover-400-model", "openai",
      PROVIDER_400_NAME, "http://127.0.0.1:2/v1",
    );
    await setupAliasProvider(
      FAULT, "failover-429-model", "openai",
      PROVIDER_429_NAME, "http://127.0.0.1:3/v1",
    );
  }

  it("T10a 两候选均 429：lastError 用最后一次尝试 provider 的映射伪装", async () => {
    await clearKv(); // 清上次用例打开的断路器（provider id 跨用例复用）
    const userId = await setupUser("disguise-failover-429@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupFailoverProviders();

    stubUpstreamFetch((url) => {
      const modelName = url.includes("127.0.0.1:2")
        ? "failover-400-model"
        : "failover-429-model";
      return new Response(
        JSON.stringify({ error: { message: `Model '${modelName}' overloaded` } }),
        { status: 429 },
      );
    });

    const res = await postChat(
      plaintext,
      JSON.stringify({ model: FAULT, messages: [{ role: "user", content: "x" }] }),
    );
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error?: { message?: string } };
    // 最后一次尝试 provider 的消息被其自身映射替换；另一 provider 的名字不得泄漏
    expect(json["error"]?.["message"]).toBe(`Model '${FAULT}' overloaded`);
    expect(json["error"]?.["message"]).not.toContain("failover-400-model");
    expect(json["error"]?.["message"]).not.toContain("failover-429-model");
    expect(await latestLogStatus(userId)).toBe("error");
  });

  it("T10b 转移后非可重试 4xx：立即返回路径用当前候选 provider 的映射伪装", async () => {
    await clearKv();
    const userId = await setupUser("disguise-failover-400@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupFailoverProviders();

    stubUpstreamFetch((url) => {
      if (url.includes("127.0.0.1:2")) {
        // 非可重试 4xx：任一顺序下最终响应都来自该 provider（首候选直接返回 / 转移后返回）
        return new Response(
          JSON.stringify({ error: { message: "Model 'failover-400-model' does not exist" } }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "Model 'failover-429-model' unavailable" } }),
        { status: 429 },
      );
    });

    const res = await postChat(
      plaintext,
      JSON.stringify({ model: FAULT, messages: [{ role: "user", content: "x" }] }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBe(`Model '${FAULT}' does not exist`);
    expect(json["error"]?.["message"]).not.toContain("failover-429-model");
    expect(await latestLogStatus(userId)).toBe("error");
  });
});

describe("伪装：恒等映射零回归（model 字段与现状一致）", () => {
  it("T5 恒等映射：非流式响应 model 保持原值", async () => {
    const userId = await setupUser("disguise-identity@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel("gpt-5.6-sol");
    await setupPrice("gpt-5.6-sol", INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    stubUpstreamFetch(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-id",
            object: "chat.completion",
            created: 1_700_000_000,
            model: "gpt-5.6-sol",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
          { status: 200 },
        ),
    );

    const res = await postChat(
      plaintext,
      JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string };
    expect(json["model"]).toBe("gpt-5.6-sol");
  });
});
