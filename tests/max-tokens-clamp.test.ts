// 09-01-stg-glm-ccswitch-fix：max_tokens clamp + 上游超时透传测试。
// 1) clampMaxTokens 纯函数（hit/miss/多键/无效 cap/零污染回归）；
// 2) proxy 集成：models.max_output_tokens 配置 → 上游收到 clamp 值 + warn 日志（非流式/流式）；
// 3) proxy 集成：providers.upstream_timeout_ms 配置 → fetchUpstream 收到透传的 timeoutMs。
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// fetchUpstream mock：proxy 的调用参数 (url, init, timeoutMs) 可捕获；返回 canned 响应。
vi.mock("../src/lib/upstream", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/upstream")>();
  return { ...mod, fetchUpstream: vi.fn() };
});
import { createDb } from "../src/db";
import { clampMaxTokens } from "../src/lib/max-tokens";
import { fetchUpstream } from "../src/lib/upstream";
import { models, providers } from "../src/db/schema";
import {
  applyMigrations,
  clearKv,
  selfFetch,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "gpt-4o-mini";

const CHAT_RESPONSE = {
  id: "chatcmpl-clamp",
  object: "chat.completion",
  created: 1_700_000_000,
  model: MODEL,
  choices: [
    { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const SSE_RESPONSE =
  'data: {"id":"chatcmpl-clamp-s","object":"chat.completion","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"chatcmpl-clamp-s","object":"chat.completion","created":1700000000,"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
  "data: [DONE]\n\n";

/** 捕获最近一次 fetchUpstream 调用的 (url, init, timeoutMs)。 */
function lastFetchCall(): { body: Record<string, unknown>; timeoutMs?: number } {
  const calls = vi.mocked(fetchUpstream).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const call = calls[calls.length - 1];
  if (call === undefined) {
    throw new Error("fetchUpstream never called");
  }
  const [, init, timeoutMs] = call;
  return { body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, timeoutMs };
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.mocked(fetchUpstream).mockClear();
  vi.restoreAllMocks();
});

// ============ 1. clampMaxTokens 纯函数 ============

describe("clampMaxTokens 纯函数", () => {
  it("hit：max_tokens 超上限 → clamp 且浅拷贝（原 body 不被污染）", () => {
    const body = { model: MODEL, max_tokens: 65536, stream: false };
    const result = clampMaxTokens(body, 16000);
    expect(result.clamped).toBe(true);
    expect(result.from).toBe(65536);
    expect(result.to).toBe(16000);
    expect(result.body).not.toBe(body);
    expect(result.body["max_tokens"]).toBe(16000);
    // 零污染回归：原 body 必须保持 65536（调用方在重试尝试间复用 internalReq）
    expect(body["max_tokens"]).toBe(65536);
    expect(body["model"]).toBe(MODEL);
  });

  it("miss：max_tokens 未超上限 → 同一引用、clamped=false", () => {
    const body = { model: MODEL, max_tokens: 100 };
    const result = clampMaxTokens(body, 16000);
    expect(result.clamped).toBe(false);
    expect(result.body).toBe(body);
  });

  it("缺省兜底（U6）：两键均缺失 → 按 cap 补齐（防 adapter 缺省注入超限）", () => {
    const body: Record<string, unknown> = { model: MODEL, messages: [] };
    const result = clampMaxTokens(body, 16000);
    expect(result.clamped).toBe(false);
    expect(result.defaulted).toBe(true);
    expect(result.body).not.toBe(body);
    expect(result.body["max_tokens"]).toBe(16000);
    // 零污染回归：原 body 保持无 max_tokens（调用方在重试尝试间复用 internalReq）
    expect(body["max_tokens"]).toBeUndefined();
  });

  it("缺省兜底：显式 null 视同缺失（adapter 按非数字跳过同样走缺省注入）", () => {
    const body = { model: MODEL, max_tokens: null };
    const result = clampMaxTokens(body, 16000);
    expect(result.defaulted).toBe(true);
    expect(result.body["max_tokens"]).toBe(16000);
  });

  it("仅 max_completion_tokens 缺失而 max_tokens 显式 → 不兜底（有显式即不 default）", () => {
    const body = { model: MODEL, max_tokens: 100 };
    const result = clampMaxTokens(body, 16000);
    expect(result.defaulted).toBe(false);
    expect(result.body).toBe(body);
  });

  it("非数值 max_tokens（字符串等）→ 不 clamp 不兜底（显式但无效，保持零回归）", () => {
    const body = { model: MODEL, max_tokens: "100" };
    expect(clampMaxTokens(body, 16000).clamped).toBe(false);
    expect(clampMaxTokens(body, 16000).defaulted).toBe(false);
    expect(clampMaxTokens(body, 16000).body).toBe(body);
  });

  it("Responses 形态：max_completion_tokens 超上限 → clamp", () => {
    const body = { model: MODEL, input: [], max_completion_tokens: 4000 };
    const result = clampMaxTokens(body, 2000);
    expect(result.clamped).toBe(true);
    expect(result.body["max_completion_tokens"]).toBe(2000);
    expect(body["max_completion_tokens"]).toBe(4000);
  });

  it("两键并存：各自 clamp，未超的键不产生拷贝副作用", () => {
    const body = { model: MODEL, max_tokens: 65536, max_completion_tokens: 100 };
    const result = clampMaxTokens(body, 16000);
    expect(result.clamped).toBe(true);
    expect(result.body["max_tokens"]).toBe(16000);
    expect(result.body["max_completion_tokens"]).toBe(100);
  });

  it("无效 cap（0/负数/NaN/非数值）→ 不动", () => {
    const body = { model: MODEL, max_tokens: 1000 };
    for (const cap of [0, -1, NaN, "16000", undefined]) {
      const result = clampMaxTokens(body, cap as number);
      expect(result.clamped).toBe(false);
      expect(result.body).toBe(body);
    }
  });
});

// ============ 2. proxy 集成：max_tokens clamp ============

describe("proxy：模型级 max_tokens 上限（models.max_output_tokens）", () => {
  async function setupWithCap(cap: number): Promise<{ plaintext: string }> {
    const userId = await setupUser(`clamp-${cap}-${crypto.randomUUID().slice(0, 8)}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, 0.15, 0.15, 0.04, 0.6, 0.6);
    const db = createDb(env);
    await db.update(models).set({ maxOutputTokens: cap }).where(eq(models.model, MODEL));
    // 清 cap KV TTL 缓存（效率项：cap 查询缓存 60s；每用例从 D1 读，模拟配置变更后的缓存边界，
    // 避免同 MODEL 用例间 KV 缓存残留互相污染——缓存命中语义由「缓存值 = DB 值」保证）
    await env.CACHE_KV.delete(`modelcap:${MODEL}`);
    return { plaintext };
  }

  function stubUpstream(): void {
    vi.mocked(fetchUpstream).mockImplementation(
      async (_url: string, init: RequestInit) => {
        const body = String(init.body ?? "");
        return body.includes('"stream":true')
          ? new Response(SSE_RESPONSE, { headers: { "Content-Type": "text/event-stream" } })
          : new Response(JSON.stringify(CHAT_RESPONSE), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
      },
    );
  }

  async function postChat(plaintext: string, body: unknown): Promise<Response> {
    return selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify(body),
    });
  }

  it("非流式：max_tokens 65536 超上限 16000 → 上游收到 clamp 值 + warn 日志", async () => {
    const { plaintext } = await setupWithCap(16000);
    stubUpstream();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await postChat(plaintext, {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 65536,
    });
    expect(res.status).toBe(200);

    const { body } = lastFetchCall();
    expect(body["max_tokens"]).toBe(16000);

    const warns = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { message: string; from?: number; to?: number })
      .filter((line) => line.message === "max_tokens_clamped");
    expect(warns.length).toBe(1);
    expect(warns[0]?.["from"]).toBe(65536);
    expect(warns[0]?.["to"]).toBe(16000);
  });

  it("流式：clamp 同样生效（buildRequest 前统一执行，与 stream 无关）", async () => {
    const { plaintext } = await setupWithCap(16000);
    stubUpstream();

    const res = await postChat(plaintext, {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 65536,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await res.text();

    const { body } = lastFetchCall();
    expect(body["max_tokens"]).toBe(16000);
  });

  it("未超上限 → 上游收到原值（无 clamp、无 warn）", async () => {
    const { plaintext } = await setupWithCap(16000);
    stubUpstream();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await postChat(plaintext, {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
    });
    expect(res.status).toBe(200);

    const { body } = lastFetchCall();
    expect(body["max_tokens"]).toBe(100);

    const warns = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { message: string })
      .filter((line) => line.message === "max_tokens_clamped");
    expect(warns.length).toBe(0);
  });

  it("价格表无该模型（cap 查询空行）→ 不限制（防御性兜底，原值透传）", async () => {
    const userId = await setupUser(`clamp-noprice-${crypto.randomUUID().slice(0, 8)}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    // 清掉前序用例残留的价格行（setupPrice 幂等 upsert 会留 cap 值）
    await createDb(env).delete(models).where(eq(models.model, MODEL));
    // 清掉 cap KV TTL 缓存（效率项：cap 查询 KV 缓存 60s；模拟缓存已过期 → 走 D1 空行）
    await env.CACHE_KV.delete(`modelcap:${MODEL}`);
    stubUpstream();

    const res = await postChat(plaintext, {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 65536,
    });
    expect(res.status).toBe(200);

    const { body } = lastFetchCall();
    expect(body["max_tokens"]).toBe(65536);
  });

  it("U6 缺省兜底端到端：客户端省略 max_tokens → 上游收到 cap 值 + defaulted warn", async () => {
    const { plaintext } = await setupWithCap(16000);
    stubUpstream();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await postChat(plaintext, {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.status).toBe(200);

    const { body } = lastFetchCall();
    expect(body["max_tokens"]).toBe(16000);

    const defaults = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { message: string; to?: number })
      .filter((line) => line.message === "max_tokens_defaulted");
    expect(defaults.length).toBe(1);
    expect(defaults[0]?.["to"]).toBe(16000);
  });
});

// ============ 3. proxy 集成：上游超时透传 ============

describe("proxy：provider 级上游超时（providers.upstream_timeout_ms）", () => {
  it("配置 120000 → fetchUpstream 收到第三个参数 120000", async () => {
    const userId = await setupUser(`timeout-${crypto.randomUUID().slice(0, 8)}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, 0.15, 0.15, 0.04, 0.6, 0.6);
    const db = createDb(env);
    await db
      .update(providers)
      .set({ upstreamTimeoutMs: 120000 })
      .where(eq(providers.name, "mock-provider"));
    vi.mocked(fetchUpstream).mockImplementation(
      async () =>
        new Response(JSON.stringify(CHAT_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(lastFetchCall().timeoutMs).toBe(120000);
  });

  it("未配置（NULL）→ timeoutMs 为 undefined（fetchUpstream 默认 60s 兜底）", async () => {
    const userId = await setupUser(`timeout-null-${crypto.randomUUID().slice(0, 8)}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, 0.15, 0.15, 0.04, 0.6, 0.6);
    // 显式置 NULL：setupProviderWithModel 幂等 update 不清列，防前序用例 120000 残留
    await createDb(env)
      .update(providers)
      .set({ upstreamTimeoutMs: null })
      .where(eq(providers.name, "mock-provider"));
    vi.mocked(fetchUpstream).mockImplementation(
      async () =>
        new Response(JSON.stringify(CHAT_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(lastFetchCall().timeoutMs).toBeUndefined();
  });
});
