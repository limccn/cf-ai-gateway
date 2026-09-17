// 修改密码测试（09-17-change-password，design §6.2）。
//
// 本文件钉的是**服务端契约**，重点是「仅邮箱注册用户」这条约束的**服务端锁**，而不是 UI 隐藏：
// OAuth 形态的用户（无凭据账号）必须被库以 400 CREDENTIAL_ACCOUNT_NOT_FOUND 结构性拒绝 ——
// 否则「只对邮箱用户生效」就只是前端的一层窗户纸。
//
// 密码的验证一律走真实登录端点（POST /api/auth/sign-in/email），不调内部哈希函数：
// 用户能/不能登录才是这条 AC 的实际含义，比比对哈希更接近事实。
//
// 刻意不覆盖：前端拦截（空字段/长度/两次不一致时不发请求）、错误码→文案映射、区块可见性 ——
// 仓库 app/ 下无前端测试基建（既有惯例，同 tests/profile.test.ts），由 Playwright 覆盖。
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { accounts, inviteCodes, sessions, users } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

// Better Auth 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";
const OLD_PASSWORD = "oldpass123";
const NEW_PASSWORD = "newpass456";

beforeAll(async () => {
  await applyMigrations();
});

let inviteSeq = 0;
let inviterId = 0;
async function insertInvite(): Promise<string> {
  const db = createDb(env);
  if (inviterId === 0) {
    inviterId = await setupUser("cp-inviter@test.dev", 0, "admin");
  }
  inviteSeq += 1;
  const code = `CPTEST${String(inviteSeq).padStart(2, "0")}`;
  await db.insert(inviteCodes).values({
    code,
    createdBy: inviterId,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return code;
}

/** 走真实注册端点建一个**邮箱注册**用户（库写入真实哈希）。 */
async function signUpUser(email: string, password = OLD_PASSWORD): Promise<number> {
  const inviteCode = await insertInvite();
  const res = await selfFetch("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: email.split("@")[0] ?? email, inviteCode }),
  });
  expect(res.status).toBe(200);
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  });
  if (!row) {
    throw new Error(`signup did not create user ${email}`);
  }
  return row.id;
}

/** POST /api/auth/change-password（cookie 省略 = 未登录）。 */
async function changePassword(
  cookie: string | undefined,
  body: unknown,
): Promise<{ status: number; json: unknown; setCookie: string | null }> {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    "Content-Type": "application/json",
  };
  if (cookie !== undefined) {
    headers.Cookie = cookie;
  }
  const res = await selfFetch("http://localhost/api/auth/change-password", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  // 响应里带**两条** better-auth.session_token：先一条作废旧会话，后一条才是换发的新会话。
  // res.headers.get("set-cookie") 会把两条用 ", " 拼成一条字符串，取"第一个匹配"会拿到
  // 刚被作废的那个 —— 必须取最后一条。
  const issued = (res.headers.getSetCookie?.() ?? []).filter((c) =>
    c.startsWith("better-auth.session_token="),
  );
  return { status: res.status, json, setCookie: issued.at(-1) ?? null };
}

/** 用某个 cookie 调 GET /api/auth/get-session；返回登录用户的邮箱（未登录 = null）。 */
async function sessionEmail(cookie: string): Promise<string | null> {
  const res = await selfFetch("http://localhost/api/auth/get-session", {
    headers: { Origin: ORIGIN, Cookie: cookie },
  });
  const body = (await res.json().catch(() => null)) as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

function errorCode(json: unknown): string {
  if (typeof json !== "object" || json === null) {
    return "";
  }
  const code = (json as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/** 真实登录：返回 HTTP 状态（200 = 凭据有效）。 */
async function signIn(email: string, password: string): Promise<number> {
  const res = await selfFetch("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  // 消耗掉 body，避免悬挂
  await res.text();
  return res.status;
}

async function passwordHash(userId: number): Promise<string | null> {
  const db = createDb(env);
  const row = await db.query.accounts.findFirst({
    where: and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")),
    columns: { password: true },
  });
  return row?.password ?? null;
}

async function sessionCount(userId: number): Promise<number> {
  const db = createDb(env);
  const rows = await db.query.sessions.findMany({
    where: eq(sessions.userId, userId),
    columns: { id: true },
  });
  return rows.length;
}

describe("POST /api/auth/change-password", () => {
  it("正向链路：改密码 → 哈希改变，旧密码登录失败、新密码登录成功", async () => {
    const email = "cp-happy@test.dev";
    const userId = await signUpUser(email);
    const before = await passwordHash(userId);
    expect(before).not.toBeNull();
    expect(await signIn(email, OLD_PASSWORD)).toBe(200);

    const { status } = await changePassword(sessionCookie(await createSession(userId)), {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(status).toBe(200);

    // 哈希确实换了（而不是"接口返回 200 但什么都没做"）
    const after = await passwordHash(userId);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);

    // AC1 的实质判据：旧密码不能再登录，新密码可以
    expect(await signIn(email, OLD_PASSWORD)).not.toBe(200);
    expect(await signIn(email, NEW_PASSWORD)).toBe(200);
  });

  it("AC4：当前密码错误 → 400 INVALID_PASSWORD，且哈希未变（旧密码仍可登录）", async () => {
    const email = "cp-wrong@test.dev";
    const userId = await signUpUser(email);
    const before = await passwordHash(userId);

    const { status, json } = await changePassword(sessionCookie(await createSession(userId)), {
      currentPassword: "definitely-not-the-password",
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(status).toBe(400);
    expect(errorCode(json)).toBe("INVALID_PASSWORD");

    expect(await passwordHash(userId)).toBe(before);
    expect(await signIn(email, OLD_PASSWORD)).toBe(200);
    expect(await signIn(email, NEW_PASSWORD)).not.toBe(200);
  });

  it("AC2 的服务端锁：无凭据账号的用户（OAuth 形态）→ 400 CREDENTIAL_ACCOUNT_NOT_FOUND", async () => {
    // setupUser 只插 users 行；这里补一条 GitHub 形态的 account（password 为 null），
    // 与真实 OAuth 建号的落库形状一致。
    const userId = await setupUser("cp-oauth@test.dev", 0);
    const db = createDb(env);
    await db.insert(accounts).values({
      issuer: "github",
      accountId: "gh-99999",
      providerId: "github",
      userId,
      password: null,
    });

    const { status, json } = await changePassword(sessionCookie(await createSession(userId)), {
      currentPassword: "anything-at-all",
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    // 「仅邮箱注册用户」在服务端结构性成立 —— 不依赖前端有没有把入口藏起来
    expect(status).toBe(400);
    expect(errorCode(json)).toBe("CREDENTIAL_ACCOUNT_NOT_FOUND");
  });

  it("新密码短于下限 → 400 PASSWORD_TOO_SHORT（与前端拦截同口径）", async () => {
    const email = "cp-short@test.dev";
    const userId = await signUpUser(email);
    const before = await passwordHash(userId);

    const { status, json } = await changePassword(sessionCookie(await createSession(userId)), {
      currentPassword: OLD_PASSWORD,
      newPassword: "short",
      revokeOtherSessions: true,
    });
    expect(status).toBe(400);
    expect(errorCode(json)).toBe("PASSWORD_TOO_SHORT");
    expect(await passwordHash(userId)).toBe(before);
  });

  it("AC5/AC6：revokeOtherSessions → 其他会话被删，当前设备换发的新会话仍可用", async () => {
    const email = "cp-sessions@test.dev";
    const userId = await signUpUser(email);

    // 「当前设备」= 发起改密码的会话；另造一个「其他设备」
    const thisDevice = sessionCookie(await createSession(userId));
    const otherDevice = sessionCookie(await createSession(userId));
    // 注册端点会自动登录并落一条会话，所以这里是 3 而不是 2 —— 那条也在本次撤销范围内
    expect(await sessionCount(userId)).toBe(3);

    const { status, setCookie } = await changePassword(thisDevice, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(status).toBe(200);

    // 库的语义是「删除该用户**全部**会话 → 新建一个 → setSessionCookie」（design §2.2）。
    // 所以落库只剩换发的那一条 —— 连注册时自动登录的那条也一并作废。
    expect(await sessionCount(userId)).toBe(1);
    expect(setCookie).not.toBeNull();

    // AC5：其他设备被踢出
    expect(await sessionEmail(otherDevice)).toBeNull();
    // 连发起方自己的旧 cookie 也失效 —— 这正是 R-1 的由来：当前设备靠响应下发的新 cookie
    // 继续在线，浏览器会自动换上它；客户端 session store 若仍持旧 token 就会表现为掉线。
    expect(await sessionEmail(thisDevice)).toBeNull();

    // AC6：把响应下发的新 cookie 当作浏览器换上的那个 —— 当前设备仍然在线
    const fresh = /better-auth\.session_token=([^;]+)/.exec(setCookie ?? "")?.[1];
    expect(fresh).toBeTruthy();
    expect(await sessionEmail(`better-auth.session_token=${String(fresh)}`)).toBe(email);
  });

  it("会话边界：不带会话 → 401（sensitiveSessionMiddleware）", async () => {
    const { status } = await changePassword(undefined, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(status).toBe(401);
  });
});
