// 多 Upstream 集成测试（08-27-multi-upstream）：候选池 + 哈希粘性 + 权重分配 +
// 故障转移 + 断路器（design.md AC2-AC11）。mock 上游（vi.stubGlobal fetch）按 baseUrl
// 区分 provider，验证：粘性恒落、权重比例、5xx/429/网络 failover（双明细）、4xx 不透传、
// 断路器跳过、全断 502、管理 API weight/circuitBroken、单 provider 零回归、流式 failover。
//
// 隔离约定：候选池 = 该模型下所有 enabled provider，故每个用例用唯一模型名
// （uniqueModel()），避免跨用例 provider 混入候选池污染分配/转移断言。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { requestLogs } from "../src/db/schema";
import {
  circuitKey,
  openCircuit,
  pickProvider,
  readCircuit,
  resetOpenSuppressionForTest,
  type RouteCandidate,
} from "../src/lib/provider-router";
import {
  applyMigrations,
  clearKv,
  countKvOps,
  countTxByType,
  createSession,
  getBalance,
  selfFetch,
  sessionCookie,
  settleDelayedBilling,
  setupKey,
  setupPrice,
  setupProvider,
  setupUser,
} from "./helpers";

/** 测试价格（与 proxy-pipeline 同口径）：输入 0.15/M、输出 0.6/M。 */
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;
/** 预期费用 = 100×0.15 + 50×0.6 = 45 → /1e6 = 0.000045。 */
const EXPECTED_COST = (100 * INPUT_PRICE + 50 * OUTPUT_PRICE) / 1e6;

const BASE_A = "http://a.test/v1";
const BASE_B = "http://b.test/v1";

let modelSeq = 0;
/** 每个用例独立模型名（候选池隔离，见文件头注释）。 */
function uniqueModel(): string {
  modelSeq++;
  return `mu-${modelSeq}-model`;
}

/** 上游非流式 chat.completion 成功响应（含 usage）。 */
function okResponse(model: string): Record<string, unknown> {
  return {
    id: "chatcmpl-multi",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function chatBody(model: string, stream = false): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "hello" }],
    stream,
  });
}

async function postChat(plaintext: string, model: string, stream = false): Promise<Response> {
  return selfFetch("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
    body: chatBody(model, stream),
  });
}

/** 用 canned 上游响应替换全局 fetch，记录每次调用 url（顺序）。 */
function stubUpstreamFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): string[] {
  const called: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      called.push(url);
      return handler(url, init ?? {});
    }),
  );
  return called;
}

/** 某 key 的请求明细（id 升序 = 时序；error 先、success 后）。 */
async function logsFor(keyId: number): Promise<Array<{ providerId: number | null; status: string }>> {
  const db = createDb(env);
  const rows = await db
    .select({ providerId: requestLogs.providerId, status: requestLogs.status })
    .from(requestLogs)
    .where(eq(requestLogs.keyId, keyId))
    .orderBy(asc(requestLogs.id));
  return rows.map((r) => ({ providerId: r.providerId, status: r.status }));
}

/** CACHE_KV 中现存断路器键（判断是否写过断路）。 */
async function circuitKeys(): Promise<string[]> {
  const listed = await env.CACHE_KV.list({ prefix: "circuit:" });
  return listed.keys.map((k) => k.name);
}

/**
 * 创建 key 直到其哈希落点命中 targetProviderId。
 * failover 测试需要首选落在指定 provider（触发其失败分支），哈希落点不可控，
 * 用循环采样保证确定性（约 1/2 概率，50 次内命中概率 ≈ 1 - 2^-50）。
 */
async function setupKeyOnProvider(
  userId: number,
  candidates: RouteCandidate[],
  targetProviderId: number,
): Promise<{ keyId: number; plaintext: string }> {
  for (let i = 0; i < 50; i++) {
    const key = await setupKey(userId);
    if (pickProvider(candidates, key.keyId).providerId === targetProviderId) {
      return key;
    }
  }
  throw new Error("no key landed on target provider within 50 attempts");
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // 清空断路器键（防跨用例残留误判 circuitKeys() 与断路器跳过行为）
  await clearKv();
  // O6：openCircuit 10s 写抑制为 isolate 模块级（clearKv 清不掉）→ 用例间显式复位
  resetOpenSuppressionForTest();
});

describe("多候选：分配与粘性", () => {
  it("同一 keyId 多次请求恒落同一 provider（粘性）", async () => {
    const model = uniqueModel();
    const a = await setupProvider("stick-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("stick-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-sticky@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const called = stubUpstreamFetch(() =>
      new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );

    for (let i = 0; i < 3; i++) {
      const res = await postChat(plaintext, model);
      expect(res.status).toBe(200);
    }
    // 3 次请求 URL 全部一致 → 同一 provider（无状态哈希粘性，无共享会话存储）
    expect(called).toHaveLength(3);
    expect(called[0]).toBe(called[1]);
    expect(called[0]).toBe(called[2]);
    // 落点与纯函数预测一致（keyId 级哈希）
    const expected = pickProvider(
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      keyId,
    );
    expect(called[0]).toContain(expected.providerId === a ? "a.test" : "b.test");
  });

  it("权重 3:1：100 个 key 落点比例约 75%/25%（两 provider 均被命中）", async () => {
    const model = uniqueModel();
    await setupProvider("w-a", model, { baseUrl: BASE_A, weight: 3 });
    await setupProvider("w-b", model, { baseUrl: BASE_B, weight: 1 });
    const userId = await setupUser("multi-weight@test.dev", 10);

    const called = stubUpstreamFetch(() =>
      new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      const { plaintext } = await setupKey(userId);
      keys.push(plaintext);
    }
    for (const plaintext of keys) {
      const res = await postChat(plaintext, model);
      expect(res.status).toBe(200);
    }
    const hitsA = called.filter((u) => u.includes("a.test")).length;
    const hitsB = called.filter((u) => u.includes("b.test")).length;
    expect(hitsA + hitsB).toBe(100);
    // 二项分布 p=0.75, n=100 → 3σ ≈ 13%；宽松 ±10% 防 flake
    const ratio = hitsA / 100;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(0.85);
    expect(hitsB).toBeGreaterThan(0);
  });
});

describe("多候选：故障转移", () => {
  it("首选 5xx → 转移第二候选成功；双明细（error=A → success=B）且写断路器", async () => {
    const model = uniqueModel();
    const a = await setupProvider("f5-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("f5-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-5xx@test.dev", 10);
    const { keyId, plaintext } = await setupKeyOnProvider(
      userId,
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      a,
    );
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const called = stubUpstreamFetch((url) =>
      url.includes("a.test")
        ? new Response(JSON.stringify({ error: { message: "upstream boom" } }), { status: 500 })
        : new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );

    const res = await postChat(plaintext, model);
    expect(res.status).toBe(200);

    // 转移：先 A（500）后 B（200），共 2 次上游调用（转移上限 1 次）
    expect(called).toHaveLength(2);
    expect(called[0]).toContain("a.test");
    expect(called[1]).toContain("b.test");

    // 断路器：A 已断（reason 5xx），B 健康
    expect((await readCircuit(env.CACHE_KV, a))?.reason).toBe("5xx");
    expect(await readCircuit(env.CACHE_KV, b)).toBeNull();

    // 双明细：error(A) 同步落、success(B) 由延迟计费消费者落账（按成功 provider 结算）
    await settleDelayedBilling([
      { userId, keyId, providerId: b, model, promptTokens: 100, completionTokens: 50 },
    ]);
    const logs = await logsFor(keyId);
    expect(logs.map((l) => [l.providerId, l.status])).toEqual([
      [a, "error"],
      [b, "success"],
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
  });

  it("首选 429 → 转移第二候选成功；断路器 reason=429", async () => {
    const model = uniqueModel();
    const a = await setupProvider("f429-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("f429-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-429@test.dev", 10);
    const { keyId, plaintext } = await setupKeyOnProvider(
      userId,
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      a,
    );

    const called = stubUpstreamFetch((url) =>
      url.includes("a.test")
        ? new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
        : new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );

    const res = await postChat(plaintext, model);
    expect(res.status).toBe(200);
    expect(called).toHaveLength(2);
    expect(called[0]).toContain("a.test");
    expect(called[1]).toContain("b.test");
    expect((await readCircuit(env.CACHE_KV, a))?.reason).toBe("429");

    // success(B) 明细由延迟计费消费者落账（error(A) 同步落）
    await settleDelayedBilling([
      { userId, keyId, providerId: b, model, promptTokens: 100, completionTokens: 50 },
    ]);
    const logs = await logsFor(keyId);
    expect(logs.map((l) => [l.providerId, l.status])).toEqual([
      [a, "error"],
      [b, "success"],
    ]);
  });

  it("首选网络不可达 → 转移第二候选成功；写断路器", async () => {
    const model = uniqueModel();
    const a = await setupProvider("fnet-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("fnet-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-net@test.dev", 10);
    const { keyId, plaintext } = await setupKeyOnProvider(
      userId,
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      a,
    );

    const called = stubUpstreamFetch((url) => {
      if (url.includes("a.test")) {
        throw new TypeError("fetch failed: connection refused");
      }
      return new Response(JSON.stringify(okResponse(model)), { status: 200 });
    });

    const res = await postChat(plaintext, model);
    expect(res.status).toBe(200);
    expect(called).toHaveLength(2);
    expect(called[0]).toContain("a.test");
    expect(called[1]).toContain("b.test");
    expect((await readCircuit(env.CACHE_KV, a))?.reason).toBe("network");

    // success(B) 明细由延迟计费消费者落账（error(A) 同步落）
    await settleDelayedBilling([
      { userId, keyId, providerId: b, model, promptTokens: 100, completionTokens: 50 },
    ]);
    const logs = await logsFor(keyId);
    expect(logs.map((l) => [l.providerId, l.status])).toEqual([
      [a, "error"],
      [b, "success"],
    ]);
  });

  it("4xx（非 429）不透传不转移：直接返回上游错误，不写断路器", async () => {
    const model = uniqueModel();
    const a = await setupProvider("f400-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("f400-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-400@test.dev", 10);
    const { plaintext } = await setupKeyOnProvider(
      userId,
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      a,
    );

    const called = stubUpstreamFetch((url) =>
      url.includes("a.test")
        ? new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 })
        : new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );

    const res = await postChat(plaintext, model);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toContain("bad request");
    // 不转移：仅 A 被调用，B 未动，断路器未写
    expect(called).toHaveLength(1);
    expect(called[0]).toContain("a.test");
    expect(await circuitKeys()).toEqual([]);
  });

  it("首选已断路 → 直接选第二健康候选（断路器跳过，不发首选请求）", async () => {
    const model = uniqueModel();
    const a = await setupProvider("skip-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("skip-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-skip@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);

    // 数据驱动：先算 keyId 落在谁，断路首选 → 应只请求另一家
    const primary = pickProvider(
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      keyId,
    ).providerId;
    await openCircuit(env.CACHE_KV, primary, "5xx");

    const called = stubUpstreamFetch(() =>
      new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );
    const res = await postChat(plaintext, model);
    expect(res.status).toBe(200);
    expect(called).toHaveLength(1);
    expect(called[0]).toContain(primary === a ? "b.test" : "a.test");
  });

  it("O4.2：断路读请求内 memo 去重——首选断路场景每个候选恰 1 读", async () => {
    const model = uniqueModel();
    const a = await setupProvider("memo-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("memo-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-memo@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);

    const primary = pickProvider(
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      keyId,
    ).providerId;
    await openCircuit(env.CACHE_KV, primary, "5xx");

    const called = stubUpstreamFetch(() =>
      new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );
    const kv = countKvOps("circuit:");
    try {
      const res = await postChat(plaintext, model);
      expect(res.status).toBe(200);
      expect(called).toHaveLength(1);
      expect(called[0]).toContain(primary === a ? "b.test" : "a.test");
    } finally {
      kv.unwrap();
    }
    // 预筛读 primary（断路）+ 健康候选各 1 次；填充循环复用 memo → 无重读
    // （无 memo 时「首选被跳过」场景会把 primary 再读一次 = 3 读）
    expect(kv.gets).toHaveLength(2);
    expect(kv.gets.filter((k) => k === circuitKey(primary))).toHaveLength(1);
  });

  it("全部候选断路 → 502 All upstream providers unavailable；零上游调用", async () => {
    const model = uniqueModel();
    const a = await setupProvider("open-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("open-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-open@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await openCircuit(env.CACHE_KV, a, "5xx");
    await openCircuit(env.CACHE_KV, b, "429");

    const called = stubUpstreamFetch(() =>
      new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );
    const res = await postChat(plaintext, model);
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBe("All upstream providers are temporarily unavailable");
    expect(called).toHaveLength(0);
  });

  it("流式 failover：首选 5xx → 转移第二候选 SSE 成功并结算", async () => {
    const model = uniqueModel();
    const a = await setupProvider("fstr-a", model, { baseUrl: BASE_A });
    const b = await setupProvider("fstr-b", model, { baseUrl: BASE_B });
    const userId = await setupUser("multi-stream@test.dev", 10);
    const { keyId, plaintext } = await setupKeyOnProvider(
      userId,
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      a,
    );
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const sse =
      [
        `data: {"id":"chatcmpl-s","object":"chat.completion","created":1700000000,"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}`,
        `data: {"id":"chatcmpl-s","object":"chat.completion","created":1700000000,"model":"${model}","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}`,
        `data: {"id":"chatcmpl-s","object":"chat.completion","created":1700000000,"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
        `data: {"id":"chatcmpl-s","object":"chat.completion","created":1700000000,"model":"${model}","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}`,
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    const called = stubUpstreamFetch((url) =>
      url.includes("a.test")
        ? new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
        : new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postChat(plaintext, model, true);
    expect(res.status).toBe(200);
    expect(called).toHaveLength(2);
    expect(called[0]).toContain("a.test");
    expect(called[1]).toContain("b.test");
    expect((await readCircuit(env.CACHE_KV, a))?.reason).toBe("5xx");

    const text = await res.text();
    expect(text).toContain('"delta":{"role":"assistant","content":"Hel"');
    expect(text).toContain("data: [DONE]");
    // 尾包结算：settle 回调只发计费事件，消费者批内落账（error(A) 同步、success(B) 延迟）
    await settleDelayedBilling([
      { userId, keyId, providerId: b, model, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect((await logsFor(keyId)).map((l) => l.status)).toEqual(["error", "success"]);
  });
});

describe("单候选：零回归", () => {
  it("仅一个 provider 时 5xx 直接透传；不写断路器、无重试", async () => {
    const model = uniqueModel();
    await setupProvider("solo-a", model, { baseUrl: BASE_A });
    const userId = await setupUser("multi-solo@test.dev", 10);
    const { plaintext } = await setupKey(userId);

    const called = stubUpstreamFetch((url) =>
      url.includes("a.test")
        ? new Response(JSON.stringify({ error: { message: "upstream down" } }), { status: 503 })
        : new Response(JSON.stringify(okResponse(model)), { status: 200 }),
    );

    const res = await postChat(plaintext, model);
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toContain("upstream down");
    // 单候选短路：1 次上游调用，无断路器键，无重试
    expect(called).toHaveLength(1);
    expect(await circuitKeys()).toEqual([]);
  });
});

describe("管理 API：weight 与断路状态", () => {
  const model = uniqueModel();

  let adminSeq = 0;
  async function adminCookie(): Promise<string> {
    adminSeq++;
    // users.email 有唯一约束，每个用例独立 admin（序列号后缀防冲突）
    const adminId = await setupUser(`multi-admin-${adminSeq}@test.dev`, 0, "admin");
    return sessionCookie(await createSession(adminId));
  }

  it("POST 带 weight=5 落库并在响应中回显；PATCH 可更新 weight", async () => {
    const cookie = await adminCookie();
    const created = await selfFetch("http://localhost/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "mgmt-w-a",
        type: "openai",
        baseUrl: BASE_A,
        apiKey: "sk-admin-test",
        models: { [model]: model },
        weight: 5,
      }),
    });
    expect(created.status).toBe(200);
    const createdJson = (await created.json()) as { provider?: { id: number; weight: number } };
    expect(createdJson["provider"]?.["weight"]).toBe(5);

    const patched = await selfFetch(
      `http://localhost/api/providers/${createdJson["provider"]?.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ weight: 3 }),
      },
    );
    expect(patched.status).toBe(200);
    const patchedJson = (await patched.json()) as { provider?: { weight: number } };
    expect(patchedJson["provider"]?.["weight"]).toBe(3);
  });

  it("weight 越界（0/1001）→ 400 校验拒绝", async () => {
    const cookie = await adminCookie();
    for (const weight of [0, 1001]) {
      const res = await selfFetch("http://localhost/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          name: `mgmt-bad-${weight}`,
          type: "openai",
          baseUrl: BASE_A,
          apiKey: "sk-admin-test",
          models: { [model]: model },
          weight,
        }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("断路中的 provider 在列表返回 circuitBroken + circuitReason", async () => {
    const cookie = await adminCookie();
    const created = await selfFetch("http://localhost/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "mgmt-open-a",
        type: "openai",
        baseUrl: BASE_A,
        apiKey: "sk-admin-test",
        models: { [model]: model },
      }),
    });
    const createdJson = (await created.json()) as { provider?: { id: number } };
    const providerId = createdJson["provider"]?.id;
    if (providerId === undefined) {
      throw new Error("failed to create test provider");
    }

    // 健康时列表不携带断路字段
    const healthy = (await (await selfFetch("http://localhost/api/providers", {
      headers: { Cookie: cookie },
    })).json()) as { items?: Array<{ id: number; circuitBroken?: boolean }> };
    const healthyItem = healthy["items"]?.find((p) => p["id"] === providerId);
    expect(healthyItem?.["circuitBroken"]).toBeUndefined();

    // 断路后列表携带状态 + 原因
    await openCircuit(env.CACHE_KV, providerId, "429");
    const broken = (await (await selfFetch("http://localhost/api/providers", {
      headers: { Cookie: cookie },
    })).json()) as {
      items?: Array<{ id: number; circuitBroken?: boolean; circuitReason?: string }>;
    };
    const brokenItem = broken["items"]?.find((p) => p["id"] === providerId);
    expect(brokenItem?.["circuitBroken"]).toBe(true);
    expect(brokenItem?.["circuitReason"]).toBe("429");
  });
});

// ============= 批次 2（09-28-upstream-custom-type-passthrough）：声明面路由语义 =============
//
// 候选池隔离：沿用文件头约定，每个用例独立模型名（uniqueModel()）。
describe("批次 2：声明面路由（fail-soft + 多候选跳过 + 遗留 400 语义）", () => {
  it("fail-soft：一条 protocols 损坏的记录不拖垮候选池——不进池、其余候选照常服务", async () => {
    const model = uniqueModel();
    const userId = await setupUser("mu-corrupt-pool@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    // 损坏记录 id 更低（先插入）：若解析失败污染候选池/中断收集，本用例必红
    await setupProvider("mu-corrupt-protocols", model, {
      baseUrl: "http://corrupt.test/v1",
      protocols: "{not-json",
    });
    await setupProvider("mu-corrupt-good", model, { baseUrl: BASE_A });
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const called = stubUpstreamFetch(() => {
      return new Response(JSON.stringify(okResponse(model)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postChat(plaintext, model);
    expect(res.status).toBe(200);
    // 损坏记录未进候选池：唯一一次上游调用来自健康记录
    expect(called).toHaveLength(1);
    expect(called[0]).toContain("a.test");
  });

  it("fail-soft：仅一条 protocols 损坏记录 ⇒ 候选池空 → 404 model_not_routed（不 500）", async () => {
    const model = uniqueModel();
    const userId = await setupUser("mu-corrupt-only@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProvider("mu-corrupt-alone", model, {
      baseUrl: "http://corrupt.test/v1",
      protocols: "{not-json",
    });

    stubUpstreamFetch(() => new Response("should not be called", { status: 200 }));
    const res = await postChat(plaintext, model);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body["error"]?.["message"]).toContain("does not exist");
  });

  it("多候选跳过：回退趟中不承载 chat 的 custom 记录被跳过（不 400 不中断），另一候选照常服务", async () => {
    const model = uniqueModel();
    const userId = await setupUser("mu-skip-unsupported@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    // 两记录都无 chat 原生面 ⇒ 偏好趟空 → 回退趟全收（id 序）：completions-only 在前
    await setupProvider("mu-skip-completions-only", model, {
      type: "custom",
      baseUrl: "http://skip.test/v1",
      protocols: JSON.stringify({ completions: {} }),
    });
    await setupProvider("mu-skip-messages-only", model, {
      type: "custom",
      baseUrl: "http://serve.test/anthropic",
      protocols: JSON.stringify({ messages: {} }),
    });

    const called = stubUpstreamFetch(() => {
      return new Response(
        JSON.stringify({
          id: "msg_skip",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await postChat(plaintext, model);
    expect(res.status).toBe(200);
    // completions-only 候选被 selectEndpoint 判 null → 跳过（无上游调用、不写断路器）；
    // messages 面经跨方言兜底承载 chat 入站 → anthropic 方言 URL
    expect(called).toHaveLength(1);
    expect(called[0]).toBe("http://serve.test/anthropic/v1/messages");
  });

  it("遗留 400 语义逐字保留：anthropic provider 对 /v1/completions 与 /v1/embeddings 仍 400", async () => {
    const model = uniqueModel();
    const userId = await setupUser("mu-legacy-anthro-400@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProvider("mu-legacy-anthro", model, { type: "anthropic", baseUrl: "http://claude.test" });

    stubUpstreamFetch(() => new Response("should not be called", { status: 200 }));

    const completions = await selfFetch("http://localhost/v1/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model, prompt: "hi" }),
    });
    expect(completions.status).toBe(400);
    const completionsBody = (await completions.json()) as { error?: { message?: string } };
    expect(completionsBody["error"]?.["message"]).toBe(
      "Provider type 'anthropic' does not support this endpoint",
    );

    const embeddings = await selfFetch("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model, input: "hi" }),
    });
    expect(embeddings.status).toBe(400);
    const embeddingsBody = (await embeddings.json()) as { error?: { message?: string } };
    expect(embeddingsBody["error"]?.["message"]).toBe(
      "Provider type 'anthropic' does not support this endpoint",
    );
  });
});
