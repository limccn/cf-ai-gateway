// R2（09-01-reasoning-effort-mapping）：reasoning_effort → Anthropic effort 映射测试。
// 覆盖：normalizeEffort 档位归一全表（纯函数）、buildRequest 三模式（auto/adaptive/budget/off）
// + 温度剥离 + R1 extras 优先、admin API thinking_mode 校验（POST/PATCH/GET/非法值）、
// E2E：/v1/chat/completions reasoning_effort → anthropic 上游 output_config+thinking 断言。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { anthropicAdapter, normalizeEffort } from "../src/providers/anthropic";
import type { InternalRequest, ProviderConfig } from "../src/providers/types";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { encryptSecret } from "../src/lib/security";
import {
  applyMigrations,
  clearKv,
  createSession,
  selfFetch,
  sessionCookie,
  setupKey,
  setupPrice,
  setupUser,
} from "./helpers";

const MODEL = "claude-effort-test";
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

/** 注册 anthropic 类型 Provider（mock 上游）。 */
async function setupAnthropicProviderWithModel(
  model: string,
  thinkingMode?: string | null,
): Promise<number> {
  const db = createDb(env);
  const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, "mock-anthropic-effort-provider"),
    columns: { id: true },
  });
  const base = {
    type: "anthropic" as const,
    baseUrl: "http://127.0.0.1:1",
    apiKeyEnc,
    models: JSON.stringify({ [model]: model }),
    thinkingMode: thinkingMode ?? null,
  };
  if (existing) {
    await db.update(providers).set(base).where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(providers)
    .values({ name: "mock-anthropic-effort-provider", ...base })
    .returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert anthropic test provider");
  }
  return row.id;
}

// ============ 1. normalizeEffort 档位归一（纯函数） ============

describe("normalizeEffort（档位归一）", () => {
  it("none → null（省略思考）；minimal → low", () => {
    expect(normalizeEffort("none")).toBeNull();
    expect(normalizeEffort("minimal")).toBe("low");
  });
  it("low/medium/high/xhigh 1:1", () => {
    expect(normalizeEffort("low")).toBe("low");
    expect(normalizeEffort("medium")).toBe("medium");
    expect(normalizeEffort("high")).toBe("high");
    expect(normalizeEffort("xhigh")).toBe("xhigh");
  });
  it("其他字符串原样透传（上游兜底）", () => {
    expect(normalizeEffort("turbo")).toBe("turbo");
  });
});

// ============ 2. buildRequest 三模式映射（纯函数） ============

function makeReq(effort: string, extras?: InternalRequest["anthropicExtras"]): InternalRequest {
  return {
    kind: "chat",
    body: {
      model: MODEL,
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      reasoning_effort: effort,
      messages: [{ role: "user", content: "hi" }],
    },
    model: MODEL,
    stream: false,
    anthropicExtras: extras,
  };
}

function makeCfg(thinkingMode?: string | null): ProviderConfig {
  return {
    type: "anthropic",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "sk-mock",
    models: { [MODEL]: MODEL },
    ...(thinkingMode !== undefined ? { thinkingMode } : {}),
  };
}

function upstreamBody(req: InternalRequest, cfg: ProviderConfig): Record<string, unknown> {
  const upstream = anthropicAdapter.buildRequest(req, cfg);
  return JSON.parse(String(upstream.init.body)) as Record<string, unknown>;
}

describe("anthropicAdapter.buildRequest（R2 effort 映射）", () => {
  it("缺省（NULL/undefined）→ 不映射（H3 零变更契约：无 thinking/output_config、温度保留）", () => {
    // 此前 `?? "auto"` 把未配置静默升格为强制 adaptive 线 → 载荷被注入 thinking + 删参数
    const body = upstreamBody(makeReq("high"), makeCfg());
    expect(body["thinking"]).toBeUndefined();
    expect(body["output_config"]).toBeUndefined();
    expect(body["temperature"]).toBe(0.7); // 不剥离
    expect(body["top_p"]).toBe(0.9);
    expect(body["max_tokens"]).toBe(100);
    // 显式 null（schema 重置形态）同样不映射
    const bodyNull = upstreamBody(makeReq("high"), makeCfg(null));
    expect(bodyNull["thinking"]).toBeUndefined();
    expect(bodyNull["temperature"]).toBe(0.7);
  });

  it("adaptive 显式 + reasoning_effort=high → thinking:{adaptive} + output_config:{effort:high} + 温度剥离", () => {
    const body = upstreamBody(makeReq("high"), makeCfg("adaptive"));
    expect(body["thinking"]).toEqual({ type: "adaptive" });
    expect(body["output_config"]).toEqual({ effort: "high" });
    expect(body["temperature"]).toBeUndefined();
    expect(body["top_p"]).toBeUndefined();
    // 未映射字段不受影响
    expect(body["max_tokens"]).toBe(100);
  });

  it("off 模式丢弃（现状零回归）", () => {
    const bodyOff = upstreamBody(makeReq("high"), makeCfg("off"));
    expect(bodyOff["thinking"]).toBeUndefined();
    expect(bodyOff["output_config"]).toBeUndefined();
    expect(bodyOff["temperature"]).toBe(0.7); // 不剥离
  });

  it("budget 模式：reasoning_effort 丢弃 + 不输出思考（budget 线只服务 R1 透传）", () => {
    const body = upstreamBody(makeReq("high"), makeCfg("budget"));
    expect(body["thinking"]).toBeUndefined();
    expect(body["output_config"]).toBeUndefined();
  });

  it("非法 thinkingMode（DB 直改绕过 zod enum）→ AdapterError（H6 fail-on-unknown）", () => {
    expect(() => upstreamBody(makeReq("high"), makeCfg("turbo" as string)))
      .toThrow(/Invalid thinkingMode 'turbo'/);
  });

  it("none → 不输出思考（省略）；minimal → effort:low", () => {
    const bodyNone = upstreamBody(makeReq("none"), makeCfg("adaptive"));
    expect(bodyNone["thinking"]).toBeUndefined();
    expect(bodyNone["output_config"]).toBeUndefined();
    expect(bodyNone["temperature"]).toBe(0.7); // 思考未激活不剥离
    const bodyMinimal = upstreamBody(makeReq("minimal"), makeCfg("adaptive"));
    expect(bodyMinimal["output_config"]).toEqual({ effort: "low" });
  });

  it("R1 extras 优先：显式 thinking 存在 → effort 映射跳过", () => {
    const extras = { thinking: { type: "enabled", budget_tokens: 2048 } };
    const body = upstreamBody(makeReq("high", extras), makeCfg("adaptive"));
    // 显式 thinking 逐字保留（R1），effort 未映射
    expect(body["thinking"]).toEqual(extras.thinking);
    expect(body["output_config"]).toBeUndefined();
    expect(body["temperature"]).toBe(0.7); // 映射未触发，不剥离
  });

  it("无 reasoning_effort → 现状零回归（不输出思考、温度保留）", () => {
    const req = makeReq("high");
    delete req.body["reasoning_effort"];
    const body = upstreamBody(req, makeCfg());
    expect(body["thinking"]).toBeUndefined();
    expect(body["output_config"]).toBeUndefined();
    expect(body["temperature"]).toBe(0.7);
  });
});

// ============ 3. admin API：thinking_mode 校验 ============

describe("admin API providers thinking_mode", () => {
  async function adminCookie(): Promise<string> {
    const adminId = await setupUser("r2-admin-effort@test.dev", 0, "admin");
    return sessionCookie(await createSession(adminId));
  }

  it("POST/PATCH/GET：thinking_mode 创建、更新、重置 null、非法值 400", async () => {
    const cookie = await adminCookie();
    const createRes = await selfFetch("http://localhost/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "r2-effort-provider",
        type: "anthropic",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "sk-test-key",
        // 独立模型名：不与端到端用例共享 MODEL（模型路由按 id 升序，共享会跨用例污染 thinkingMode）
        models: { "claude-effort-admin-model": "claude-effort-admin-model" },
        thinkingMode: "adaptive",
      }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      provider: { id: number; thinkingMode: string };
    };
    expect(created.provider.thinkingMode).toBe("adaptive");
    const providerId = created.provider.id;

    // PATCH 更新为 budget
    const patchRes = await selfFetch(`http://localhost/api/providers/${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thinkingMode: "budget" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { provider: { thinkingMode: string } };
    expect(patched.provider.thinkingMode).toBe("budget");

    // PATCH null = 重置为不映射（H3）
    const resetRes = await selfFetch(`http://localhost/api/providers/${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thinkingMode: null }),
    });
    expect(resetRes.status).toBe(200);
    const reset = (await resetRes.json()) as { provider: { thinkingMode: string | null } };
    expect(reset.provider.thinkingMode).toBeNull();

    // GET 列表返回列
    const listRes = await selfFetch("http://localhost/api/providers", {
      headers: { Cookie: cookie },
    });
    const listBody = (await listRes.json()) as {
      items: Array<{ name: string; thinkingMode: string | null }>;
    };
    const listed = listBody.items.find((p) => p.name === "r2-effort-provider");
    expect(listed?.thinkingMode).toBeNull();

    // 非法值 → 400
    const badRes = await selfFetch(`http://localhost/api/providers/${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ thinkingMode: "turbo" }),
    });
    expect(badRes.status).toBe(400);
  });
});

// ============ 4. E2E：/v1/chat/completions reasoning_effort → anthropic 上游 ============

describe("端到端：OpenAI 入站 reasoning_effort → anthropic 上游", () => {
  it("reasoning_effort=high → 上游 output_config:{effort:high} + thinking:{adaptive}（adaptive 显式模式）", async () => {
    const userId = await setupUser("r2-e2e@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAnthropicProviderWithModel(MODEL, "adaptive");
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(
        JSON.stringify({
          id: "msg_r2",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: MODEL,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    // OpenAI 入站（/v1/chat/completions 透传 reasoning_effort）→ 模型路由命中 anthropic provider
    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": plaintext },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const upstream = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(upstream["thinking"]).toEqual({ type: "adaptive" });
    expect(upstream["output_config"]).toEqual({ effort: "high" });
    expect(upstream["temperature"]).toBeUndefined();
  });

  it("off 模式：reasoning_effort 保持丢弃（现状）", async () => {
    const offModel = "claude-effort-off";
    const userId = await setupUser("r2-e2e-off@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAnthropicProviderWithModel(offModel, "off");
    await setupPrice(offModel, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(
        JSON.stringify({
          id: "msg_r2off",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: offModel,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": plaintext },
      body: JSON.stringify({
        model: offModel,
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const upstream = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(upstream["thinking"]).toBeUndefined();
    expect(upstream["output_config"]).toBeUndefined();
  });

  it("缺省（thinking_mode 未配置）→ effort 不映射（H3 零变更契约端到端）", async () => {
    const nullModel = "claude-effort-null";
    const userId = await setupUser("r2-e2e-null@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAnthropicProviderWithModel(nullModel, null);
    await setupPrice(nullModel, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(
        JSON.stringify({
          id: "msg_r2null",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: nullModel,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": plaintext },
      body: JSON.stringify({
        model: nullModel,
        temperature: 0.7,
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const upstream = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(upstream["thinking"]).toBeUndefined();
    expect(upstream["output_config"]).toBeUndefined();
    expect(upstream["temperature"]).toBe(0.7); // 不剥离（零变更契约）
  });
});
