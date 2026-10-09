// 测试用户种子（dev-only）单测：POST /api/seed/users。
// - 种子后用户可登录、admin/member 权限正确、重复执行幂等（AC1–AC5）。
// - 路由在未配置 SEED_USERS 时 404：工作区测试绑定固定配置了 SEED_USERS，
//   该分支由「未配置 SEED_USERS 时的暴露面」用例经 withSeedUsers 翻空后走**真实 HTTP 路径**覆盖
//   （09-22-seed-users-dev-only / AC-F6），另有 parseSeedUsers 的单元用例兜底解析层。
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { eq, isNull } from "drizzle-orm";
import { applyMigrations, selfFetch } from "./helpers";
import { createDb } from "../src/db";
import { inviteCodes, users } from "../src/db/schema";
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

// ---------- 09-22-seed-users-dev-only：种子改走真实邀请码链路 ----------
//
// 改造前：种子邮箱在 `validateUserInfo` 里被白名单直接放行（不消费邀请码），
// `create.before` 再靠"空码放行"分支兜住。改造后该豁免整体消失，种子路由**自铸一次性码**。
// 下面两组断言分别锁住这件事的两半：铸的码真的被消费了（AC-F2），
// 以及"在 SEED_USERS 里"不再等于"能建号"（AC-F3，对照组是它的阳性控制）。

/** Better Auth formCsrfMiddleware 校验 Origin 与 baseURL 一致（vitest env: http://localhost:5173）。 */
const ORIGIN = "http://localhost:5173";

/** 逐用例改写 SEED_USERS。与 helpers.withSwitch 同一纪律：仅本 isolate 可见，finally 还原。 */
async function withSeedUsers<T>(raw: string, fn: () => Promise<T>): Promise<T> {
  const original = env.SEED_USERS;
  try {
    env.SEED_USERS = raw;
    return await fn();
  } finally {
    env.SEED_USERS = original;
  }
}

/** 无签发者（created_by IS NULL）的邀请码 —— 只有种子路由会铸出这种码（决策 D-F1）。 */
function nullIssuerCodes(): Promise<{ code: string; usedAt: Date | null }[]> {
  const db = createDb(env);
  return db
    .select({ code: inviteCodes.code, usedAt: inviteCodes.usedAt })
    .from(inviteCodes)
    .where(isNull(inviteCodes.createdBy));
}

async function countNullIssuerCodes(used: boolean): Promise<number> {
  const rows = await nullIssuerCodes();
  return rows.filter((r) => (r.usedAt !== null) === used).length;
}

describe("种子自铸邀请码（09-22-seed-users-dev-only）", () => {
  const FRESH = { email: "seed-fresh@test.dev", password: "test-seed-pass-123" };

  it("AC-F2：种子建号 = 铸码 → 消费 → 建号（码 used_at 非空、created_by 为空）", async () => {
    const usedBefore = await countNullIssuerCodes(true);
    const unusedBefore = await countNullIssuerCodes(false);

    const { created, skipped } = await withSeedUsers(
      JSON.stringify([{ ...FRESH, name: "Fresh", role: "member" }]),
      seedViaApi,
    );
    expect(created).toEqual([{ email: FRESH.email, role: "member" }]);
    expect(skipped).toEqual([]);

    // 铸了且只铸了一张，并且它**被消费**了 —— 旧实现是"放行 + 不消费"，码表里根本不会多出这行。
    expect(await countNullIssuerCodes(true)).toBe(usedBefore + 1);
    expect(await countNullIssuerCodes(false)).toBe(unusedBefore);
    // 用户确实经 Better Auth 建成且可登录（消费发生在 create.before，建号失败则码被烧而人不建）
    expect(await userRole(FRESH.email)).toBe("member");
    await signInCookie(FRESH.email, FRESH.password);
  });

  it("AC-F3：邮箱在 SEED_USERS 里 ≠ 能建号 —— 不带邀请码注册被拒", async () => {
    const NOCODE = { email: "seed-nocode@test.dev", password: "test-seed-pass-123", name: "NoCode" };

    await withSeedUsers(JSON.stringify([NOCODE]), async () => {
      // ① 负向：同一 SEED_USERS 下，不带邀请码注册该邮箱必须被拒。
      //    改造前这里返回 201（种子邮箱白名单直接放行 → 建号成功）。
      const res = await selfFetch("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: NOCODE.email,
          password: NOCODE.password,
          name: NOCODE.name,
        }),
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { message?: string };
      // 且必须是"缺码"这道闸（而非别的 403）：措辞随 validateUserInfo 的 INVITE_CODE_REQUIRED
      expect(json.message?.toLowerCase()).toContain("required");
      expect(await userRole(NOCODE.email)).toBeUndefined();

      // ② 阳性控制：同一翻转下种子路由必须认得这个邮箱。
      //    没有这一步，① 的 403 可能只是"env.SEED_USERS 翻转没生效"造成的**假绿**。
      const seeded = await seedViaApi();
      expect(seeded.created.map((u) => u.email)).toEqual([NOCODE.email]);
    });

    expect(await userRole(NOCODE.email)).toBe("member");
  });
});

describe("未配置 SEED_USERS 时的暴露面（AC-F6）", () => {
  it("SEED_USERS 未设置 → POST /api/seed/users 404（生产零暴露）", async () => {
    // 路由**始终挂载**（src/index.ts），gating 在处理器内部按 env.SEED_USERS 判定 ——
    // 本用例走的是真实的 HTTP 路径，而非 parseSeedUsers 的单元行为：即使将来有人把
    // gating 挪到挂载处或改了判据，这里也会红。
    await withSeedUsers("", async () => {
      const res = await selfFetch("http://localhost/api/seed/users", { method: "POST" });
      expect(res.status).toBe(404);
    });
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