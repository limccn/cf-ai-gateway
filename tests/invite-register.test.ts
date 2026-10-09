// 邀请码注册（M2 2.3）先消费后建号语义（F2 安全评审加固）：
//   1) 注册成功 → 邀请码 used_at 置位（一次性）
//   2) 已使用码 → 注册被拒（validateUserInfo 校验，不进入消费）
//   3) 建号失败（重复邮箱）→ 视 Better Auth 顺序：重复检查先于 create.before → 不烧码；
//      否则 before 已消费 → 码被烧（一次性码语义，管理员可补发）
// 覆盖 auth.ts validateUserInfo 只校验 + create.before 消费的拆分。
import { env } from "cloudflare:test";
import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { inviteCodes, users } from "../src/db/schema";
import { applyMigrations, selfFetch, setupUser } from "./helpers";

// Better Auth formCsrfMiddleware 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";

function signUp(email: string, inviteCode: string) {
  return selfFetch("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123", name: email.split("@")[0] ?? email, inviteCode }),
  });
}

async function insertInvite(code: string, createdBy: number): Promise<void> {
  const db = createDb(env);
  await db.insert(inviteCodes).values({
    code,
    createdBy,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
}

async function usedAt(code: string): Promise<Date | null> {
  const db = createDb(env);
  const row = await db.query.inviteCodes.findFirst({
    where: eq(inviteCodes.code, code),
    columns: { usedAt: true },
  });
  return row?.usedAt ?? null;
}

let ADMIN_ID = 0;

beforeAll(async () => {
  await applyMigrations();
  ADMIN_ID = await setupUser("ir-admin@test.dev", 0, "admin");
});

describe("邀请码注册（先消费后建号）", () => {
  it("注册成功 → 邀请码被消费（used_at 置位）", async () => {
    await insertInvite("IRTEST01", ADMIN_ID);
    const res = await signUp("ir-ok@test.dev", "IRTEST01");
    expect([200, 201]).toContain(res.status);
    expect(await usedAt("IRTEST01")).not.toBeNull();
  });

  it("已使用码 → 注册被拒，不建号", async () => {
    // validateUserInfo 返回 error → Better Auth 映射 403
    const res = await signUp("ir-used@test.dev", "IRTEST01");
    expect(res.status).toBe(403);
    const json = (await res.json()) as { message?: string };
    expect(json.message?.toLowerCase()).toContain("invite");
    const db = createDb(env);
    const row = await db.query.users.findFirst({
      where: eq(users.email, "ir-used@test.dev"),
      columns: { id: true },
    });
    expect(row).toBeUndefined();
  });

  it("建号失败（重复邮箱）→ 邀请码不被消费（不烧码）", async () => {
    await insertInvite("IRTEST02", ADMIN_ID);
    const first = await signUp("ir-dup@test.dev", "IRTEST02");
    expect([200, 201]).toContain(first.status);
    expect(await usedAt("IRTEST02")).not.toBeNull();

    // 同邮箱二次注册（带新码）：建号失败（路由层 USER_ALREADY_EXISTS → 422）→ 新码 used_at 必须保持 null
    // （F2 后依赖 Better Auth 重复检查先于 create.before 钩子执行；若失败则翻转此断言并更新文件头注释）
    await insertInvite("IRTEST03", ADMIN_ID);
    const dup = await signUp("ir-dup@test.dev", "IRTEST03");
    expect(dup.status).toBe(422);
    expect(await usedAt("IRTEST03")).toBeNull();
  });

  it("过期码 → 注册被拒", async () => {
    const db = createDb(env);
    await db.insert(inviteCodes).values({
      code: "IREXP001",
      createdBy: ADMIN_ID,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await signUp("ir-exp@test.dev", "IREXP001");
    expect(res.status).toBe(403);
    // 过期校验后不置位
    const row = await db.query.inviteCodes.findFirst({
      where: and(eq(inviteCodes.code, "IREXP001"), isNull(inviteCodes.usedAt)),
    });
    expect(row).not.toBeUndefined();
  });
});
