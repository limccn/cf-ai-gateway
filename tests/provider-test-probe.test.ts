// 批次 N（2026-09-21）：POST /api/providers/:id/test 上游协议探测。
//
// 口径（PRD 裁决 D11）：探的是**上游原生端点**（/chat/completions、/responses、/v1/messages），
// 不是网关出站路径 —— 网关的 Responses 入站会转成 chat 出站，自己从不打上游的 /responses。
// 故本文件的断言分两类：① 三条 URL 各按各的协议规则（含 anthropic baseUrl 带 /v1 时不双拼）；
// ② 路由的**无副作用**契约（不写断路器、不回显密钥）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { encryptSecret } from "../src/lib/security";
import {
  applyMigrations,
  clearKv,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

// ⚠ **夹具不许退化：内部名与上游名必须字面量不同。**
// 首版写成 `{ [MODEL]: MODEL }`（键值同串），于是 `expect(body.model).toBe(MODEL)` 在
// 「取映射的值（正确）」与「取映射的键（错误）」两种实现下**都绿** —— 这是个恒真的假锁。
// 构造性验证：把 pickProbeModel 的 `Object.values(models)[0]` 改成 `Object.keys(models)[0]`，
// 8 条用例**全绿**；而生产后果是上游收到内部别名 → 三条探测全 400/404 → **整片假红**。
// 判别力来自「候选值两两不等」，不是「值非空」——同 [[local-d1-fixture-cleanup-toll]]。
const INTERNAL_MODEL = "gpt-4o-mini";
const UPSTREAM_MODEL = "gpt-4o-mini-2024-07-18";

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * 伪造上游：记录每次调用的 URL / 头 / body，按 URL 分派响应。
 * `fetch` 的 init.headers 在这里恒为普通对象（探测路径自己构造的），故直接读即可。
 */
function stubUpstream(
  responder: (call: RecordedCall) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      calls.push(call);
      return responder(call);
    }),
  );
  return calls;
}

function ok200(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 响应头立刻返回（200），正文先给半截、`ms` 之后**报错**。
 * 造的是「上游明确答复了，但连接在正文中途断掉」——这类失败**有**状态码。
 */
function bodyDiesAfter(ms: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial"'));
      await new Promise((resolve) => setTimeout(resolve, ms));
      controller.error(new Error("connection reset mid-body"));
    },
  });
  return new Response(stream, { status: 200, statusText: "OK" });
}

/**
 * 响应头立刻返回（200），正文给半截后**永不结束**（流不 close、不 error）。
 * 造的是「先发头再挂住」——`fetchUpstream` 的定时器此时已经被 clearTimeout 清掉了。
 */
function bodyNeverEnds(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok"'));
    },
  });
  return new Response(stream, { status: 200, statusText: "OK" });
}

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

function runTest(cookie: string, id: unknown): Promise<Response> {
  return selfFetch(`http://localhost/api/providers/${String(id)}/test`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
}

interface ProbeBody {
  success: true;
  model: string;
  timeoutMs: number;
  probes: Array<{
    protocol: string;
    label: string;
    url: string;
    ok: boolean;
    status: number | null;
    statusText: string | null;
    ttfbMs: number;
    totalMs: number;
    error: string | null;
  }>;
}

describe("批次 N：POST /api/providers/:id/test", () => {
  it("三条协议各打各的原生端点（含 anthropic 的 /v1 去重规则），鉴权头按协议分流", async () => {
    const cookie = await adminCookie("n-probe-urls@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-urls",
      type: "openai",
      // 以 /v1 结尾：chat/responses 直接拼，anthropic 必须只补 /messages（不能变成 /v1/v1/messages）
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    });
    const calls = stubUpstream(() => ok200());

    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProbeBody;

    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://upstream.example/v1/chat/completions",
      "https://upstream.example/v1/messages",
      "https://upstream.example/v1/responses",
    ]);

    // 回传的 url 与实际打的 url 逐条一致（防止「报一个 URL、打另一个」）
    expect(body.probes.map((p) => p.url).sort()).toEqual(calls.map((c) => c.url).sort());

    const byProtocol = new Map(body.probes.map((p) => [p.protocol, p]));
    expect([...byProtocol.keys()].sort()).toEqual([
      "anthropic-messages",
      "openai-chat",
      "openai-responses",
    ]);

    // 鉴权头分流：openai 两条 Bearer，anthropic 一条 x-api-key + version
    const chatCall = calls.find((c) => c.url.endsWith("/chat/completions"));
    const messagesCall = calls.find((c) => c.url.endsWith("/messages"));
    expect(chatCall?.headers["Authorization"]).toBe("Bearer sk-probe-secret");
    expect(messagesCall?.headers["Authorization"]).toBeUndefined();
    expect(messagesCall?.headers["x-api-key"]).toBe("sk-probe-secret");
    expect(messagesCall?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("baseUrl 不带 /v1 时 anthropic 补全为 /v1/messages", async () => {
    const cookie = await adminCookie("n-probe-nov1@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-nov1",
      type: "anthropic",
      baseUrl: "https://api.anthropic.example",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    });
    const calls = stubUpstream(() => ok200());

    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url === "https://api.anthropic.example/v1/messages")).toBe(true);
  });

  it("逐条延迟真实回传：ttfb ≤ total，且总耗时 ≥ 上游延迟（三条并行而非串行）", async () => {
    const cookie = await adminCookie("n-probe-latency@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-latency",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    });
    stubUpstream(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(ok200()), 200);
        }),
    );

    const started = Date.now();
    const res = await runTest(cookie, provider["id"]);
    const wallMs = Date.now() - started;
    const body = (await res.json()) as ProbeBody;

    for (const probe of body.probes) {
      expect(probe.ok).toBe(true);
      expect(probe.ttfbMs).toBeGreaterThanOrEqual(150);
      expect(probe.totalMs).toBeGreaterThanOrEqual(probe.ttfbMs);
    }
    // 串行会是 ~600ms；并行 ~200ms。留足余量以免 CI 抖动误红。
    expect(wallMs).toBeLessThan(450);
  });

  it("非 2xx：ok=false + 回传状态与上游错误消息；网络异常：status 为 null", async () => {
    const cookie = await adminCookie("n-probe-fail@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-fail",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    });
    stubUpstream((call) => {
      if (call.url.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ error: { message: "Invalid API key provided" } }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url.endsWith("/responses")) {
        return new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" });
      }
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProbeBody;
    const byProtocol = new Map(body.probes.map((p) => [p.protocol, p]));

    const chat = byProtocol.get("openai-chat");
    expect(chat?.ok).toBe(false);
    expect(chat?.status).toBe(401);
    expect(chat?.error).toBe("Invalid API key provided");

    // 非 JSON 错误页 → 退回状态行（不能把整篇 HTML 塞进 UI）
    const responses = byProtocol.get("openai-responses");
    expect(responses?.ok).toBe(false);
    expect(responses?.status).toBe(502);
    expect(responses?.error).toBe("502 Bad Gateway");

    // 网络层失败没有 HTTP 状态可言
    const messages = byProtocol.get("anthropic-messages");
    expect(messages?.ok).toBe(false);
    expect(messages?.status).toBeNull();
    expect(messages?.error).toContain("ECONNREFUSED");
    // 不变式（UI 赖它分派两个分支）：status === null ⟺ 两个耗时取同一个数。
    // provider-test-dialog 用 `status !== null` 在「TTFB + Total」与「Elapsed」之间二选一，
    // 所以这条一破，UI 上就会出现「没有响应却标着 TTFB」。
    expect(messages?.ttfbMs).toBe(messages?.totalMs);
  });

  it("超时：按 provider 配置的 upstreamTimeoutMs 触发，且实际用的超时随响应回传", async () => {
    const cookie = await adminCookie("n-probe-timeout@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-timeout",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
      upstreamTimeoutMs: 1000,
    });
    // 永不 resolve，只在 abort 时 reject —— 与 fetchUpstream 的 AbortController 语义一致
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );

    const res = await runTest(cookie, provider["id"]);
    const body = (await res.json()) as ProbeBody;

    expect(body.timeoutMs).toBe(1000);
    for (const probe of body.probes) {
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe("Timed out after 1000ms");
    }
  });

  it("超时封顶：provider 配 600s 也只等 30s，默认 60s 同样被封顶 —— 实际用的值随响应回传", async () => {
    const cookie = await adminCookie("n-probe-cap@test.dev");
    // 两条分支各喂一个：显式配了远超上限的值 / 完全不配（走 60s 默认值）。
    // 只喂前者的活，「默认值绕过了封顶」这条路无人看守。
    const cases = [
      { name: "n-probe-cap-explicit", upstreamTimeoutMs: 600_000 },
      { name: "n-probe-cap-default", upstreamTimeoutMs: undefined },
    ];
    for (const { name, upstreamTimeoutMs } of cases) {
      const provider = await createProvider(cookie, {
        name,
        type: "openai",
        baseUrl: "https://upstream.example/v1",
        apiKey: "sk-probe-secret",
        models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
        ...(upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs }),
      });
      stubUpstream(() => ok200());

      const res = await runTest(cookie, provider["id"]);
      const body = (await res.json()) as ProbeBody;
      // 字面量 30000 是**产品决定**（PRD：诊断请求最多等 30s），不是实现的回声 ——
      // 故意不 import PROBE_TIMEOUT_CAP_MS，否则改常量时断言会跟着漂移，封顶就没人守了。
      expect(body.timeoutMs, name).toBe(30_000);
      // 上游秒回 ⇒ 三条都成功：顺带证明这里**没有真等 30s**
      expect(
        body.probes.every((p) => p.ok),
        name,
      ).toBe(true);
    }
  });

  it("响应头到了、正文读失败：报**真实状态码**与已测到的 TTFB，不说成「没有响应」", async () => {
    const cookie = await adminCookie("n-probe-bodyerr@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-bodyerr",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    });
    stubUpstream(() => bodyDiesAfter(150));

    const res = await runTest(cookie, provider["id"]);
    const body = (await res.json()) as ProbeBody;

    for (const probe of body.probes) {
      expect(probe.ok).toBe(false);
      // 上游**答复过**：状态是真的，必须报出来（旧实现把 resp 关在 try 里，catch 拿不到 → null）
      expect(probe.status).toBe(200);
      expect(probe.error).toContain("Response body could not be read");
      expect(probe.error).toContain("connection reset mid-body");
      // TTFB 是**响应头**到达的时刻，不是正文死掉的时刻：这两个数字必须分开，
      // 混成一个「等了 150ms 才知道没有响应」就是把测到的信号扔了。
      expect(probe.ttfbMs).toBeLessThan(100);
      expect(probe.totalMs).toBeGreaterThanOrEqual(120);
    }
  });

  it("响应头到了但正文永不到头：正文读取自带超时（fetchUpstream 的定时器在响应头处就被清了）", async () => {
    const cookie = await adminCookie("n-probe-bodyhang@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-bodyhang",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
      upstreamTimeoutMs: 1000,
    });
    // 关键：fetch **已经 resolve 了**（响应头在），故 fetchUpstream 的 AbortController 已经作废。
    // 没有正文侧的上界时，这条探测会永远挂在 `await resp.text()` 上 —— 弹窗停在
    // 「Probing three protocols…」而 UI 上还印着 timeout 30s。
    stubUpstream(() => bodyNeverEnds());

    const started = Date.now();
    const res = await runTest(cookie, provider["id"]);
    const wallMs = Date.now() - started;
    const body = (await res.json()) as ProbeBody;

    expect(wallMs).toBeLessThan(5000);
    for (const probe of body.probes) {
      expect(probe.ok).toBe(false);
      // 状态码照报（上游答复过），错的是正文
      expect(probe.status).toBe(200);
      expect(probe.error).toContain("body read timed out after 1000ms");
      expect(probe.totalMs).toBeGreaterThanOrEqual(900);
    }
  });

  it("httpOptions 覆盖真的生效（headers 与 body 都进探测请求）", async () => {
    const cookie = await adminCookie("n-probe-httpopts@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-httpopts",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
      httpOptions: {
        userAgent: "ProbeAgent/1.0",
        headers: { "X-Tenant": "acme" },
        body: { temperature: 0 },
      },
    });
    const calls = stubUpstream(() => ok200());

    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(200);

    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.headers["X-Tenant"]).toBe("acme");
      expect(call.headers["User-Agent"]).toBe("ProbeAgent/1.0");
      expect(call.body["temperature"]).toBe(0);
      // 探测用映射表的第一个**值**（上游名），不是键（内部别名）
      expect(call.body["model"]).toBe(UPSTREAM_MODEL);
      // 反向确认：夹具里键确实与值不同（否则上面这条断言分辨不出 values / keys，
      // 就是个恒真的假锁 —— 实测过，把 pickProbeModel 改成 Object.keys 它照样绿）
      expect(INTERNAL_MODEL).not.toBe(UPSTREAM_MODEL);
    }
  });

  it("无副作用：探测失败不写断路器，响应体不含明文密钥", async () => {
    const cookie = await adminCookie("n-probe-sideeffect@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-sideeffect",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-must-not-leak-9999",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    });
    stubUpstream(() => new Response("upstream exploded", { status: 500, statusText: "Server Error" }));
    // 清 KV 后再打：断言的是「本次探测」没写断路器键，不受同文件其他用例残留影响
    await clearKv();

    const res = await runTest(cookie, provider["id"]);
    const raw = await res.text();
    const body = JSON.parse(raw) as ProbeBody;

    expect(body.probes.every((p) => !p.ok)).toBe(true);
    // 断路器键在 CACHE_KV（前缀 `circuit:`）—— 探测绝不能把 provider 踢出生产轮转
    const listed = await env.CACHE_KV.list({ prefix: "circuit:" });
    expect(listed.keys).toEqual([]);
    // 密钥只在 header 里；响应回显的 url 不得携带它
    expect(raw).not.toContain("sk-must-not-leak-9999");
  });

  it("鉴权与入参：member 403、未知 id 404、无模型映射 400", async () => {
    const memberId = await setupUser("n-probe-member@test.dev", 0, "member");
    const memberCookie = sessionCookie(await createSession(memberId));
    const admin = await adminCookie("n-probe-guards@test.dev");
    const provider = await createProvider(admin, {
      name: "n-probe-guards",
      type: "openai",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    });
    stubUpstream(() => ok200());

    expect((await runTest(memberCookie, provider["id"])).status).toBe(403);
    expect((await runTest(admin, 999_999)).status).toBe(404);

    // 映射表空：API 层拦得住（modelsMapSchema 要求非空），但 DB 可被直改 →
    // 探测应明确拒绝而不是拿 undefined 当模型名（密钥是真的，确保走到的是这条分支而非解密失败）
    const db = createDb(env);
    const [empty] = await db
      .insert(providers)
      .values({
        name: "n-probe-empty-models",
        type: "openai",
        baseUrl: "https://upstream.example/v1",
        apiKeyEnc: await encryptSecret("sk-probe-secret", env.GATEWAY_SECRET_KEY),
        models: "{}",
      })
      .returning();
    expect(empty).toBeTruthy();
    const res = await runTest(admin, empty?.id);
    expect(res.status).toBe(400);
    await db.delete(providers).where(eq(providers.id, empty?.id ?? 0));
  });
});
