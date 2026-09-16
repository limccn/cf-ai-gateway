// 注册赠金 / 邮箱验证赠金集成测试（09-16-signup-bonus-grant，design §8.2）。
//
// 覆盖：AC1（注册即赠 5）、AC5（验证赠金）、AC6（重复验证幂等）、AC7（并发幂等 +
// 部分唯一索引）、AC12（流水按 type 可筛选）、AC2/AC3/AC4/AC8（金额分支矩阵）、
// AC10（赠金异常 fail-open，真实断言 catch 分支）。
//
// 已知覆盖缺口（design §8.3，刻意为之，不是遗漏）：
//   **GitHub OAuth 注册路径的注册赠金无自动化测试**。触发 OAuth 回调需模拟 GitHub 的
//   token/userinfo 交换，成本远超收益。接受该缺口的三条理由：
//     1) 钩子挂在 databaseHooks.user.create.after，**不区分 provider** —— 结构保证，
//        不是分支逻辑；
//     2) grantSignupBonus / grantBonusOnce 已被本文件与 bonus.unit.test.ts 充分覆盖；
//     3) OAuth 路径由 stg 人工验证（父任务 CA1）。
//   同理「OAuth 用户不获验证赠金」：afterEmailVerification 只由验证动作触发，
//   OAuth 用户从不经过该端点（建号即 emailVerified=true，Better Auth 在 verify-email 处短路）。
//
// 金额分支为什么不用端到端注册覆盖：miniflare bindings 在测试进程内固定，无法逐用例改 env
// ——因此金额矩阵走「纯函数（bonus.unit.test.ts）+ 直接调用 grantSignupBonus 注入 env」，
// 端到端只钉默认值 5 的路径。
import { env } from "cloudflare:test";
import { createEmailVerificationToken } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import type { Db } from "../src/db";
import { balanceTx, inviteCodes, users } from "../src/db/schema";
import { createAuth } from "../src/lib/auth";
import {
  grantBonusOnce,
  grantEmailVerifyBonus,
  grantSignupBonus,
} from "../src/lib/bonus";
import type { Logger } from "../src/lib/logger";
import {
  applyMigrations,
  countTxByType,
  createSession,
  getBalance,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

// Better Auth formCsrfMiddleware 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";

let ADMIN_ID = 0;
let inviteSeq = 0;

beforeAll(async () => {
  await applyMigrations();
  ADMIN_ID = await setupUser("sb-admin@test.dev", 0, "admin");
});

/** 造一张一次性邀请码（邮箱密码注册路径的准入门槛）。 */
async function insertInvite(): Promise<string> {
  const db = createDb(env);
  inviteSeq += 1;
  const code = `SBTEST${String(inviteSeq).padStart(2, "0")}`;
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

async function txRows(userId: number, type: string) {
  const db = createDb(env);
  return db
    .select()
    .from(balanceTx)
    .where(and(eq(balanceTx.userId, userId), eq(balanceTx.type, type)));
}

/** 捕获式 logger（断言 fail-open 的 catch 分支确实记录了错误日志）。 */
function capturingLogger(): {
  logger: Logger;
  events: Array<{ level: string; message: string; fields?: Record<string, unknown> }>;
} {
  const events: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const record =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>) => {
      events.push(fields !== undefined ? { level, message, fields } : { level, message });
    };
  return {
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
    events,
  };
}

/**
 * 「D1 不可用」测试替身：链式查询方法返回自身，唯独 batch 抛错 ——
 * 用来验证 grantSignupBonus / grantEmailVerifyBonus 的 fail-open 分支真的吞掉异常。
 */
function brokenDb(): Db {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ["set", "where", "returning", "values", "onConflictDoNothing"]) {
    chain[method] = self;
  }
  return {
    update: () => chain,
    insert: () => chain,
    batch: async () => {
      throw new Error("d1 unavailable");
    },
  } as unknown as Db;
}

describe("注册赠金（端到端注册路径）", () => {
  it("AC1：注册成功 → balance +5，恰 1 条 signup_bonus 流水（金额 5、为正），标记列置位", async () => {
    const email = "sb-signup@test.dev";
    const { res, userId } = await signUp(email);
    expect([200, 201]).toContain(res.status);

    expect(await getBalance(userId)).toBe(5);
    const rows = await txRows(userId, "signup_bonus");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(5);
    expect(rows[0]?.amount).toBeGreaterThan(0);
    expect(rows[0]?.note).toBe("signup bonus");
    expect(rows[0]?.refRequestId).toBeNull();

    // 幂等标记已置位（重复触发不会二次发放的前提）
    const row = await userRow(userId);
    expect(row.signupBonusGrantedAt).not.toBeNull();
    expect(row.emailVerifyBonusGrantedAt).toBeNull();
  });

  it("流水可辨识：signup_bonus 与 usage/adjust 各自独立可数", async () => {
    const userId = await setupUser("sb-typeisolated@test.dev", 0);
    const db = createDb(env);
    await db.insert(balanceTx).values({ userId, amount: -1, type: "usage", note: "usage: x" });
    await db.insert(balanceTx).values({ userId, amount: 3, type: "adjust", note: "manual" });
    await grantBonusOnce(db, userId, "signup_bonus", 5, "signup bonus");

    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await countTxByType(userId, "adjust")).toBe(1);
    expect(await countTxByType(userId, "signup_bonus")).toBe(1);
  });
});

describe("邮箱验证赠金（createEmailVerificationToken → GET /api/auth/verify-email）", () => {
  it("AC5：验证成功 → emailVerified 置 true，balance 再 +5，恰 1 条 email_verify_bonus 流水", async () => {
    const email = "sb-verify@test.dev";
    const { userId } = await signUp(email);
    expect(await getBalance(userId)).toBe(5); // 注册赠金先到账

    const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email);
    const res = await selfFetch(
      `http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);

    const row = await userRow(userId);
    expect(row.emailVerified).toBe(true);
    expect(await getBalance(userId)).toBe(10); // 5 + 5
    const rows = await txRows(userId, "email_verify_bonus");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(5);
    expect(row.emailVerifyBonusGrantedAt).not.toBeNull();
  });

  it("AC6：重复调用验证端点（已 emailVerified）→ 余额与流水条数不变", async () => {
    const email = "sb-verify-twice@test.dev";
    const { userId } = await signUp(email);

    const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email);
    const first = await selfFetch(
      `http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect(first.status).toBe(200);
    const balanceAfterFirst = await getBalance(userId);
    expect(balanceAfterFirst).toBe(10);

    // 同 token 二次调用 + 新 token 再来一次：都不得再发钱
    const again = await selfFetch(
      `http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect(again.status).toBe(200);
    const freshToken = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email);
    const third = await selfFetch(
      `http://localhost/api/auth/verify-email?token=${encodeURIComponent(freshToken)}`,
    );
    expect(third.status).toBe(200);

    expect(await getBalance(userId)).toBe(balanceAfterFirst);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(1);
  });
});

describe("幂等与并发（直接调用发放原语）", () => {
  it("AC7：同一用户同一档并发两次 → 只有一次 granted，余额只增一次，流水一行", async () => {
    const userId = await setupUser("sb-concurrent@test.dev", 0);
    const db = createDb(env);

    const [a, b] = await Promise.all([
      grantBonusOnce(db, userId, "signup_bonus", 5, "signup bonus"),
      grantBonusOnce(db, userId, "signup_bonus", 5, "signup bonus"),
    ]);

    const grantedCount = [a, b].filter((r) => r.granted).length;
    expect(grantedCount).toBe(1);
    expect(await getBalance(userId)).toBe(5);
    expect(await countTxByType(userId, "signup_bonus")).toBe(1);
  });

  it("两档互不干扰：signup_bonus 与 email_verify_bonus 各发一次", async () => {
    const userId = await setupUser("sb-both@test.dev", 0);
    const db = createDb(env);

    await grantBonusOnce(db, userId, "signup_bonus", 5, "signup bonus");
    const second = await grantBonusOnce(db, userId, "signup_bonus", 5, "signup bonus");
    await grantBonusOnce(db, userId, "email_verify_bonus", 5, "email verified bonus");

    expect(second.granted).toBe(false);
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "signup_bonus")).toBe(1);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(1);
  });

  it("部分唯一索引兜底：直接重复插入同档流水被数据库拒绝，usage 多行不受影响", async () => {
    const userId = await setupUser("sb-index@test.dev", 0);
    const db = createDb(env);

    await db.insert(balanceTx).values({ userId, amount: 5, type: "signup_bonus" });
    // 第二次直接插入（不走 onConflictDoNothing）必须被部分唯一索引拒绝
    await expect(
      db.insert(balanceTx).values({ userId, amount: 5, type: "signup_bonus" }),
    ).rejects.toThrow();

    // usage：索引只覆盖两个赠金 type，多行仍可写
    await db.insert(balanceTx).values({ userId, amount: -1, type: "usage" });
    await db.insert(balanceTx).values({ userId, amount: -2, type: "usage" });
    await expect(countTxByType(userId, "usage")).resolves.toBe(2);
  });
});

describe("金额分支（直接调用 grantSignupBonus / grantEmailVerifyBonus 注入 env）", () => {
  it("AC2：SIGNUP_BONUS_AMOUNT=0 → 不发放（余额不变、无流水、标记仍 NULL）", async () => {
    const userId = await setupUser("sb-zero@test.dev", 3);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantSignupBonus({ SIGNUP_BONUS_AMOUNT: "0" }, db, logger, userId);

    expect(await getBalance(userId)).toBe(3);
    expect(await countTxByType(userId, "signup_bonus")).toBe(0);
    expect((await userRow(userId)).signupBonusGrantedAt).toBeNull();
  });

  it("AC3：SIGNUP_BONUS_AMOUNT=abc（非法）→ 行为同 0（不发放、不抛错）", async () => {
    const userId = await setupUser("sb-invalid@test.dev", 3);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantSignupBonus({ SIGNUP_BONUS_AMOUNT: "abc" }, db, logger, userId);

    expect(await getBalance(userId)).toBe(3);
    expect(await countTxByType(userId, "signup_bonus")).toBe(0);
    expect((await userRow(userId)).signupBonusGrantedAt).toBeNull();
  });

  it("AC4：SIGNUP_BONUS_AMOUNT=8 → 发放 8（配置生效）", async () => {
    const userId = await setupUser("sb-eight@test.dev", 0);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantSignupBonus({ SIGNUP_BONUS_AMOUNT: "8" }, db, logger, userId);

    expect(await getBalance(userId)).toBe(8);
    const rows = await txRows(userId, "signup_bonus");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(8);
    expect((await userRow(userId)).signupBonusGrantedAt).not.toBeNull();
  });

  it("AC4b：未配置金额 → 取默认 5", async () => {
    const userId = await setupUser("sb-default@test.dev", 0);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantSignupBonus({}, db, logger, userId);

    expect(await getBalance(userId)).toBe(5);
  });

  it("AC8：EMAIL_VERIFY_BONUS_AMOUNT=0 → 不发放（标记仍 NULL）", async () => {
    const userId = await setupUser("sb-ev-zero@test.dev", 4);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantEmailVerifyBonus({ EMAIL_VERIFY_BONUS_AMOUNT: "0" }, db, logger, userId);

    expect(await getBalance(userId)).toBe(4);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(0);
    expect((await userRow(userId)).emailVerifyBonusGrantedAt).toBeNull();
  });
});

describe("fail-open（AC10：赠金异常不得阻断主流程）", () => {
  it("注册赠金遇 DB 异常 → 不抛，且记录 bonus_grant_failed 错误日志", async () => {
    const { logger, events } = capturingLogger();

    await expect(
      grantSignupBonus({ SIGNUP_BONUS_AMOUNT: "5" }, brokenDb(), logger, 1),
    ).resolves.toBeUndefined();

    const errors = events.filter(
      (e) => e.level === "error" && e.message === "bonus_grant_failed",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields?.["userId"]).toBe(1);
    expect(errors[0]?.fields?.["type"]).toBe("signup_bonus");
    expect(String(errors[0]?.fields?.["error"])).toContain("d1 unavailable");
  });

  it("验证赠金遇 DB 异常 → 同样不抛（验证流程不受影响）", async () => {
    const { logger, events } = capturingLogger();

    await expect(
      grantEmailVerifyBonus({ EMAIL_VERIFY_BONUS_AMOUNT: "5" }, brokenDb(), logger, 2),
    ).resolves.toBeUndefined();

    expect(
      events.filter((e) => e.level === "error" && e.message === "bonus_grant_failed"),
    ).toHaveLength(1);
  });

  it("发放原语对不存在的用户由 FK 约束暴露（整批回滚，钱不会凭空落账）", async () => {
    const db = createDb(env);
    // balance_tx.user_id → users.id 外键：不存在的用户会让 batch 整体失败（同 chargeUsage 语义）；
    // 上层包装（grantSignupBonus）负责吞掉它 —— 故端点不会因此 5xx。
    await expect(
      grantBonusOnce(db, 999_999, "signup_bonus", 5, "signup bonus"),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe("EMAIL_VERIFICATION_ENABLED 门控（AC9 后端侧）", () => {
  // 开关语义是「关闭 ⇒ 整个 emailVerification 段不配置」（而非配置了但内部 no-op）——
  // 直接对 createAuth 的产物断言，比走端点更能钉住这条结构性保证。
  it("关闭时 auth.options.emailVerification 为 undefined（不发信、不发验证赠金）", async () => {
    const db = createDb(env);
    const auth = createAuth({ ...env, EMAIL_VERIFICATION_ENABLED: "false" }, db);
    expect(auth.options.emailVerification).toBeUndefined();
  });

  it("开启时 emailVerification 段存在，sendOnSignUp 与验证赠金钩子均已接线", async () => {
    const db = createDb(env);
    const auth = createAuth({ ...env, EMAIL_VERIFICATION_ENABLED: "true" }, db);
    expect(auth.options.emailVerification?.sendOnSignUp).toBe(true);
    expect(typeof auth.options.emailVerification?.afterEmailVerification).toBe("function");
  });

  it("两种开关取值下都不动 emailAndPassword（注册响应形状零变更的前提）", async () => {
    const db = createDb(env);
    for (const flag of ["false", "true"]) {
      const auth = createAuth({ ...env, EMAIL_VERIFICATION_ENABLED: flag }, db);
      expect(auth.options.emailAndPassword?.enabled).toBe(true);
      // 用 `in` 而非属性访问：createAuth 的返回类型是窄化字面量，
      // 而这里要断言的正是「该键根本不存在」。
      const emailAndPassword: object = auth.options.emailAndPassword ?? {};
      expect("requireEmailVerification" in emailAndPassword).toBe(false);
      expect("autoSignIn" in emailAndPassword).toBe(false);
    }
  });
});

describe("流水筛选（AC12）", () => {
  it("GET /api/me/transactions?type=signup_bonus 可筛出赠金流水", async () => {
    const email = "sb-filter@test.dev";
    const { userId } = await signUp(email);
    const cookie = sessionCookie(await createSession(userId));

    const res = await selfFetch(
      "http://localhost/api/me/transactions?type=signup_bonus",
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      items: Array<{ type: string; amount: number; note: string | null }>;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.type).toBe("signup_bonus");
    expect(body.items[0]?.amount).toBe(5);
  });

  it("GET /api/admin/transactions?type=email_verify_bonus（admin 视角同口径）", async () => {
    const email = "sb-filter-admin@test.dev";
    const { userId } = await signUp(email);
    const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email);
    await selfFetch(`http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}`);

    const adminCookie = sessionCookie(await createSession(ADMIN_ID));
    const res = await selfFetch(
      `http://localhost/api/admin/transactions?type=email_verify_bonus&userId=${userId}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      items: Array<{ type: string; amount: number }>;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.type).toBe("email_verify_bonus");
    expect(body.items[0]?.amount).toBe(5);
  });
});
