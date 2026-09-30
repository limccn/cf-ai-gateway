// 批次 6 G2：POST /api/providers/:id/declare-endpoint —— 「声明此端点」人工回写。
//
// 断言分四类（design §6.2 + AC11）：
// ① **AC11 结构不变式**：声明只写 protocols 子对象——除 protocols 外全字段逐键深度相等
//    （比「models/quirk/type 未变」更严：name/weight/httpOptions/… 都在被断言之列）；
// ② **合并语义**：已有面的声明字段保留（重新声明幂等），body 显式给的字段才覆盖；
// ③ **守卫**：member 403 / 未知 id 404 / 非法面 400 / 损坏声明 500 且**不覆写**现有值
//    （声明动作不许把管理员手工写过的面静默洗掉）；
// ④ **解析语义**：声明面完全取代隐式面表（design §2.2 规则 1）——legacy 记录声明一个面后，
//    解析层只剩该面（批次 7 迁移对照的语义锚点）。
// 另有一条**交叉校验**：契约层 PROBE_FACES 字面量与服务端解析真源 PROVIDER_FACES 同值
// （契约层不做运行时 import——会把适配器拖进前端 bundle；两边漂移在这里立刻红）。
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { parseResolvedEndpoints, PROVIDER_FACES } from "../src/providers/endpoints";
import { probeFaceSchema } from "../src/routes/providers/types";
import {
  applyMigrations,
  clearKv,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

async function adminCookie(email: string): Promise<string> {
  const adminId = await setupUser(email, 0, "admin");
  return sessionCookie(await createSession(adminId));
}

async function createProvider(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await selfFetch("http://localhost/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { provider: Record<string, unknown> };
  return json.provider;
}

/** 无 GET /:id 路由 —— 走列表取单条（声明后的断言读这里，不经响应回显的自证）。 */
async function getProvider(
  cookie: string,
  id: unknown,
): Promise<Record<string, unknown>> {
  const res = await selfFetch("http://localhost/api/providers", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { items: Array<Record<string, unknown>> };
  const found = json.items.find((p) => p["id"] === id);
  expect(found, `provider ${String(id)} not in list`).toBeTruthy();
  return found as Record<string, unknown>;
}

/** 「除 protocols 外逐键相等」的比较键：浅拷贝后删键（rest 解构会被 no-unused-vars 拦）。 */
function withoutProtocols(p: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...p };
  delete copy.protocols;
  return copy;
}

function declare(
  cookie: string,
  id: unknown,
  body: Record<string, unknown>,
): Promise<Response> {
  return selfFetch(`http://localhost/api/providers/${String(id)}/declare-endpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe("批次 6：POST /api/providers/:id/declare-endpoint", () => {
  it("交叉校验：契约层 PROBE_FACES 与解析真源 PROVIDER_FACES 同值（两处字面量，双向锁）", () => {
    // 正向：解析真源的每个面都必须被契约层接受
    for (const face of PROVIDER_FACES) {
      expect(probeFaceSchema.safeParse(face).success, face).toBe(true);
    }
    // 反向：契约层的值集不得多出解析真源没有的面（.options 是 zod v4 ZodEnum 的值集）
    expect([...probeFaceSchema.options].sort()).toEqual([...PROVIDER_FACES].sort());
  });

  it("AC11：声明只写 protocols —— 除 protocols 外全字段逐键深度相等；新面为空声明 {}", async () => {
    const cookie = await adminCookie("b6-declare-ac11@test.dev");
    // 夹具带满 quirk 字段（models/thinkingMode/reasoningRoundtrip/upstreamTimeoutMs/httpOptions），
    // 任一被声明动作碰到都会在这里红
    const provider = await createProvider(cookie, {
      name: "b6-declare-ac11",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-declare-secret",
      models: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
      thinkingMode: "off",
      reasoningRoundtrip: true,
      upstreamTimeoutMs: 90_000,
      httpOptions: { userAgent: "DeclareAgent/2.0", body: { temperature: 0.5 } },
    });

    const before = await getProvider(cookie, provider["id"]);
    const res = await declare(cookie, provider["id"], { face: "messages" });
    expect(res.status).toBe(200);
    const after = await getProvider(cookie, provider["id"]);

    // 除 protocols 外逐键深度相等（含 type —— legacy 记录声明不改 type）
    expect(withoutProtocols(after)).toEqual(withoutProtocols(before));

    // 新面 = 空声明 {}：baseUrl 继承主端点、policy 取面默认（「不复制 URL」规则）
    expect(after["protocols"]).toEqual({ messages: {} });

    // 解析语义（批次 7 对照的锚点）：声明面完全取代隐式面表 —— resolved 恰剩 messages 一面
    const resolved = parseResolvedEndpoints({
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      protocols: JSON.stringify(after["protocols"]),
    });
    expect(resolved.map((e) => e.face)).toEqual(["messages"]);
    expect(resolved[0]?.dialect).toBe("anthropic");
  });

  it("合并语义：已有面的声明保留；重新声明幂等（不抹已声明的 baseUrl/policy）", async () => {
    const cookie = await adminCookie("b6-declare-merge@test.dev");
    const provider = await createProvider(cookie, {
      name: "b6-declare-merge",
      type: "custom",
      baseUrl: "https://shared-main.example",
      apiKey: "sk-declare-secret",
      models: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
      protocols: {
        chat: { policy: "convert" },
        messages: { baseUrl: "https://msg-gateway.example/v1", policy: "verbatim" },
      },
    });

    // ① 新面 completions：chat/messages 的声明原样保留
    const res = await declare(cookie, provider["id"], { face: "completions" });
    expect(res.status).toBe(200);
    const first = (await res.json()) as { provider: Record<string, unknown> };
    expect(first.provider["protocols"]).toEqual({
      chat: { policy: "convert" },
      completions: {},
      messages: { baseUrl: "https://msg-gateway.example/v1", policy: "verbatim" },
    });

    // ② 重新声明 messages（body 只带 face）：已有 baseUrl/policy **原样保留**（幂等，
    //    不是把该面重置成 {}——否则一次误点就会丢掉批次 8 逐条实测出来的 baseUrl）
    const res2 = await declare(cookie, provider["id"], { face: "messages" });
    expect(res2.status).toBe(200);
    const second = (await res2.json()) as { provider: Record<string, unknown> };
    expect(second.provider["protocols"]).toEqual({
      chat: { policy: "convert" },
      completions: {},
      messages: { baseUrl: "https://msg-gateway.example/v1", policy: "verbatim" },
    });
  });

  it("显式 baseUrl/policy 只覆盖该面给到的字段，未提到的字段保留", async () => {
    const cookie = await adminCookie("b6-declare-override@test.dev");
    const provider = await createProvider(cookie, {
      name: "b6-declare-override",
      type: "custom",
      baseUrl: "https://shared-main.example",
      apiKey: "sk-declare-secret",
      models: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
      protocols: { messages: { baseUrl: "https://old-gateway.example/v1", policy: "verbatim" } },
    });

    const res = await declare(cookie, provider["id"], { face: "messages", policy: "convert" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: Record<string, unknown> };
    // policy 被覆盖；baseUrl 未提及 ⇒ 保留
    expect(body.provider["protocols"]).toEqual({
      messages: { baseUrl: "https://old-gateway.example/v1", policy: "convert" },
    });
  });

  it("守卫：member 403、未知 id 404、白名单外的面 400", async () => {
    const admin = await adminCookie("b6-declare-guards-admin@test.dev");
    const memberId = await setupUser("b6-declare-guards-member@test.dev", 0, "member");
    const memberCookie = sessionCookie(await createSession(memberId));
    const provider = await createProvider(admin, {
      name: "b6-declare-guards",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-declare-secret",
      models: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
    });

    expect(
      (await declare(memberCookie, provider["id"], { face: "chat" })).status,
    ).toBe(403);
    expect((await declare(admin, 999_999, { face: "chat" })).status).toBe(404);
    expect(
      (await declare(admin, provider["id"], { face: "not-a-face" })).status,
    ).toBe(400);
  });

  it("protocols 损坏（DB 直改绕过校验）⇒ 500 且**不覆写**现有值（不许静默洗掉手工声明）", async () => {
    const cookie = await adminCookie("b6-declare-corrupt@test.dev");
    const db = createDb(env);

    // 变体 ①：非 JSON
    const broken = await createProvider(cookie, {
      name: "b6-declare-corrupt-json",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-declare-secret",
      models: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
    });
    await db
      .update(providers)
      .set({ protocols: "not-even-json" })
      .where(eq(providers.id, Number(broken["id"])));
    expect((await declare(cookie, broken["id"], { face: "chat" })).status).toBe(500);
    const afterBroken = await db.query.providers.findFirst({
      where: eq(providers.id, Number(broken["id"])),
    });
    expect(afterBroken?.protocols).toBe("not-even-json");

    // 变体 ②：合法 JSON 但面键在白名单外（strict zod 拒绝）
    const junk = await createProvider(cookie, {
      name: "b6-declare-corrupt-face",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-declare-secret",
      models: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
    });
    await db
      .update(providers)
      .set({ protocols: JSON.stringify({ bogus: {} }) })
      .where(eq(providers.id, Number(junk["id"])));
    expect((await declare(cookie, junk["id"], { face: "chat" })).status).toBe(500);
    const afterJunk = await db.query.providers.findFirst({
      where: eq(providers.id, Number(junk["id"])),
    });
    expect(afterJunk?.protocols).toBe(JSON.stringify({ bogus: {} }));
  });
});
