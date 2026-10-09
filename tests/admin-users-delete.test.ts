// DELETE /api/users/:id（admin）级联删除单测：
//   1) admin 删除 member → 200，7 张关联表 + users 全部无残留（FK 拓扑序正确性的回归闸：
//      关联数据覆盖 balanceTx.refRequestId → requestLogs 与 requestLogs/usageDaily.keyId → apiKeys，
//      batch 顺序错误会触发即时外键约束 → 整批回滚 → 500）
//   2) 防护：删自己 → 400；删另一 admin → 400；不存在 id → 404
//   3) 鉴权：member cookie DELETE → 403（adminOnly）
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import {
  accounts,
  apiKeys,
  balanceTx,
  inviteCodes,
  requestLogs,
  sessions,
  usageDaily,
  users,
} from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupKey,
  setupUser,
} from "./helpers";

const ORIGIN = "http://localhost:5173";

beforeAll(async () => {
  await applyMigrations();
});

async function insertInvite(code: string, createdBy: number): Promise<void> {
  const db = createDb(env);
  await db.insert(inviteCodes).values({
    code,
    createdBy,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
}

let ADMIN_ID = 0;
let ADMIN2_ID = 0;
let MEMBER_ID = 0;
let adminCookie = "";

beforeAll(async () => {
  ADMIN_ID = await setupUser("del-admin@test.dev", 0, "admin");
  ADMIN2_ID = await setupUser("del-admin2@test.dev", 0, "admin");
  adminCookie = sessionCookie(await createSession(ADMIN_ID));

  // member 走邀请码注册路径（真实 Better Auth 建号 → users + accounts + sessions 齐全）
  await insertInvite("DELTEST01", ADMIN_ID);
  const signUp = await selfFetch("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "del-member@test.dev",
      password: "testpass123",
      name: "del-member",
      inviteCode: "DELTEST01",
    }),
  });
  expect([200, 201]).toContain(signUp.status);
  const db = createDb(env);
  const member = await db.query.users.findFirst({
    where: eq(users.email, "del-member@test.dev"),
  });
  if (!member) throw new Error("member signup failed");
  MEMBER_ID = member.id;
});

/** 为 member 造关联数据：api_key + request_log + usage_daily + balance_tx（含 refRequestId FK）+ 邀请码。 */
async function seedMemberRelatedRows(): Promise<number> {
  const db = createDb(env);
  const { keyId } = await setupKey(MEMBER_ID);

  const [log] = await db
    .insert(requestLogs)
    .values({
      requestId: crypto.randomUUID(),
      userId: MEMBER_ID,
      keyId,
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
      cost: 0.001,
      status: "success",
    })
    .returning({ id: requestLogs.id });

  await db.insert(usageDaily).values({
    userId: MEMBER_ID,
    keyId,
    model: "test-model",
    date: "2026-09-07",
    requests: 1,
    tokensIn: 10,
    tokensOut: 5,
    cost: 0.001,
  });

  // 两条流水：一条挂 refRequestId（覆盖 → requestLogs 的 FK），一条普通 adjust
  await db.insert(balanceTx).values([
    {
      userId: MEMBER_ID,
      amount: -0.001,
      type: "usage",
      refRequestId: log?.id ?? null,
    },
    { userId: MEMBER_ID, amount: 10, type: "adjust", note: "seed" },
  ]);

  await db.insert(inviteCodes).values({
    code: "DELMBR01",
    createdBy: MEMBER_ID,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return keyId;
}

async function totalUsers(): Promise<number> {
  const res = await selfFetch("http://localhost/api/users", {
    headers: { Cookie: adminCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { total: number };
  return body.total;
}

describe("DELETE /api/users/:id", () => {
  it("admin 删除 member → 200，7 张关联表 + users 无残留，total 减 1", async () => {
    const keyId = await seedMemberRelatedRows();
    // member 此时应拥有：accounts（注册建号）+ sessions（注册 autoSignIn）+ 1 key
    const db = createDb(env);
    expect(
      await db.select().from(accounts).where(eq(accounts.userId, MEMBER_ID)),
    ).toHaveLength(1);
    expect(
      (await db.select().from(sessions).where(eq(sessions.userId, MEMBER_ID)))
        .length,
    ).toBeGreaterThanOrEqual(1);

    const before = await totalUsers();
    const res = await selfFetch(`http://localhost/api/users/${MEMBER_ID}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // 级联断言：叶子表（balanceTx/usageDaily/requestLogs）→ sessions/accounts/inviteCodes → apiKeys → users
    expect(
      await db.select().from(balanceTx).where(eq(balanceTx.userId, MEMBER_ID)),
    ).toHaveLength(0);
    expect(
      await db.select().from(usageDaily).where(eq(usageDaily.userId, MEMBER_ID)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(requestLogs)
        .where(eq(requestLogs.userId, MEMBER_ID)),
    ).toHaveLength(0);
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, MEMBER_ID)),
    ).toHaveLength(0);
    expect(
      await db.select().from(accounts).where(eq(accounts.userId, MEMBER_ID)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(inviteCodes)
        .where(eq(inviteCodes.createdBy, MEMBER_ID)),
    ).toHaveLength(0);
    expect(
      await db.select().from(apiKeys).where(eq(apiKeys.userId, MEMBER_ID)),
    ).toHaveLength(0);
    expect(
      await db.query.users.findFirst({ where: eq(users.id, MEMBER_ID) }),
    ).toBeUndefined();
    expect(await totalUsers()).toBe(before - 1);

    // keyId 未被其他表残留引用（key 行已删）
    expect(
      await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)),
    ).toHaveLength(0);
  });

  it("防护：删自己 → 400；删另一 admin → 400；不存在 id → 404", async () => {
    const self = await selfFetch(`http://localhost/api/users/${ADMIN_ID}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(self.status).toBe(400);

    const otherAdmin = await selfFetch(
      `http://localhost/api/users/${ADMIN2_ID}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(otherAdmin.status).toBe(400);

    const missing = await selfFetch("http://localhost/api/users/999999", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(missing.status).toBe(404);
  });

  it("member cookie DELETE → 403（adminOnly）", async () => {
    // 用例 1 已删除原 member；再造一个临时 member 验证鉴权
    await insertInvite("DELTEST02", ADMIN_ID);
    const signUp = await selfFetch("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "del-member2@test.dev",
        password: "testpass123",
        name: "del-member2",
        inviteCode: "DELTEST02",
      }),
    });
    expect([200, 201]).toContain(signUp.status);
    const db = createDb(env);
    const member = await db.query.users.findFirst({
      where: eq(users.email, "del-member2@test.dev"),
    });
    if (!member) throw new Error("member2 signup failed");

    const res = await selfFetch(`http://localhost/api/users/${ADMIN2_ID}`, {
      method: "DELETE",
      headers: { Cookie: sessionCookie(await createSession(member.id)) },
    });
    expect(res.status).toBe(403);
  });
});
