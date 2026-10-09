// 邮箱验证「真发」集成测试（08-27-email-notification AC3/AC4/AC5）：miniflare + stub fetch。
//
// 断言纪律（[[assertion-must-be-effect-not-derived]]）：断言的是**效果**而不是「返回值符合推导」——
//   - AC3/AC4 的成功侧：从**出站请求体**里抠出链接再用它打通 verify-email（链接真的可用，
//     而不是「正文里有 http 字样」）；用户确实入库 + 拿到会话 cookie；
//   - AC3 的失败侧：用户**仍未验证**（不是只看状态码）；并且出站尝试**确实发生过**
//     （否则「通道压根没开」也会让这条用例变绿，是假绿）；
//   - AC5：同一 stub 计数横跨开/关两态做**成对断言**（验「一起漂移」的方向），且关闭态用
//     手工 token 证明「无赠金」不是因为验证没发生。
import { env } from "cloudflare:test";
import { createEmailVerificationToken } from "better-auth/api";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db";
import { inviteCodes, users } from "../src/db/schema";
import {
  applyMigrations,
  countTxByType,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
  withSwitch,
} from "./helpers";

// Better Auth formCsrfMiddleware 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";
/** 测试用 Resend key（假值；真实 key 只存在于 .dev.vars / secret put）。 */
const TEST_RESEND_KEY = "re_test_key";

let ADMIN_ID = 0;
let inviteSeq = 0;

beforeAll(async () => {
  await applyMigrations();
  ADMIN_ID = await setupUser("mail-admin@test.dev", 0, "admin");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface OutboundMail {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** 用 canned Resend 响应替换全局 fetch，返回出站记录（空数组 = 零出站请求）。 */
function stubResend(respond: () => Response): OutboundMail[] {
  const calls: OutboundMail[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const captured: OutboundMail = {
        url: String(input),
        authorization: headers.get("Authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(captured);
      return respond();
    }),
  );
  return calls;
}

function resendAccepted(): Response {
  return new Response(JSON.stringify({ id: "resend-msg-id" }), { status: 200 });
}

/** 从邮件 html 里抠出验证链接（取第一个 href）——「链接真的在信里」的判别点。 */
function extractVerifyUrl(html: unknown): string {
  const match = /href="([^"]+)"/.exec(String(html));
  const url = match?.[1];
  if (url === undefined) {
    throw new Error("verification link not found in email html");
  }
  return url;
}

/** 出站请求体里的 token（断言它是**真 token** 而非占位：能打通 verify-email）。 */
function tokenFromLink(link: string): string {
  const token = new URL(link).searchParams.get("token");
  if (token === null || token === "") {
    throw new Error(`no token in verification link: ${link}`);
  }
  return token;
}

/** 走邮件里的链接完成验证（指向 worker 的真实端点；不复用链接的 host —— 邮件用的是 baseURL）。 */
async function clickVerifyLink(link: string): Promise<Response> {
  return selfFetch(
    `http://localhost/api/auth/verify-email?token=${encodeURIComponent(tokenFromLink(link))}`,
  );
}

async function insertInvite(): Promise<string> {
  const db = createDb(env);
  inviteSeq += 1;
  const code = `MAILTEST${String(inviteSeq).padStart(2, "0")}`;
  await db.insert(inviteCodes).values({
    code,
    createdBy: ADMIN_ID,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return code;
}

/** 走真实注册端点建号（带邀请码），返回自增 id 与响应。 */
async function signUp(email: string): Promise<{ res: Response; userId: number }> {
  const inviteCode = await insertInvite();
  const res = await selfFetch("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: email.split("@")[0] ?? email,
      inviteCode,
    }),
  });
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  });
  if (!row) {
    throw new Error(`signup did not create user ${email} (status ${res.status})`);
  }
  return { res, userId: row.id };
}

async function userRow(userId: number) {
  const db = createDb(env);
  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!row) {
    throw new Error("user not found");
  }
  return row;
}

/** 交互式重发：POST /api/auth/send-verification-email（已登录分支）。 */
async function resendVerification(email: string, cookie: string): Promise<Response> {
  return selfFetch("http://localhost/api/auth/send-verification-email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ email, callbackURL: "/dashboard" }),
  });
}

describe("AC3 交互式重发：真发出 / 失败可见", () => {
  it("已登录未验证用户 → 出站请求带真实 token 链接，且该链接能完成验证（端点 {status:true}）", async () => {
    const email = "mail-resend@test.dev";
    const { userId } = await signUp(email);
    const outbound = stubResend(resendAccepted);
    const cookie = sessionCookie(await createSession(userId));

    const res = await withSwitch("RESEND_API_KEY", TEST_RESEND_KEY, () =>
      resendVerification(email, cookie),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: true });

    // 出站请求的形状：Resend 端点 + Bearer key + 收件人是本人
    const mail = outbound[0];
    if (!mail) {
      throw new Error("no outbound mail captured");
    }
    expect(outbound).toHaveLength(1);
    expect(mail.url).toBe("https://api.resend.com/emails");
    expect(mail.authorization).toBe(`Bearer ${TEST_RESEND_KEY}`);
    expect(mail.body["to"]).toEqual([email]);

    // 链接是**真 token**：html 与 text 都有，且用它打通 verify-email 后状态真的翻转
    const link = extractVerifyUrl(mail.body["html"]);
    expect(String(mail.body["text"])).toContain(link);
    // 链接指向**真的端点**：baseURL + better-auth 的 basePath（/api/auth，见 src/index.ts
    // `app.route("/api/auth", authRouter)`）。写成 `${baseURL}/verify-email` 会指向 SPA 里
    // 不存在的路由 —— 这条断言就是钉住 baseURL/basePath 拼装，baseURL 配错即红。
    expect(link.startsWith(`${env.BETTER_AUTH_URL}/api/auth/verify-email?token=`)).toBe(true);

    const verify = await clickVerifyLink(link);
    expect(verify.status).toBe(200);
    expect((await userRow(userId)).emailVerified).toBe(true);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(1);
  });

  it("强制 Resend 失败 → 端点返回错误响应，且用户仍未验证（失败必须对用户可见）", async () => {
    const email = "mail-resend-fail@test.dev";
    const { userId } = await signUp(email);
    const outbound = stubResend(
      () =>
        new Response(JSON.stringify({ statusCode: 422, message: "domain_not_verified" }), {
          status: 422,
        }),
    );
    const cookie = sessionCookie(await createSession(userId));

    const res = await withSwitch("RESEND_API_KEY", TEST_RESEND_KEY, () =>
      resendVerification(email, cookie),
    );

    // 效果①：UI 的 error 分支据此点亮（前端不发「已发送」文案）
    const body = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(body).not.toContain('"status":true');

    // 效果②：用户仍然未验证（没有半途写库）
    expect((await userRow(userId)).emailVerified).toBe(false);

    // 判别点：失败来自一次真实出站尝试 —— 否则「通道压根没开」也会让上面两条全绿（假绿）
    expect(outbound).toHaveLength(1);
  });
});

describe("AC4 注册路径：邮件既不阻断注册，也不缺席", () => {
  it("Resend 一定失败 → 注册仍然成功（用户已入库 + 拿到会话 cookie）", async () => {
    const email = "mail-signup-fail@test.dev";
    const outbound = stubResend(
      () => new Response(JSON.stringify({ statusCode: 500, message: "boom" }), { status: 500 }),
    );

    const inviteCode = await insertInvite();
    const res = await withSwitch("RESEND_API_KEY", TEST_RESEND_KEY, () =>
      selfFetch("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password: "testpass123",
          name: "mail signup fail",
          inviteCode,
        }),
      }),
    );

    // 效果①：注册成功且会话已建立（cookie 落头），不是「200 但账号没建」
    expect([200, 201]).toContain(res.status);
    expect(res.headers.get("set-cookie") ?? "").toContain("better-auth.session_token");

    // 效果②：用户确实入库
    const db = createDb(env);
    const row = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true, emailVerified: true },
    });
    expect(row).not.toBeNull();
    expect(row?.emailVerified).toBe(false);

    // 判别点：这次失败来自真实出站尝试（注册路径确实发了信，只是发失败了）
    expect(outbound).toHaveLength(1);
  });

  it("Resend 正常 → 注册即发验证信，信里的链接可完成验证并领到验证赠金", async () => {
    const email = "mail-signup-ok@test.dev";
    const outbound = stubResend(resendAccepted);

    const { userId } = await withSwitch("RESEND_API_KEY", TEST_RESEND_KEY, () => signUp(email));

    const mail = outbound[0];
    if (!mail) {
      throw new Error("no outbound mail captured");
    }
    expect(outbound).toHaveLength(1);
    expect(mail.body["to"]).toEqual([email]);

    const verify = await clickVerifyLink(extractVerifyUrl(mail.body["html"]));
    expect(verify.status).toBe(200);
    expect((await userRow(userId)).emailVerified).toBe(true);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(1);
  });
});

describe("AC5 EMAIL_VERIFICATION_ENABLED 联动（成对断言）", () => {
  it("关闭 → 零出站请求 + 无验证赠金；开启 → 两者同时出现", async () => {
    // 同一个 stub 横跨两态计数：邮件通道（key）两态都开着，唯一的变量是功能总开关
    const outbound = stubResend(resendAccepted);

    const offEmail = "mail-switch-off@test.dev";
    await withSwitch("RESEND_API_KEY", TEST_RESEND_KEY, async () => {
      await withSwitch("EMAIL_VERIFICATION_ENABLED", "false", async () => {
        const { userId } = await signUp(offEmail);

        // 关闭态 = 结构性不发：emailVerification 段整段不配置，sendOnSignUp 一并消失
        expect(outbound).toHaveLength(0);

        // 用**手工 token** 打验证端点：端点恒在、验证本身仍会成功 ——
        // 正好证明「无赠金」不是因为验证没发生（否则这条断言是平凡满足的假绿）
        const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, offEmail);
        const verify = await selfFetch(
          `http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}`,
        );
        expect(verify.status).toBe(200);
        expect((await userRow(userId)).emailVerified).toBe(true);

        expect(await countTxByType(userId, "email_verify_bonus")).toBe(0);
        expect(outbound).toHaveLength(0); // 验证动作本身也不发信
      });
    });

    // 开启态对照（bindings 里 pin 的就是 "true"，上面的 withSwitch 已复原）
    const onEmail = "mail-switch-on@test.dev";
    await withSwitch("RESEND_API_KEY", TEST_RESEND_KEY, async () => {
      const { userId } = await signUp(onEmail);

      expect(outbound).toHaveLength(1); // 注册即发（sendOnSignUp）
      const mail = outbound[0];
      if (!mail) {
        throw new Error("no outbound mail captured");
      }
      const verify = await clickVerifyLink(extractVerifyUrl(mail.body["html"]));
      expect(verify.status).toBe(200);
      expect(await countTxByType(userId, "email_verify_bonus")).toBe(1);
    });
  });
});
