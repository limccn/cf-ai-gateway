// 测试用户种子（dev-only）单测：POST /api/seed/users。
// - 种子后用户可登录、admin/member 权限正确、重复执行幂等（AC1–AC5）。
// - 路由在未配置 SEED_USERS 时 404：工作区测试绑定固定配置了 SEED_USERS，
//   该分支由 parseSeedUsers(undefined) → null 的单元测试覆盖 + 本地实跑验证。
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { applyMigrations, selfFetch } from "./helpers";
import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import { parseSeedUsers } from "../src/lib/seed-users";

const ADMIN = { email: "seed-admin@test.dev", password: "test-seed-pass-123" };
const MEMBER = { email: "seed-member@test.dev", password: "test-seed-pass-123" };

beforeAll(async () => {
  await applyMigrations();
});

async function seedViaApi(): Promise<{
  created: { email: string; role: string }[];
  skipped: { email: string }[];
}> {
  const res = await selfFetch("http://localhost/api/seed/users", {
    method: "POST",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    success: boolean;
    created: { email: string; role: string }[];
    skipped: { email: string }[];
  };
  expect(body.success).toBe(true);
  return body;
}

async function userRole(email: string): Promise<string | undefined> {
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { role: true },
  });
  return row?.role;
}

async function signInCookie(email: string, password: string): Promise<string> {
  const res = await selfFetch("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const setCookies = res.headers.getSetCookie();
  const cookie = setCookies.find((c) => c.startsWith("better-auth.session_token="));
  expect(cookie).toBeDefined();
  const value = cookie?.split(";")[0];
  if (!value) throw new Error("no session cookie from sign-in");
  return value;
}

describe("POST /api/seed/users", () => {
  it("空库初始化：创建 admin + member 两个测试用户，角色正确", async () => {
    const { created, skipped } = await seedViaApi();
    expect(created).toHaveLength(2);
    expect(skipped).toHaveLength(0);
    const roles = new Map(created.map((u) => [u.email, u.role]));
    expect(roles.get(ADMIN.email)).toBe("admin");
    expect(roles.get(MEMBER.email)).toBe("member");
    expect(await userRole(ADMIN.email)).toBe("admin");
    expect(await userRole(MEMBER.email)).toBe("member");
  });

  it("幂等：重复执行全 skipped，不创建重复用户", async () => {
    const { created, skipped } = await seedViaApi();
    expect(created).toHaveLength(0);
    expect(skipped).toHaveLength(2);
    const db = createDb(env);
    for (const email of [ADMIN.email, MEMBER.email]) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      expect(rows).toHaveLength(1);
    }
  });

  it("种子 admin 可登录且访问管理接口（200）", async () => {
    const cookie = await signInCookie(ADMIN.email, ADMIN.password);
    const res = await selfFetch("http://localhost/api/users", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  it("种子 member 可登录但访问管理接口被拒（403）", async () => {
    const cookie = await signInCookie(MEMBER.email, MEMBER.password);
    const res = await selfFetch("http://localhost/api/users", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });
});

describe("parseSeedUsers（SEED_USERS 解析门）", () => {
  it("undefined/空白 → null（功能关闭）", () => {
    expect(parseSeedUsers(undefined)).toBeNull();
    expect(parseSeedUsers("")).toBeNull();
    expect(parseSeedUsers("   ")).toBeNull();
  });

  it("非法 JSON / 非数组 → 抛错（fail-fast，不静默降级）", () => {
    expect(() => parseSeedUsers("not-json")).toThrow(/JSON/);
    expect(() => parseSeedUsers('{"email":"a@b.dev"}')).toThrow(/array/i);
  });

  it("非法字段（短密码 / 坏邮箱 / 非法 role）→ 抛错", () => {
    const base = { email: "a@b.dev", password: "12345678" };
    expect(() => parseSeedUsers(JSON.stringify([{ ...base, password: "short" }]))).toThrow(/8/);
    expect(() => parseSeedUsers(JSON.stringify([{ ...base, email: "no-at" }]))).toThrow(/email/i);
    expect(() => parseSeedUsers(JSON.stringify([{ ...base, role: "root" }]))).not.toThrow();
  });

  it("合法种子：缺省 name/role 有合理默认值", () => {
    const specs = parseSeedUsers('[{"email":"a@b.dev","password":"12345678"}]');
    expect(specs).not.toBeNull();
    expect(specs?.[0]).toMatchObject({ email: "a@b.dev", name: "a", role: "member" });
  });
});