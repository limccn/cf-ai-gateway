// R1/R2 集成测试（08-26-provider-config-enhance）：
// - R1 [1m] 后缀路由：上游默认转发无后缀映射值（[1m] 仅下游别名）、显式映射优先、
//   计费/日志/缓存剥离、404 拒绝。
// - R2 httpOptions：转发侧强制覆盖（headers/body/userAgent，含认证头覆盖）；
//   providers 管理 API 加密落库 + GET 掩码回显 + 非法输入 400。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { desc, eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { providers, requestLogs } from "../src/db/schema";
import { decryptSecret, encryptSecret } from "../src/lib/security";
import { buildCacheKey, hashRequestBody } from "../src/lib/response-cache";
import type { HttpOptions } from "../src/providers/types";
import {
  applyMigrations,
  clearKv,
  countTxByType,
  createSession,
  getBalance,
  selfFetch,
  sessionCookie,
  settleDelayedBilling,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "gpt-4o-mini";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;
/** 费用 = 100×0.15 + 50×0.6 = 45 → /1e6。 */
const EXPECTED_COST = (100 * INPUT_PRICE + 50 * OUTPUT_PRICE) / 1e6;

const CHAT_RESPONSE = {
  id: "chatcmpl-enhance",
  object: "chat.completion",
  created: 1_700_000_000,
  model: MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
};

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function postChat(
  plaintext: string,
  model: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return selfFetch("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hello" }],
      ...body,
    }),
  });
}

/** 查询指定用户最新明细的 model（剥离断言）。 */
async function latestLogModel(userId: number): Promise<string | null> {
  const db = createDb(env);
  const rows = await db
    .select({ model: requestLogs.model })
    .from(requestLogs)
    .where(eq(requestLogs.userId, userId))
    .orderBy(desc(requestLogs.id))
    .limit(1);
  return rows[0]?.model ?? null;
}

/** 注册带 httpOptions 的 provider（apiKey/httpOptions 同款加密落库）。 */
async function setupProviderWithHttpOptions(
  name: string,
  model: string,
  httpOptions: HttpOptions,
): Promise<number> {
  const db = createDb(env);
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, name),
    columns: { id: true },
  });
  const values = {
    type: "openai" as const,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKeyEnc: await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY),
    models: JSON.stringify({ [model]: model }),
    httpOptionsEnc: await encryptSecret(JSON.stringify(httpOptions), env.GATEWAY_SECRET_KEY),
  };
  if (existing) {
    await db.update(providers).set(values).where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db.insert(providers).values({ name, ...values }).returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert test provider");
  }
  return row.id;
}

// ============= R1：模型路由 [1m] 后缀适配 =============

describe("R1：模型路由 [1m] 后缀适配", () => {
  it("请求 [1m]：上游转发无后缀映射值、明细/计费剥离为无后缀、价格按无后缀", async () => {
    const userId = await setupUser("r1-suffix@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let upstreamBody: { model?: string } = {};
    stubUpstreamFetch((_, init) => {
      upstreamBody = JSON.parse(String(init.body ?? "{}")) as { model?: string };
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    const res = await postChat(plaintext, `${MODEL}[1m]`);
    expect(res.status).toBe(200);

    // 上游默认无后缀（[1m] 仅下游别名；仅显式 mapping 才可能带后缀）
    expect(upstreamBody["model"]).toBe(MODEL);
    // 计费：延迟计费消费者批内落账，余额按无后缀价格扣费、usage 流水 +1
    await settleDelayedBilling([
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    // 明细：model 剥离为无后缀
    expect(await latestLogModel(userId)).toBe(MODEL);
  });

  it("显式映射含 [1m]：精确优先（映射值为完整上游名，计费剥离）", async () => {
    const userId = await setupUser("r1-explicit@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    // 独立模型名：避免与 setupProviderWithModel 的 mock-provider 进入同一候选池
    const explicitModel = "gpt-4o-explicit";
    const db = createDb(env);
    // 双映射：无后缀 + 显式 [1m]（各自上游名不同，用显式 [1m] 的值区分落点）
    const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
    const inserted = await db.insert(providers).values({
      name: "r1-explicit-provider",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnc,
      models: JSON.stringify({ [explicitModel]: explicitModel, [`${explicitModel}[1m]`]: `${explicitModel}-1m` }),
    }).returning({ id: providers.id });
    const providerId = inserted[0]?.id ?? null;
    await setupPrice(explicitModel, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let upstreamModel = "";
    stubUpstreamFetch((_, init) => {
      upstreamModel = (JSON.parse(String(init.body ?? "{}")) as { model?: string })["model"] ?? "";
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    const res = await postChat(plaintext, `${explicitModel}[1m]`);
    expect(res.status).toBe(200);
    expect(upstreamModel).toBe(`${explicitModel}-1m`); // 显式映射的完整上游名，不再补后缀
    // 明细由延迟计费消费者落账（model 剥离为无后缀）
    await settleDelayedBilling([
      { userId, keyId, providerId, model: explicitModel, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await latestLogModel(userId)).toBe(explicitModel);
  });

  it("无匹配 [1m] 模型 → 404 拒绝，明细记 rejected 且 model 剥离", async () => {
    const userId = await setupUser("r1-404@test.dev", 10);
    const { plaintext } = await setupKey(userId);

    const res = await postChat(plaintext, `no-such-model[1m]`);
    expect(res.status).toBe(404);
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    // 明细 model 剥离（rejected 日志用无后缀）
    expect(await latestLogModel(userId)).toBe("no-such-model");
  });

  it("缓存共享：`xxx` 与 `xxx[1m]` 命中同一缓存键（R2 计数后命中、不转发、明细记 cached）", async () => {
    const userId = await setupUser("r1-cache@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true });
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let upstreamCalls = 0;
    stubUpstreamFetch(() => {
      upstreamCalls++;
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    // R2：第 1 次只计数、第 2 次写缓存（waitUntil 异步）、第 3 次命中
    const first = await postChat(plaintext, MODEL);
    expect(first.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    const second = await postChat(plaintext, `${MODEL}[1m]`);
    expect(second.status).toBe(200);
    expect(upstreamCalls).toBe(2); // 第 2 次仍未达命中（未写缓存）

    // bodyHash 已按计费名归一化：无后缀与 [1m] 命中同一缓存键
    const bodyHash = await hashRequestBody({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
    });
    const cacheKey = buildCacheKey(keyId, MODEL, bodyHash);
    await vi.waitFor(async () => {
      expect(await env.CACHE_KV.get(cacheKey)).not.toBeNull();
    });

    const third = await postChat(plaintext, `${MODEL}[1m]`);
    expect(third.status).toBe(200);
    // 缓存命中：不再转发
    expect(upstreamCalls).toBe(2);
    // cached 明细 model 剥离
    expect(await latestLogModel(userId)).toBe(MODEL);
  });
});

// ============= R2：httpOptions 转发强制覆盖 =============

describe("R2：httpOptions 转发（强制覆盖）", () => {
  it("headers/body/userAgent 强制覆盖上游请求（含认证头覆盖场景）", async () => {
    const userId = await setupUser("r2-forward@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    // 独立模型名：避免与 baseline 的 mock-provider 进入同一候选池
    const httpModel = "gpt-4o-http";
    await setupProviderWithHttpOptions(httpModel, httpModel, {
      userAgent: "E2E-Agent/1.0",
      headers: { "X-Provider": "acme", Authorization: "Bearer sk-custom-auth" },
      body: { temperature: 0 },
    });
    await setupPrice(httpModel, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    stubUpstreamFetch((_url, init) => {
      capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
      capturedBody = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    // 入站 body 自带 temperature 0.9 → 应被 httpOptions.body 覆盖为 0
    const res = await postChat(plaintext, httpModel, { temperature: 0.9 });
    expect(res.status).toBe(200);

    // Headers.entries() 按 fetch spec 将 header 名小写化，断言用小写键
    expect(capturedHeaders["user-agent"]).toBe("E2E-Agent/1.0");
    expect(capturedHeaders["x-provider"]).toBe("acme");
    expect(capturedHeaders["authorization"]).toBe("Bearer sk-custom-auth"); // 覆盖默认
    expect(capturedHeaders["content-type"]).toBe("application/json"); // 未覆盖的保持
    expect(capturedBody["temperature"]).toBe(0);
    expect(capturedBody["model"]).toBe(httpModel);
  });

  it("未配置 httpOptions：行为与基线一致（默认头、body 原样）", async () => {
    const userId = await setupUser("r2-baseline@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);

    let capturedHeaders: Record<string, string> = {};
    stubUpstreamFetch((_url, init) => {
      capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    const res = await postChat(plaintext, MODEL, { temperature: 0.9 });
    expect(res.status).toBe(200);
    expect(capturedHeaders["user-agent"]).toBeUndefined();
    expect(capturedHeaders["authorization"]).toBe("Bearer sk-mock");
    expect(capturedHeaders["content-type"]).toBe("application/json");
  });
});

// ============= R2：providers 管理 API =============

describe("R2：providers 管理 API（加密落库 + 掩码回显 + 校验）", () => {
  async function adminCookie(email: string): Promise<string> {
    const adminId = await setupUser(email, 0, "admin");
    return sessionCookie(await createSession(adminId));
  }

  async function createProvider(
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await selfFetch("http://localhost/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("POST 带 httpOptions：AES-GCM 加密落库（密文非明文）+ GET 掩码回显（headers 掩码、body/userAgent 明文）", async () => {
    const cookie = await adminCookie("r2-admin-secret@test.dev");
    const created = await createProvider(cookie, {
      name: "r2-secret-provider",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test-key",
      models: { [MODEL]: MODEL },
      httpOptions: {
        userAgent: "E2E-Agent/1.0",
        headers: { "X-Provider": "acme", "X-Auth-Secret": "sk-secret1234" },
        body: { temperature: 0 },
      },
    });
    expect(created.status).toBe(200);
    const provider = (created.json["provider"] as Record<string, unknown>) ?? {};

    // DB：httpOptionsEnc 为密文，不含明文痕迹
    const db = createDb(env);
    const row = await db.query.providers.findFirst({
      where: eq(providers.name, "r2-secret-provider"),
    });
    expect(row?.httpOptionsEnc).toBeTruthy();
    expect(row?.httpOptionsEnc).not.toContain("sk-secret1234");
    expect(row?.httpOptionsEnc).not.toContain("E2E-Agent");

    // 回显掩码（create 响应）
    const createdHttp = provider["httpOptions"] as Record<string, unknown>;
    const createdHeaders = (createdHttp?.["headers"] ?? {}) as Record<string, string>;
    expect(createdHeaders["X-Provider"]).toBe("****"); // 长度 4 → 全掩
    expect(createdHeaders["X-Auth-Secret"]).toBe("****1234");
    expect(createdHttp?.["userAgent"]).toBe("E2E-Agent/1.0"); // 明文
    expect(createdHttp?.["body"]).toEqual({ temperature: 0 }); // 明文

    // GET 列表：同样掩码
    const listRes = await selfFetch("http://localhost/api/providers", {
      headers: { Cookie: cookie },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      items: Array<{ name: string; httpOptions: { headers: Record<string, string> } }>;
    };
    const listed = listBody.items.find((p) => p.name === "r2-secret-provider");
    expect(listed?.httpOptions.headers["X-Auth-Secret"]).toBe("****1234");
  });

  it("PATCH 省略 httpOptions 保持原配置；提供则整体替换", async () => {
    const cookie = await adminCookie("r2-admin-patch@test.dev");
    const created = await createProvider(cookie, {
      name: "r2-patch-provider",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test-key",
      models: { [MODEL]: MODEL },
      httpOptions: { headers: { "X-Original": "orig-secret-abc" } },
    });
    const providerId = (created.json["provider"] as { id?: number })?.id;
    expect(providerId).toBeTruthy();

    // 省略 httpOptions：仅改 name → 原密文保持（响应仍解密回显掩码）
    const patchKeep = await selfFetch(`http://localhost/api/providers/${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "r2-patch-provider-v2" }),
    });
    expect(patchKeep.status).toBe(200);
    const keepBody = (await patchKeep.json()) as {
      provider: { httpOptions: { headers: Record<string, string> } };
    };
    expect(keepBody.provider.httpOptions.headers["X-Original"]).toBe("****-abc");

    // 提供新 httpOptions：整体替换
    const patchReplace = await selfFetch(`http://localhost/api/providers/${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        httpOptions: { headers: { "X-New": "new-value" } },
      }),
    });
    expect(patchReplace.status).toBe(200);
    const replaceBody = (await patchReplace.json()) as {
      provider: { httpOptions: { headers: Record<string, string> } };
    };
    expect(replaceBody.provider.httpOptions.headers["X-New"]).toBe("****alue");
    expect(replaceBody.provider.httpOptions.headers["X-Original"]).toBeUndefined();
  });

  it("H5 掩码哨兵：PATCH 提交掩码 header 值 → 保留旧值；无旧值的掩码条目丢弃（掩码字面量不落库）", async () => {
    const cookie = await adminCookie("r2-admin-h5@test.dev");
    const created = await createProvider(cookie, {
      name: "r2-h5-provider",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test-key",
      models: { [MODEL]: MODEL },
      httpOptions: { headers: { "X-Auth": "sk-real-secret-1234" } },
    });
    const providerId = (created.json["provider"] as { id?: number })?.id;
    expect(providerId).toBeTruthy();

    // 模拟前端编辑回填：掩码值原样提交（掩码 = maskHeaderValue 输出的 `****1234`）
    const patch = await selfFetch(`http://localhost/api/providers/${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        httpOptions: {
          headers: { "X-Auth": "****1234", "X-New": "fresh-value", "X-Ghost": "****ghost" },
        },
      }),
    });
    expect(patch.status).toBe(200);

    // DB 解密：X-Auth 保留旧明文（掩码哨兵）；X-New 新值生效；X-Ghost（掩码且无旧值）丢弃
    const db = createDb(env);
    const row = await db.query.providers.findFirst({
      where: eq(providers.name, "r2-h5-provider"),
    });
    const stored = JSON.parse(
      await decryptSecret(row?.httpOptionsEnc ?? "", env.GATEWAY_SECRET_KEY),
    ) as { headers: Record<string, string> };
    expect(stored.headers["X-Auth"]).toBe("sk-real-secret-1234");
    expect(stored.headers["X-New"]).toBe("fresh-value");
    expect(stored.headers["X-Ghost"]).toBeUndefined();
    // 掩码字面量绝不落库
    expect(row?.httpOptionsEnc).not.toContain("****1234");
    // 响应掩码回显一致（旧值保留 → 掩码不变）
    const patchBody = (await patch.json()) as {
      provider: { httpOptions: { headers: Record<string, string> } };
    };
    expect(patchBody.provider.httpOptions.headers["X-Auth"]).toBe("****1234");
  });

  it("非法 httpOptions → 400（header 名 token 字符集、值禁 CR/LF、未知字段 strict、body 非对象）", async () => {
    const cookie = await adminCookie("r2-admin-invalid@test.dev");
    const base = {
      name: "r2-invalid-provider",
      type: "openai" as const,
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-test-key",
      models: { [MODEL]: MODEL },
    };
    const invalidBodies: Array<Record<string, unknown>> = [
      { ...base, httpOptions: { headers: { "Bad Header": "v" } } }, // 名含空格
      { ...base, httpOptions: { headers: { "X-OK": "a\nb" } } }, // 值含 CR/LF
      { ...base, httpOptions: { headers: { "X-OK": "a\rb" } } }, // 值含 CR
      { ...base, httpOptions: { body: "not-an-object" } }, // body 非对象
      { ...base, httpOptions: { unknownField: 1 } }, // 未知字段（strict）
      { ...base, httpOptions: { userAgent: "x".repeat(501) } }, // userAgent 超长
    ];
    for (const body of invalidBodies) {
      const res = await createProvider(cookie, body);
      expect(res.status).toBe(400);
    }
  });
});
