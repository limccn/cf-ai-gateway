// 协议自动感知集成测试（08-31-protocol-auto-detect，design §10）：/v1/messages 统一入口
// 全链路（miniflare 真实 Worker）——anthropic 体 → Anthropic 响应 + anthropic: 缓存前缀；
// openai 体（gpt-*）→ OpenAI 响应 + 无前缀缓存键；缺 max_tokens + claude-* → 400 Anthropic 形态；
// 双向冲突 → 400；错误形态跟随（401 空请求 Anthropic 形态 / openai 体 401 OpenAI 形态 / 404 跟随）。
import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrations,
  clearKv,
  selfFetch,
  setupKey,
  setupPrice,
  setupProvider,
  setupUser,
} from "./helpers";

const MODEL_A = "claude-test-4";
const MODEL_O = "gpt-test-4o";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

let plaintext: string;

/** OpenAI 形态上游响应（openai 类型 provider；结算在协议转换前解析此形态）。 */
function okOpenAi(model: string): Record<string, unknown> {
  return {
    id: "chatcmpl-proto",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "proto-ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

/** Anthropic 形态上游响应（anthropic 类型 provider 原生端点；adapter 正向转 OpenAI 再出站反向转回）。 */
function okAnthropic(model: string): Record<string, unknown> {
  return {
    id: "msg_proto",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "proto-ok" }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
  const userId = await setupUser("proto@test.local", 100);
  ({ plaintext } = await setupKey(userId, { cacheEnabled: true }));
  // 两个 provider：anthropic 类型（claude-test-4）+ openai 类型（gpt-test-4o），各自模型唯一
  await setupProvider("proto-anthro", MODEL_A, { type: "anthropic", baseUrl: "http://up-proto-anthro/v1" });
  await setupProvider("proto-openai", MODEL_O, { baseUrl: "http://up-proto-openai/v1" });
  await setupPrice(MODEL_A, INPUT_PRICE, INPUT_PRICE, 0, OUTPUT_PRICE, OUTPUT_PRICE);
  await setupPrice(MODEL_O, INPUT_PRICE, INPUT_PRICE, 0, OUTPUT_PRICE, OUTPUT_PRICE);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body !== undefined ? JSON.parse(String(init.body)) : {};
      const upstreamModel = body["model"];
      // provider 类型决定上游端点形态：anthropic → Anthropic Messages 响应；openai → chat.completion
      const payload = url.includes("up-proto-anthro") ? okAnthropic(upstreamModel) : okOpenAi(upstreamModel);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}`, ...extra };
}

describe("/v1/messages anthropic 分支（零回归）", () => {
  it("claude-* + max_tokens → Anthropic 响应形态", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: MODEL_A,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("message");
    expect(body["role"]).toBe("assistant");
    expect(body["content"]).toEqual([{ type: "text", text: "proto-ok" }]);
    expect(body["usage"]).toMatchObject({ input_tokens: 100, output_tokens: 50 });
  });

  it("anthropic 分支写入 resp:anthropic: 前缀缓存键（R2 高频重传 N=2）", async () => {
    // R2 触发收窄：同一 body 10min 窗口内第 2 次请求才写缓存 → 相同 body 发 2 次
    const body = JSON.stringify({
      model: MODEL_A,
      max_tokens: 64,
      messages: [{ role: "user", content: "cache-me" }],
    });
    const res1 = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    const res2 = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // 写缓存走 waitUntil 异步（与 cache.test.ts 同模式）
    await vi.waitFor(async () => {
      const listed = await env.CACHE_KV.list({ prefix: "resp:anthropic:" });
      expect(listed.keys.some((k) => k.name.startsWith("resp:anthropic:"))).toBe(true);
    });
  });

  it("缺 max_tokens + claude-* → 400 Anthropic 形态（invalid_request_error）", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: MODEL_A,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("error");
    expect((body["error"] as Record<string, unknown>)["type"]).toBe("invalid_request_error");
    expect((body["error"] as Record<string, unknown>)["message"]).toMatch(/max_tokens/);
  });
});

describe("/v1/messages openai 分支", () => {
  it("gpt-* + 无 anthropic 信号 → OpenAI 响应形态（恒等）", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: MODEL_O,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
    expect(body["choices"]).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "proto-ok" },
        finish_reason: "stop",
      },
    ]);
    expect(body["usage"]).toMatchObject({ prompt_tokens: 100, completion_tokens: 50 });
  });

  it("openai 分支缓存键无 resp:anthropic: 前缀（与 chat 同语义共享）", async () => {
    // 先跑过前面用例的 anthropic 缓存（resp:anthropic: 非空）；openai 分支 2 次同 body 不新增该前缀键
    const before = (await env.CACHE_KV.list({ prefix: "resp:anthropic:" })).keys.map((k) => k.name);
    const body = JSON.stringify({
      model: MODEL_O,
      messages: [{ role: "user", content: "openai-cache" }],
    });
    const res1 = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    const res2 = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const after = await env.CACHE_KV.list({ prefix: "resp:anthropic:" });
    expect(after.keys.map((k) => k.name)).toEqual(before);
    // openai 分支自身确实写入了缓存（无前缀键）
    const all = await env.CACHE_KV.list({ prefix: "resp:" });
    expect(all.keys.length).toBeGreaterThan(0);
  });

  it("openai 硬信号（response_format）即使 claude-* 模型名 → openai 分支", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: MODEL_A,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: "json" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
  });
});

describe("错误形态跟随与冲突", () => {
  it("双向冲突（system + n）→ 400 Anthropic 形态", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: MODEL_O,
        system: "sys",
        n: 2,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("error");
    expect((body["error"] as Record<string, unknown>)["message"]).toMatch(/mixes OpenAI and Anthropic/);
  });

  it("401 空请求（无 body，非 JSON 未检测）→ Anthropic 形态（现状语义，零回归）", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // 无 Authorization、无 body（json() 解析失败 → 不设置）
      body: "",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("error");
    expect((body["error"] as Record<string, unknown>)["type"]).toBe("authentication_error");
  });

  it("401 + openai 体 → OpenAI 形态（不改写）", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // 无 Authorization
      body: JSON.stringify({ model: MODEL_O, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBeUndefined();
    expect((body["error"] as Record<string, unknown>)["message"]).toBeTruthy();
  });

  it("404 跟随协议：claude 体 → Anthropic 形态 / gpt 体 → OpenAI 形态", async () => {
    // claude 体 + 未注册模型 → 404 Anthropic 形态
    const resA = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "claude-ghost-1",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(resA.status).toBe(404);
    const bodyA = (await resA.json()) as Record<string, unknown>;
    expect(bodyA["type"]).toBe("error");
    expect((bodyA["error"] as Record<string, unknown>)["type"]).toBe("not_found_error");

    // gpt 体 + 未注册模型 → 404 OpenAI 形态
    const resO = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "gpt-ghost-9",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(resO.status).toBe(404);
    const bodyO = (await resO.json()) as Record<string, unknown>;
    expect(bodyO["type"]).toBeUndefined();
    expect((bodyO["error"] as Record<string, unknown>)["message"]).toBeTruthy();
  });
});
