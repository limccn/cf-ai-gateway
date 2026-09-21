// 账户安全总开关的路由级测试（09-21-email-admin-promotion-switch，prd AC1–AC10）。
//
// 本文件钉的是**写边界的实际行为**，不是「门控函数返回了 true」：
//   - 每条被拒用例都直查 D1，断言 `role` 与 `updated_at` 一行未动（效果断言，非状态码）；
//   - 每条放行用例也都直查 D1（防「返回 200 但没写库」这种反向假绿）。
//
// 夹具 idiom 一律照抄既有文件，不自造：
//   - 邮件注册账户 = 邀请码 + POST /api/auth/sign-up/email（真实注册，库写真实哈希）
//     —— tests/change-password.test.ts 的 insertInvite / signUpUser。
//   - GitHub-only 账户 = setupUser（只插 users 行）+ accounts 一行 providerId='github'
//     —— tests/change-password.test.ts:190 的 OAuth 形态。
//   - 「已是 admin 的邮箱注册账户」= 邮箱注册后 D1 UPDATE role（**不是** SQL INSERT 造用户；
//     与 README 记载的唯一合法 bootstrap 同形）。
//
// 刻意不覆盖：前端置灰行为（无前端测试基建，由 Playwright 探针覆盖，见 prd AC12/AC13）。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { accounts, inviteCodes, users } from "../src/db/schema";
import { ADMIN_PROMOTION_BLOCKED_MESSAGE } from "../src/lib/admin-promotion-policy";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
  withSwitch,
} from "./helpers";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "promo-pass-123";

// 把 updated_at 钉到一个**整秒的旧值**（D1 的 timestamp 列按秒存，带毫秒的 Date 读回来会截断，
// 那会让断言因为精度而不是因为行为失败/通过）。之后任何一次 UPDATE 都会把它刷成「现在」，
// 所以「读回来仍等于这个旧值」是一个**有判别力**的效果断言 —— 不依赖插入与更新是否落在同一秒。
const STALE_UPDATED_AT = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600_000);

beforeAll(async () => {
  await applyMigrations();
});

// ============ 夹具 ============

let inviteSeq = 0;
let inviterId = 0;

/** 邮件注册账户：邀请码 + 真实注册端点（返回 userId）。 */
async function signUpEmailUser(email: string): Promise<number> {
  const db = createDb(env);
  if (inviterId === 0) {
    inviterId = await setupUser("promo-inviter@test.dev", 0, "admin");
  }
  inviteSeq += 1;
  const code = `PROMO${String(inviteSeq).padStart(2, "0")}`;
  await db.insert(inviteCodes).values({
    code,
    createdBy: inviterId,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  const res = await selfFetch("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      name: email.split("@")[0] ?? email,
      inviteCode: code,
    }),
  });
  expect(res.status).toBe(200);
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  });
  if (!row) {
    throw new Error(`signup did not create user ${email}`);
  }
  return row.id;
}

/** 仅 GitHub 形态（无凭据行）。 */
async function githubOnlyUser(email: string): Promise<number> {
  const id = await setupUser(email, 0);
  await createDb(env).insert(accounts).values({
    issuer: "github",
    accountId: `gh-${id}`,
    providerId: "github",
    userId: id,
    password: null,
  });
  return id;
}

/** 邮箱注册账户 + 直接置为 admin（照 README 记载的 bootstrap：D1 UPDATE，不是 INSERT 造用户）。 */
async function emailRegisteredAdmin(email: string): Promise<number> {
  const id = await signUpEmailUser(email);
  await createDb(env).update(users).set({ role: "admin" }).where(eq(users.id, id));
  return id;
}

async function adminCookieFor(email: string): Promise<string> {
  const id = await setupUser(email, 0, "admin");
  return sessionCookie(await createSession(id));
}

async function pinStaleUpdatedAt(id: number): Promise<void> {
  await createDb(env).update(users).set({ updatedAt: STALE_UPDATED_AT }).where(eq(users.id, id));
}

interface DbUserRow {
  role: string;
  status: string;
  updatedAt: Date;
}

async function dbUser(id: number): Promise<DbUserRow> {
  const row = await createDb(env).query.users.findFirst({
    where: eq(users.id, id),
    columns: { role: true, status: true, updatedAt: true },
  });
  if (!row) {
    throw new Error(`user ${id} not found`);
  }
  return row;
}

/** 错误体形状照 src/index.ts 的 onError 统一格式：`{ error: { message } }`。 */
interface PatchBody {
  success?: boolean;
  error?: { message: string };
  user?: { role: string; status: string; emailRegistered: boolean };
}

async function patchUser(
  cookie: string | undefined,
  id: number,
  body: unknown,
): Promise<{ status: number; body: PatchBody }> {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    "Content-Type": "application/json",
  };
  if (cookie !== undefined) {
    headers.Cookie = cookie;
  }
  const res = await selfFetch(`http://localhost/api/users/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as PatchBody };
}

// ============ 开关关闭（部署缺省态：vitest.config.ts pinned "false"）============

describe("开关关闭时的写边界", () => {
  it("AC1 邮件注册 member 提升为 admin → 403，且 D1 里 role/updated_at 一行未动", async () => {
    const cookie = await adminCookieFor("promo-admin-ac1@test.dev");
    const target = await signUpEmailUser("promo-ac1-target@test.dev");
    await pinStaleUpdatedAt(target);

    const { status, body } = await patchUser(cookie, target, { role: "admin" });

    expect(status).toBe(403);
    // 成对断言：常量锁「接线」（API 用的就是这个串），字面量锁「本义」（常量被整体改写时仍红）
    expect(body.error?.message).toBe(ADMIN_PROMOTION_BLOCKED_MESSAGE);
    expect(String(body.error?.message)).toMatch(/cannot be promoted to admin/i);

    const row = await dbUser(target);
    expect(row.role).toBe("member"); // 效果：UPDATE 根本没执行
    expect(row.updatedAt.getTime()).toBe(STALE_UPDATED_AT.getTime()); // 效果：updated_at 未被刷新
  });

  it("AC2 判别性：仅 GitHub 行的 member 提升为 admin → 200 且 D1 确实升为 admin", async () => {
    const cookie = await adminCookieFor("promo-admin-ac2@test.dev");
    const target = await githubOnlyUser("promo-ac2-github@test.dev");

    const { status, body } = await patchUser(cookie, target, { role: "admin" });

    // 缺了这条，AC1 可以被「无条件拒绝」这种错误实现平凡满足
    expect(status).toBe(200);
    expect(body.user?.role).toBe("admin");
    expect(body.user?.emailRegistered).toBe(false); // 响应体判据字段与库中事实一致
    expect((await dbUser(target)).role).toBe("admin");
  });

  it("AC3 方向性：邮件注册账户当前是 admin，降级为 member → 200 且 D1 确实降级", async () => {
    const cookie = await adminCookieFor("promo-admin-ac3@test.dev");
    const target = await emailRegisteredAdmin("promo-ac3-admin@test.dev");
    expect((await dbUser(target)).role).toBe("admin"); // 前置条件成立才谈得上「方向性」

    const { status, body } = await patchUser(cookie, target, { role: "member" });

    expect(status).toBe(200);
    expect(body.user?.role).toBe("member");
    expect(body.user?.emailRegistered).toBe(true); // 是邮箱注册账户，但这次是降级 ⇒ 不受开关约束
    expect((await dbUser(target)).role).toBe("member");
  });

  it("AC4 不误伤：只改 status（不带 role）→ 200 且 D1 确实停用", async () => {
    const cookie = await adminCookieFor("promo-admin-ac4@test.dev");
    const target = await signUpEmailUser("promo-ac4-target@test.dev");

    const { status, body } = await patchUser(cookie, target, { status: "disabled" });

    expect(status).toBe(200);
    expect(body.user?.emailRegistered).toBe(true);
    expect((await dbUser(target)).status).toBe("disabled");
  });

  it("AC7 幂等：邮件注册账户已是 admin，重复写 role=admin → 不因本开关报错", async () => {
    const cookie = await adminCookieFor("promo-admin-ac7@test.dev");
    const target = await emailRegisteredAdmin("promo-ac7-admin@test.dev");

    const { status } = await patchUser(cookie, target, { role: "admin" });

    // 兜底：开关一关，存量的邮箱制 admin 连「重复写一次同样的角色」都不该失败
    expect(status).toBe(200);
    expect((await dbUser(target)).role).toBe("admin");
  });

  it("AC8 优先级：未知 id → 404（不是 403）", async () => {
    const cookie = await adminCookieFor("promo-admin-ac8@test.dev");
    const { status, body } = await patchUser(cookie, 999_999, { role: "admin" });
    expect(status).toBe(404);
    expect(body.error?.message).toBe("User not found");
  });

  it("AC8 优先级：admin 自降级 → 400 Self-guard（先于新 403；调用者本身是邮箱注册账户）", async () => {
    // 让调用者**也是**邮箱注册账户：否则 400 与 403 的区分是平凡成立的（门控本就不会命中）
    const selfId = await emailRegisteredAdmin("promo-ac8-self@test.dev");
    const cookie = sessionCookie(await createSession(selfId));

    const { status, body } = await patchUser(cookie, selfId, { role: "member" });

    expect(status).toBe(400);
    expect(body.error?.message).toBe("Cannot demote your own account");
  });

  it("AC9 鉴权：未登录 → 401，member → 403（adminOnly 未被本改动影响）", async () => {
    const target = await githubOnlyUser("promo-ac9-target@test.dev");

    const anonymous = await patchUser(undefined, target, { role: "admin" });
    expect(anonymous.status).toBe(401);

    const memberId = await setupUser("promo-ac9-member@test.dev", 0);
    const memberCookie = sessionCookie(await createSession(memberId));
    const asMember = await patchUser(memberCookie, target, { role: "admin" });
    expect(asMember.status).toBe(403);

    // 效果断言：两次被拒之后目标一行未动
    expect((await dbUser(target)).role).toBe("member");
  });
});

// ============ 开关开启（运行时改写 env；机制见 helpers.withSwitch）============

describe("开关开启时的写边界", () => {
  it("AC5 能力保留：邮件注册 member 提升为 admin → 200 且 D1 确实升为 admin", async () => {
    const cookie = await adminCookieFor("promo-admin-ac5@test.dev");
    const target = await signUpEmailUser("promo-ac5-target@test.dev");

    const result = await withSwitch("EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED", "true", () =>
      patchUser(cookie, target, { role: "admin" }),
    );

    // 这条同时证伪「实现成无条件拒绝」：同一个账户形态在开关开启时是能提升的
    expect(result.status).toBe(200);
    expect(result.body.user?.role).toBe("admin");
    expect((await dbUser(target)).role).toBe("admin");
  });

  it("AC6 路由级：四个正词之一（\"1\"）同样开启", async () => {
    const cookie = await adminCookieFor("promo-admin-ac6@test.dev");
    const target = await signUpEmailUser("promo-ac6-target@test.dev");

    const result = await withSwitch("EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED", "1", () =>
      patchUser(cookie, target, { role: "admin" }),
    );

    expect(result.status).toBe(200);
    expect((await dbUser(target)).role).toBe("admin");
  });
});

// ============ 缺省与非法值（路由级；逐值表在 admin-promotion-policy.unit.test.ts）============

describe("缺省与非法值的路由级对照", () => {
  it("AC6 未配置（undefined）⇒ 关闭 ⇒ 403 且库未变", async () => {
    const cookie = await adminCookieFor("promo-admin-ac6b@test.dev");
    const target = await signUpEmailUser("promo-ac6b-target@test.dev");
    await pinStaleUpdatedAt(target);

    const { status } = await withSwitch(
      "EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED",
      undefined,
      () => patchUser(cookie, target, { role: "admin" }),
    );

    // 「缺省即关闭」是这条开关的立身之本：忘了配置的部署必须落在被拦的那一侧
    expect(status).toBe(403);
    const row = await dbUser(target);
    expect(row.role).toBe("member");
    expect(row.updatedAt.getTime()).toBe(STALE_UPDATED_AT.getTime());
  });

  it("AC6 非法值（\"garbage\"）⇒ 关闭 ⇒ 403", async () => {
    const cookie = await adminCookieFor("promo-admin-ac6c@test.dev");
    const target = await signUpEmailUser("promo-ac6c-target@test.dev");

    const { status } = await withSwitch(
      "EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED",
      "garbage",
      () => patchUser(cookie, target, { role: "admin" }),
    );

    expect(status).toBe(403);
    expect((await dbUser(target)).role).toBe("member");
  });

  it("翻转不残留：本用例结束时开关已还原成 pinned 值（同文件后续用例的前提）", () => {
    // withSwitch 的 finally 若失效，上面的开启态会泄漏到这里 —— 这条就是那个守卫
    expect(env.EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED).toBe("false");
  });
});

// ============ 列表契约（AC10）============

describe("GET /api/users 的 emailRegistered 字段", () => {
  it("AC10 三类账户形态各取判据字面值", async () => {
    const cookie = await adminCookieFor("promo-admin-ac10@test.dev");
    const credentialId = await signUpEmailUser("promo-list-cred@test.dev");
    const githubId = await githubOnlyUser("promo-list-gh@test.dev");
    const bareId = await setupUser("promo-list-bare@test.dev", 0); // 无任何 account 行（退化形态）

    const res = await selfFetch("http://localhost/api/users?search=promo-list-", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; email: string; emailRegistered: boolean }[];
    };
    const byId = new Map(body.items.map((item) => [item.id, item]));

    expect(byId.get(String(credentialId))?.emailRegistered).toBe(true);
    expect(byId.get(String(githubId))?.emailRegistered).toBe(false);
    // 退化形态如实标注：生产不可达（登录必建 account 行），此处按判据字面取 false，
    // 不采用「未知形态一律拦」的另一种口径（那会让列表字段与写边界判据不一致）。
    expect(byId.get(String(bareId))?.emailRegistered).toBe(false);
  });
});
