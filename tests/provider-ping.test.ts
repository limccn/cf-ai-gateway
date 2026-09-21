// 批次 O（2026-09-21）：POST /api/providers/:id/ping 联通性检查。
//
// 口径（PRD 裁决 D14）：打 `new URL(baseUrl).origin + "/"`，method **HEAD**，
// **不带任何凭据/头/体**；收到**任何** HTTP 回应（含 401/403/404）即算「联通」。
// 与批次 N 的协议探测是**两个谓词**：`reachable`（收到任何 HTTP 回应）≠ `ok`（2xx）——
// 本文件的判别点主要就守着这条缝。
//
// ⚠ **夹具不许退化（判别力的来源）**：baseUrl 必须**带端口 + 路径 + query**
// （`https://upstream.example:8443/v1?tenant=acme`）。若写成 `https://upstream.example`，
// 则「打 origin」与「打 baseUrl」**不可区分** —— 整组 URL 断言退化成恒真假绿
// （同 provider-test-probe.test.ts 文件头那条「候选值两两不等」的教训）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { encryptSecret } from "../src/lib/security";
import { runPing } from "../src/routes/providers/lib/ping";
import {
  applyMigrations,
  clearKv,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

const INTERNAL_MODEL = "gpt-4o-mini";
const UPSTREAM_MODEL = "gpt-4o-mini-2024-07-18";

/** 带端口 + 路径 + query：让「origin 根」与「baseUrl」两两可判别（见文件头）。 */
const BASE_URL = "https://upstream.example:8443/v1?tenant=acme";
const PING_URL = "https://upstream.example:8443/";

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
  // 用 `string` 而不写 `RequestRedirect`：本仓库测试侧 tsconfig 走 workers-types（无 DOM lib），
  // 那个 DOM 类型名取不到。断言只做字符串比较，`"manual"` 这个字面量才是判据。
  redirect: string | undefined;
}

/** 伪造上游：记录 URL / 方法 / 头 / 体 / redirect 模式，按调用分派响应。 */
function stubUpstream(
  responder: (call: RecordedCall) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : String(init.body),
        redirect: init?.redirect,
      };
      calls.push(call);
      return responder(call);
    }),
  );
  return calls;
}

function respond(status: number, statusText: string, body = ""): Response {
  return new Response(body, { status, statusText });
}

/** 永不 resolve，只在 abort 时 reject —— 与 fetchUpstream 的 AbortController 语义一致。 */
function stubHanging(): void {
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
}

interface PingBody {
  success: true;
  timeoutMs: number;
  ping: {
    url: string | null;
    reachable: boolean;
    status: number | null;
    statusText: string | null;
    ttfbMs: number;
    totalMs: number;
    error: string | null;
  };
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

function postPing(cookie: string, id: unknown): Promise<Response> {
  return selfFetch(`http://localhost/api/providers/${String(id)}/ping`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
}

function runTest(cookie: string, id: unknown): Promise<Response> {
  return selfFetch(`http://localhost/api/providers/${String(id)}/test`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
}

function baseProvider(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: "openai",
    baseUrl: BASE_URL,
    apiKey: "sk-ping-secret",
    models: { [INTERNAL_MODEL]: UPSTREAM_MODEL },
    ...extra,
  };
}

describe("批次 O：POST /api/providers/:id/ping", () => {
  it("打的是 **origin 根**（不是 baseUrl）、HEAD、redirect manual、不发 body", async () => {
    const cookie = await adminCookie("o-ping-shape@test.dev");
    const provider = await createProvider(cookie, baseProvider("o-ping-shape"));
    const calls = stubUpstream(() => respond(200, "OK"));

    const res = await postPing(cookie, provider["id"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PingBody;

    // 判别性最强的一条：带 /v1?tenant=acme 的 baseUrl 必须被剥成 origin + "/"。
    // 打 baseUrl（带 /v1?…）、打 `${baseUrl}/`、打不带尾斜杠的 origin —— 三种错误实现各给不同串。
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(PING_URL);
    expect(calls[0]?.method).toBe("HEAD");
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.redirect).toBe("manual");
    expect(body.ping.url).toBe(PING_URL);
    expect(body.ping.reachable).toBe(true);
    expect(body.ping.status).toBe(200);
    expect(body.ping.error).toBeNull();
    // 只发一个请求就够：ping 不是「三条并行」那套
    expect(body.ping.ttfbMs).toBe(body.ping.totalMs);
  });

  it("不带任何凭据、也不套 httpOptions —— 并用同 provider 的 /test 做反向对照", async () => {
    const cookie = await adminCookie("o-ping-nocred@test.dev");
    const provider = await createProvider(
      cookie,
      baseProvider("o-ping-nocred", {
        apiKey: "sk-must-not-leak-9999",
        httpOptions: {
          userAgent: "PingAgent/1.0",
          headers: { "X-Tenant": "acme" },
          body: { temperature: 0 },
        },
      }),
    );
    const calls = stubUpstream(() => respond(200, "OK"));

    const pingRaw = await (await postPing(cookie, provider["id"])).text();
    const pingCall = calls[0];

    // ping：一个头都不带（连 User-Agent 都不加 —— 口径是「不带任何凭据/头」）
    expect(pingCall?.headers).toEqual({});
    expect(pingCall?.body).toBeUndefined();
    expect(pingCall?.url).not.toContain("sk-must-not-leak-9999");
    expect(pingRaw).not.toContain("sk-must-not-leak-9999");
    // .origin 顺带剥掉 path/query/userinfo ⇒ 响应里不该出现 baseUrl 的 query
    expect(pingRaw).not.toContain("tenant=acme");
    expect(pingRaw).not.toContain("X-Tenant");

    // **反向对照**（否则「headers 为空」在 stub 记不到头时也是绿的 = 恒真假绿）：
    // 同一个 provider 的协议探测**确实**带凭据与 httpOptions —— 证明记录器工作正常，
    // 且证明「ping 不带凭据」是实现的选择而不是夹具的失明。
    calls.length = 0;
    const testRes = await runTest(cookie, provider["id"]);
    expect(testRes.status).toBe(200);
    expect(calls.length).toBe(3);
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer sk-must-not-leak-9999");
    expect(calls[0]?.headers["X-Tenant"]).toBe("acme");
    expect(calls[0]?.body).toContain("temperature");
  });

  it("**任何** HTTP 回应都算联通：401 / 403 / 404 / 500 逐条 reachable=true 且回传真实状态", async () => {
    const cookie = await adminCookie("o-ping-anyresp@test.dev");
    const provider = await createProvider(cookie, baseProvider("o-ping-anyresp"));

    for (const [status, statusText] of [
      [401, "Unauthorized"],
      [403, "Forbidden"],
      [404, "Not Found"],
      [500, "Internal Server Error"],
    ] as const) {
      const calls = stubUpstream(() => respond(status, statusText));
      const res = await postPing(cookie, provider["id"]);
      const body = (await res.json()) as PingBody;

      // 若实现写成 `reachable = resp.ok`，这四条**全红** —— 这是本功能最容易被写错的一行。
      expect(body.ping.reachable).toBe(true);
      expect(body.ping.status).toBe(status);
      expect(body.ping.statusText).toBe(statusText);
      // 「上游拒绝了这次调用」不是失败：错误字段必须干净（别把 401 说成 error）
      expect(body.ping.error).toBeNull();
      expect(body.ping.ttfbMs).toBe(body.ping.totalMs);
      expect(calls[0]?.url).toBe(PING_URL);
    }
  });

  it("302 不跟随（redirect: manual）：origin 答了 3xx 就是联通", async () => {
    const cookie = await adminCookie("o-ping-redirect@test.dev");
    const provider = await createProvider(cookie, baseProvider("o-ping-redirect"));
    stubUpstream(() => respond(302, "Found"));

    const body = (await (await postPing(cookie, provider["id"])).json()) as PingBody;
    // 跟随跳转会把「本 origin 明明答了」判成不可达（假阴性），且会去回答**另一个** host 的可达性
    expect(body.ping.reachable).toBe(true);
    expect(body.ping.status).toBe(302);
  });

  it("网络层失败：reachable=false + status 为 null + 两个耗时取同一个数", async () => {
    const cookie = await adminCookie("o-ping-netfail@test.dev");
    const provider = await createProvider(cookie, baseProvider("o-ping-netfail"));
    stubUpstream(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const body = (await (await postPing(cookie, provider["id"])).json()) as PingBody;
    expect(body.ping.reachable).toBe(false);
    expect(body.ping.status).toBeNull();
    expect(body.ping.statusText).toBeNull();
    expect(body.ping.error).toContain("ECONNREFUSED");
    // ping 的这条不变式与 probe 同形（UI 赖它分派「TTFB」与「Elapsed」）
    expect(body.ping.ttfbMs).toBe(body.ping.totalMs);
    // 失败时 url 仍是**打到哪**的证据（与「非法 baseUrl」的 url:null 区分开）
    expect(body.ping.url).toBe(PING_URL);
  });

  it("baseUrl 非法：回 200 + reachable=false + url 为 null（输入问题不是服务端故障），且**一次 fetch 都没发**", async () => {
    const cookie = await adminCookie("o-ping-badurl@test.dev");
    const calls = stubUpstream(() => respond(200, "OK"));

    // ① 非 http(s) 协议：`z.string().url()` 放行 ftp://（实测），workerd 的 fetch 对它会抛
    //    一句没有指向性的英文 —— 故实现必须在**发请求之前**就点名协议。
    const ftp = await createProvider(cookie, baseProvider("o-ping-ftp", { baseUrl: "ftp://files.example/x" }));
    const ftpBody = (await (await postPing(cookie, ftp["id"])).json()) as PingBody;
    expect(ftpBody.ping.reachable).toBe(false);
    expect(ftpBody.ping.url).toBeNull();
    expect(ftpBody.ping.error).toContain("Unsupported URL scheme");

    // ② 根本解析不出 URL 的串：API 层拦得住（z.string().url()），但 DB 可被直改
    const db = createDb(env);
    const [broken] = await db
      .insert(providers)
      .values({
        name: "o-ping-broken-url",
        type: "openai",
        baseUrl: "upstream.example/v1",
        apiKeyEnc: await encryptSecret("sk-ping-secret", env.GATEWAY_SECRET_KEY),
        models: JSON.stringify({ [INTERNAL_MODEL]: UPSTREAM_MODEL }),
      })
      .returning();
    expect(broken).toBeTruthy();
    const brokenBody = (await (await postPing(cookie, broken?.id)).json()) as PingBody;
    expect(brokenBody.ping.reachable).toBe(false);
    expect(brokenBody.ping.url).toBeNull();
    expect(brokenBody.ping.error).toContain("not a valid absolute URL");
    await db.delete(providers).where(eq(providers.id, broken?.id ?? 0));

    // 判别点：只断言 reachable=false 的话，「先 fetch 再失败」的实现照样绿
    expect(calls.length).toBe(0);
  });

  it("超时是**扁平 10s**：provider 配 1s / 配 600s / 不配，三条分支都报 10000", async () => {
    const cookie = await adminCookie("o-ping-timeout@test.dev");
    // 1s 那条是**判别性**的：min(配置, 上限) 的实现会在这里报 1000，
    // 而 600s / 不配两条分支 min() 与扁平值恰好都是 10000（只喂那两条会漏掉这个变异）。
    const cases = [
      { name: "o-ping-cap-1s", upstreamTimeoutMs: 1_000 },
      { name: "o-ping-cap-600s", upstreamTimeoutMs: 600_000 },
      { name: "o-ping-cap-default", upstreamTimeoutMs: undefined },
    ];
    stubUpstream(() => respond(200, "OK"));

    for (const { name, upstreamTimeoutMs } of cases) {
      const provider = await createProvider(
        cookie,
        baseProvider(name, upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs }),
      );
      const body = (await (await postPing(cookie, provider["id"])).json()) as PingBody;
      expect(body.timeoutMs).toBe(10_000);
      expect(body.ping.reachable).toBe(true);
    }
  });

  it("超时**行为**（函数级，快）：预算小于上游回应时间即判不可达，够长则可达", async () => {
    // 300ms 才回的 origin：150ms 预算会 abort，600ms 预算能拿到 —— 一对对照，
    // 证明「预算」真的是行为参数而不是只回显的数字。
    const slow = () =>
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              const t = setTimeout(() => resolve(respond(200, "OK")), 300);
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(t);
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                reject(err);
              });
            }),
        ),
      );

    slow();
    const tooShort = await runPing(PING_URL, 150);
    expect(tooShort.reachable).toBe(false);
    expect(tooShort.status).toBeNull();
    expect(tooShort.error).toBe("Timed out after 150ms");

    slow();
    const enough = await runPing(PING_URL, 600);
    expect(enough.reachable).toBe(true);
    expect(enough.status).toBe(200);
  });

  it("超时路径：挂住的连接按预算报超时（与探测同一套文案）", async () => {
    const cookie = await adminCookie("o-ping-hang@test.dev");
    const provider = await createProvider(cookie, baseProvider("o-ping-hang"));
    stubHanging();

    const body = (await (await postPing(cookie, provider["id"])).json()) as PingBody;
    expect(body.ping.reachable).toBe(false);
    expect(body.ping.status).toBeNull();
    // 文案与协议探测的网络分支共用 describeFetchFailure（同一故障必须读起来一模一样）
    expect(body.ping.error).toBe("Timed out after 10000ms");
    expect(body.ping.ttfbMs).toBe(body.ping.totalMs);
  }, 15_000);

  it("**不解密 provider 密钥**：密钥坏掉时 /ping 照样回答联通，而 /test 500（成对断言）", async () => {
    const cookie = await adminCookie("o-ping-nokey@test.dev");
    const provider = await createProvider(cookie, baseProvider("o-ping-nokey"));
    // 把密文改成解不开的串（decryptSecret 对非法格式抛错）
    const db = createDb(env);
    await db
      .update(providers)
      .set({ apiKeyEnc: "not-a-valid-ciphertext" })
      .where(eq(providers.id, Number(provider["id"])));
    stubUpstream(() => respond(200, "OK"));

    // 单看任一条都不判别 —— 两条必须成对：
    const pingRes = await postPing(cookie, provider["id"]);
    expect(pingRes.status).toBe(200);
    expect(((await pingRes.json()) as PingBody).ping.reachable).toBe(true);

    const testRes = await runTest(cookie, provider["id"]);
    expect(testRes.status).toBe(500);
    expect(await testRes.text()).toContain("Upstream provider key decryption failed");
  });

  it("不读 models / httpOptions：无模型映射的 provider 照样能 ping（/test 才 400）", async () => {
    const cookie = await adminCookie("o-ping-nomodels@test.dev");
    const db = createDb(env);
    const [empty] = await db
      .insert(providers)
      .values({
        name: "o-ping-empty-models",
        type: "openai",
        baseUrl: BASE_URL,
        apiKeyEnc: await encryptSecret("sk-ping-secret", env.GATEWAY_SECRET_KEY),
        models: "{}",
      })
      .returning();
    expect(empty).toBeTruthy();
    stubUpstream(() => respond(200, "OK"));

    const pingRes = await postPing(cookie, empty?.id);
    expect(pingRes.status).toBe(200);
    expect(((await pingRes.json()) as PingBody).ping.reachable).toBe(true);

    // 对照：同一条 provider 走协议探测就必须 400（它确实需要模型名）
    expect((await runTest(cookie, empty?.id)).status).toBe(400);
    await db.delete(providers).where(eq(providers.id, empty?.id ?? 0));
  });

  it("**故意不门控**：没先 ping 也能直接跑协议探测（契约不变，钉住这条边界）", async () => {
    const cookie = await adminCookie("o-ping-nogate@test.dev");
    const provider = await createProvider(cookie, baseProvider("o-ping-nogate"));
    stubUpstream(() => respond(200, "OK"));

    // 先 ping 后探测是 **UI 编排**（PRD 裁决 D16），服务端不做门控 —— 本用例是故意的：
    // 后人若「顺手补个门控」，这里会红，从而被迫回到 PRD 而不是打断 API 用法。
    const res = await runTest(cookie, provider["id"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { probes: unknown[] };
    expect(body.probes.length).toBe(3);
  });

  it("无副作用：不写断路器、不回显密钥、不 invalidate 任何东西", async () => {
    const cookie = await adminCookie("o-ping-sideeffect@test.dev");
    const provider = await createProvider(cookie, baseProvider("o-ping-sideeffect"));
    stubUpstream(() => respond(503, "Service Unavailable", "upstream exploded"));
    await clearKv();

    const raw = await (await postPing(cookie, provider["id"])).text();
    const body = JSON.parse(raw) as PingBody;

    expect(body.ping.reachable).toBe(true); // 503 也是「连上了」
    const listed = await env.CACHE_KV.list({ prefix: "circuit:" });
    expect(listed.keys).toEqual([]);
    expect(raw).not.toContain("sk-ping-secret");
  });

  it("鉴权与入参：member 403、未知 id 404", async () => {
    const memberId = await setupUser("o-ping-member@test.dev", 0, "member");
    const memberCookie = sessionCookie(await createSession(memberId));
    const admin = await adminCookie("o-ping-guards@test.dev");
    const provider = await createProvider(admin, baseProvider("o-ping-guards"));
    stubUpstream(() => respond(200, "OK"));

    expect((await postPing(memberCookie, provider["id"])).status).toBe(403);
    expect((await postPing(admin, 999_999)).status).toBe(404);
  });
});
