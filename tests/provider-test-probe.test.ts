// 批次 N 建（2026-09-21）；批次 6 改**逐面探测**（2026-09-29）——本文件属探测路径本身，
// 断言随行为逐条更新（红线下允许的例外，逐条对应行为变化）。
//
// 口径（批次 6）：探测行 = 解析层 resolved 端点集（parseResolvedEndpoints）——
// legacy 记录按遗留等价面表展开（openai ⇒ chat/completions/embeddings 三行；anthropic ⇒
// chat/messages 两行），custom 记录按声明面逐面一行；每行都是生产可达的 URL，旧行集里的
// responses/anthropic 侦察行已不存在（它们不是该记录生产可达的面）。断言分三类：
// ① 行集与 URL 按解析层规则（含 anthropic /v1 补全、逐面 baseUrl）；
// ② 路由的**无副作用**契约（不写断路器、不回显密钥）；
// ③ AC10 判别性：配错 A 面 baseUrl ⇒ A 行红且 B 行仍绿。
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
// 当时全部用例**全绿**；而生产后果是上游收到内部别名 → 逐面探测全 400/404 → **整片假红**。
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
    face: string;
    dialect: string;
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

describe("批次 6：POST /api/providers/:id/test（逐面探测）", () => {
  it("legacy openai = 隐式面表三行（chat/completions/embeddings），同款 URL 规则与 Bearer 鉴权", async () => {
    const cookie = await adminCookie("n-probe-urls@test.dev");
    const provider = await createProvider(cookie, {
      name: "n-probe-urls",
      type: "openai",
      // 以 /v1 结尾：三面直接拼路径（openaiEndpointUrl 的路径表，与 proxy 出站同一函数）
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    });
    const calls = stubUpstream(() => ok200());

    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProbeBody;

    // 行集 = 解析层 resolved 端点集（legacy 等价面表恰好三面）。旧版行集里的
    // responses/anthropic 侦察行**不许再出现**——它们不是该记录生产可达的面。
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://upstream.example/v1/chat/completions",
      "https://upstream.example/v1/completions",
      "https://upstream.example/v1/embeddings",
    ]);

    // 回传的 url 与实际打的 url 逐条一致（防止「报一个 URL、打另一个」）
    expect(body.probes.map((p) => p.url).sort()).toEqual(calls.map((c) => c.url).sort());

    const byFace = new Map(body.probes.map((p) => [p.face, p]));
    expect([...byFace.keys()].sort()).toEqual(["chat", "completions", "embeddings"]);
    // 方言逐行回传且恒为 openai（防「报一个方言、发另一种头」）
    for (const probe of body.probes) {
      expect(probe.dialect).toBe("openai");
    }

    // 鉴权头：openai 方言 = Bearer（x-api-key 一处都不许出现）
    for (const call of calls) {
      expect(call.headers["Authorization"]).toBe("Bearer sk-probe-secret");
      expect(call.headers["x-api-key"]).toBeUndefined();
    }
  });

  it("legacy anthropic = 两行（chat/messages），同一条 /v1/messages、同款 x-api-key", async () => {
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
    const body = (await res.json()) as ProbeBody;

    // 恰两行：chat 面 + messages 面（生产对 chat 与 messages 两条入站路径打的就是同一端点）
    expect(body.probes.length).toBe(2);
    expect(body.probes.map((p) => p.face).sort()).toEqual(["chat", "messages"]);
    for (const probe of body.probes) {
      expect(probe.dialect).toBe("anthropic");
      // baseUrl 不带 /v1 ⇒ anthropicMessagesUrl 补全为 /v1/messages（不能变成 /v1/v1/messages）
      expect(probe.url).toBe("https://api.anthropic.example/v1/messages");
    }
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://api.anthropic.example/v1/messages",
      "https://api.anthropic.example/v1/messages",
    ]);

    // 鉴权头：anthropic 方言 = x-api-key + version（Bearer 一处都不许出现）
    for (const call of calls) {
      expect(call.headers["x-api-key"]).toBe("sk-probe-secret");
      expect(call.headers["anthropic-version"]).toBe("2023-06-01");
      expect(call.headers["Authorization"]).toBeUndefined();
    }
  });

  it("逐条延迟真实回传：ttfb ≤ total，且总耗时 ≥ 上游延迟（逐行并行而非串行）", async () => {
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
      if (call.url.endsWith("/completions")) {
        return new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" });
      }
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProbeBody;
    const byFace = new Map(body.probes.map((p) => [p.face, p]));

    const chat = byFace.get("chat");
    expect(chat?.ok).toBe(false);
    expect(chat?.status).toBe(401);
    expect(chat?.error).toBe("Invalid API key provided");

    // 非 JSON 错误页 → 退回状态行（不能把整篇 HTML 塞进 UI）
    const completions = byFace.get("completions");
    expect(completions?.ok).toBe(false);
    expect(completions?.status).toBe(502);
    expect(completions?.error).toBe("502 Bad Gateway");

    // 网络层失败没有 HTTP 状态可言
    const embeddings = byFace.get("embeddings");
    expect(embeddings?.ok).toBe(false);
    expect(embeddings?.status).toBeNull();
    expect(embeddings?.error).toContain("ECONNREFUSED");
    // 不变式（UI 赖它分派两个分支）：status === null ⟺ 两个耗时取同一个数。
    // provider-test-dialog 用 `status !== null` 在「TTFB + Total」与「Elapsed」之间二选一，
    // 所以这条一破，UI 上就会出现「没有响应却标着 TTFB」。
    expect(embeddings?.ttfbMs).toBe(embeddings?.totalMs);
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
      // 上游秒回 ⇒ 逐行都成功：顺带证明这里**没有真等 30s**
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
    // 「Probing the declared endpoints…」而 UI 上还印着 timeout 30s。
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

  it("AC10 判别性：配错 A 面 baseUrl ⇒ A 行红且 B 行仍绿（逐面 baseUrl 各打各的）", async () => {
    const cookie = await adminCookie("b6-probe-misconfig@test.dev");
    // 夹具判别力：主端点与两面 baseUrl 三者**两两不同**——任两者相同，下面的断言就分不清
    // 「行 URL 来自面的 baseUrl」还是「偷打主端点」（[[assertion-must-be-effect-not-derived]]）
    const GOOD_BASE = "https://good-face.example/v1";
    const BAD_BASE = "https://bad-face.example/v1";
    expect(new Set([GOOD_BASE, BAD_BASE, "https://shared-main.example"]).size).toBe(3);
    const provider = await createProvider(cookie, {
      name: "b6-probe-misconfig",
      type: "custom",
      baseUrl: "https://shared-main.example",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
      // verbatim 面：面 baseUrl 才参与 URL（convert 一律打主端点——那是解析层主端点规则，
      // 本用例要的正是「两面各打各的 URL」的判别力）
      protocols: {
        chat: { policy: "verbatim", baseUrl: GOOD_BASE },
        completions: { policy: "verbatim", baseUrl: BAD_BASE },
      },
    });
    const calls = stubUpstream((call) =>
      call.url.startsWith("https://good-face.example/")
        ? ok200()
        : new Response("face misconfigured", { status: 503, statusText: "Service Unavailable" }),
    );

    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProbeBody;

    // 声明面完全取代隐式面表：恰好两行（custom 记录没有隐式面，更没有侦察行）
    expect(body.probes.length).toBe(2);
    const byFace = new Map(body.probes.map((p) => [p.face, p]));
    const good = byFace.get("chat");
    const bad = byFace.get("completions");
    // B 行仍绿：URL 由它**自己声明**的 baseUrl 拼出（与主端点无关）
    expect(good?.ok).toBe(true);
    expect(good?.url).toBe("https://good-face.example/v1/chat/completions");
    // A 行红：错的是 A 自己的 baseUrl，不连坐 B
    expect(bad?.ok).toBe(false);
    expect(bad?.status).toBe(503);
    expect(bad?.url).toBe("https://bad-face.example/v1/completions");
    // 实际调用与行 URL 一一对应——没有行偷打主端点（主端点值两两不同，出现即红）
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://bad-face.example/v1/completions",
      "https://good-face.example/v1/chat/completions",
    ]);
  });

  it("custom 记录 protocols 损坏（DB 直改绕过校验）⇒ /test 400 带解析错误，一行都不发", async () => {
    const cookie = await adminCookie("b6-probe-broken@test.dev");
    const provider = await createProvider(cookie, {
      name: "b6-probe-broken",
      type: "custom",
      baseUrl: "https://upstream.example/v1",
      apiKey: "sk-probe-secret",
      models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
      protocols: { chat: { policy: "convert" } },
    });
    const db = createDb(env);
    await db
      .update(providers)
      .set({ protocols: "not-even-json" })
      .where(eq(providers.id, Number(provider["id"])));

    const calls = stubUpstream(() => ok200()); // 若被打到即失败
    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("cannot be resolved");
    // 解析失败先行：一行探测都不该发出去
    expect(calls).toEqual([]);
  });
});
