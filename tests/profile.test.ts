// 账户 Profile 模块测试（09-16-account-menu，design §7）。
//
// 覆盖：AC9（未登录 401 + 响应形状）、AC4/AC5/AC6/AC11 的服务端侧（资料四字段取自 DB 最新值、
// 用户隔离）、以及本任务唯一涉及权限边界的两条护栏：
//   - AC6：POST /api/auth/update-user 带 email → 400 且 users.email 未变
//     （Better Auth 内部硬拦，锁住「不支持改邮箱」这条产品约束）
//   - AC6c：带 role/balance（additionalFields input:false）→ 400 且未被写入
//     （实测比 design 预期更严格：命中 input:false 即整体拒绝，不做部分应用 ——
//     「name 合法 + 越权字段混发」时连 name 都不落库）
//
// 刻意不覆盖（不是遗漏）：下拉菜单开合/Esc/点击外部/焦点归位（AC1/AC2/AC12）、Profile 表单
// 的交互（AC7/AC8）、重发按钮的显隐与反馈文案（AC9/AC10 的 UI 侧）—— 仓库 app/ 下无前端测试
// 基建（既有惯例），由主会话 Playwright / stg 人工验证覆盖。此处的职责是钉住**服务端契约**，
// 其中 emailVerificationEnabled 是 UI 显隐判据的唯一来源。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

// Better Auth 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";

interface ProfileBody {
  success: boolean;
  profile: {
    name: string;
    email: string;
    emailVerified: boolean;
    emailVerificationEnabled: boolean;
  };
}

beforeAll(async () => {
  await applyMigrations();
});

async function cookieFor(userId: number): Promise<string> {
  return sessionCookie(await createSession(userId));
}

/** GET /api/me/profile（无 cookie = 未登录）。 */
async function getProfile(
  cookie?: string,
): Promise<{ status: number; body: ProfileBody | null }> {
  const res = await selfFetch(
    "http://localhost/api/me/profile",
    cookie === undefined ? {} : { headers: { Cookie: cookie } },
  );
  const body = res.status === 200 ? ((await res.json()) as ProfileBody) : null;
  return { status: res.status, body };
}

/** POST /api/auth/update-user（前端 authClient.updateUser 的等价请求形态）。 */
async function postUpdateUser(
  body: Record<string, unknown>,
  cookie?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    "Content-Type": "application/json",
  };
  if (cookie !== undefined) {
    headers.Cookie = cookie;
  }
  const res = await selfFetch("http://localhost/api/auth/update-user", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** 从 Better Auth 错误体取 message（窄化读取，仅测试用）。 */
function errorMessage(json: unknown): string {
  if (typeof json !== "object" || json === null) {
    return "";
  }
  const message = (json as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

async function userRow(userId: number) {
  const db = createDb(env);
  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!row) {
    throw new Error("test user not found");
  }
  return row;
}

describe("GET /api/me/profile（账号资料，只读）", () => {
  it("AC9：未登录 → 401（不泄露任何资料）", async () => {
    const { status, body } = await getProfile();
    expect(status).toBe(401);
    expect(body).toBeNull();
  });

  it("登录后 → 200，四字段形状与类型正确；开关随 env 生效（测试绑定为开启）", async () => {
    const userId = await setupUser("pf-basic@test.dev", 0);
    const { status, body } = await getProfile(await cookieFor(userId));

    expect(status).toBe(200);
    expect(body?.success).toBe(true);
    // 响应形状契约（design §2.1）：顶层 success + profile 四字段，无多余字段（不泄露 role/balance）
    expect(Object.keys(body ?? {}).sort()).toEqual(["profile", "success"]);
    expect(Object.keys(body?.profile ?? {}).sort()).toEqual([
      "email",
      "emailVerificationEnabled",
      "emailVerified",
      "name",
    ]);
    expect(body?.profile).toEqual({
      name: "pf-basic",
      email: "pf-basic@test.dev",
      emailVerified: false,
      // vitest 固定 binding EMAIL_VERIFICATION_ENABLED="true"（verify-email 链路可测）。
      // 关闭分支（"false"/未配置 → false）由 isEmailVerificationEnabled 的纯函数单测覆盖
      // （tests/bonus.unit.test.ts）—— miniflare bindings 无法逐用例改 env。
      emailVerificationEnabled: true,
    });
  });

  it("AC11 数据源：emailVerified 取 DB 最新值（已验证用户 → true）", async () => {
    const userId = await setupUser("pf-verified@test.dev", 0);
    const db = createDb(env);
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));

    const { body } = await getProfile(await cookieFor(userId));
    expect(body?.profile.emailVerified).toBe(true);
  });

  it("AC7 数据源：name 取 DB 最新值（改名后无需重登即可读到新值）", async () => {
    const userId = await setupUser("pf-rename@test.dev", 0);
    const db = createDb(env);
    await db.update(users).set({ name: "Renamed User" }).where(eq(users.id, userId));

    const { body } = await getProfile(await cookieFor(userId));
    expect(body?.profile.name).toBe("Renamed User");
  });

  it("用户隔离：返回会话持有者自己的资料，不含他人", async () => {
    const alice = await setupUser("pf-alice@test.dev", 0);
    const bob = await setupUser("pf-bob@test.dev", 0);

    const aliceBody = (await getProfile(await cookieFor(alice))).body;
    const bobBody = (await getProfile(await cookieFor(bob))).body;

    expect(aliceBody?.profile.email).toBe("pf-alice@test.dev");
    expect(bobBody?.profile.email).toBe("pf-bob@test.dev");
  });
});

// 改 name 复用 Better Auth 内置 POST /api/auth/update-user（design §2.2，本模块不自建写端点）。
// 下方三条是**安全护栏**：邮箱不可改（R5/AC6）与 role/balance 不可由客户端写入（AC6c）都不是
// 我们写的校验，而是库内部机制 —— 正因为不是自己写的，才必须用测试钉住，防止未来配置漂移
// （如误加 changeEmail / 误把 role 改成 input:true）时无人察觉。
describe("POST /api/auth/update-user（name 写入 + 权限边界）", () => {
  it("AC6b：只带 name → 200 落库，且新值可被 /api/me/profile 读到", async () => {
    const userId = await setupUser("pf-upd-name@test.dev", 0);
    const cookie = await cookieFor(userId);

    const { status, json } = await postUpdateUser({ name: "New Name" }, cookie);
    expect(status).toBe(200);
    expect(json).toEqual({ status: true });
    expect((await userRow(userId)).name).toBe("New Name");

    // 交叉验证：写入路径（update-user）与读取路径（me/profile）看到的是同一个真源
    expect((await getProfile(cookie)).body?.profile.name).toBe("New Name");
  });

  it("AC6：带 email → 400 且 users.email 未被修改（不支持改邮箱）", async () => {
    const userId = await setupUser("pf-upd-email@test.dev", 0);

    const { status, json } = await postUpdateUser(
      { email: "pf-hacked@test.dev" },
      await cookieFor(userId),
    );

    expect(status).toBe(400);
    // 拒绝理由来自库内部（EMAIL_CAN_NOT_BE_UPDATED），证明拦在我们代码之前
    expect(errorMessage(json)).toBe("Email can not be updated");
    expect((await userRow(userId)).email).toBe("pf-upd-email@test.dev");
  });

  it("AC6c：带 role/balance（additionalFields input:false）→ 400 且未被写入", async () => {
    const userId = await setupUser("pf-upd-privesc@test.dev", 42, "member");
    const cookie = await cookieFor(userId);

    // 单发越权字段：parseInputData 命中 input:false 分支即抛错（先于任何写入）
    const onlyElevated = await postUpdateUser({ role: "admin", balance: 9999 }, cookie);
    expect(onlyElevated.status).toBe(400);
    expect(errorMessage(onlyElevated.json)).toBe("role is not allowed to be set");

    // 混发（合法 name + 越权字段）：**整请求被拒**，连合法的 name 都不落库 ——
    // 库的校验在写入之前整体失败，不做部分应用，比 design §7 预期的「丢弃越权字段」更严格。
    const mixed = await postUpdateUser(
      { name: "Still A Member", role: "admin", balance: 9999 },
      cookie,
    );
    expect(mixed.status).toBe(400);

    const row = await userRow(userId);
    expect(row.name).toBe("pf-upd-privesc"); // setupUser 以邮箱前缀作 name
    expect(row.role).toBe("member");
    expect(row.balance).toBe(42);
  });

  it("未登录 → 401 且不写入任何用户行", async () => {
    const userId = await setupUser("pf-upd-anon@test.dev", 0);

    const { status } = await postUpdateUser({ name: "Anonymous Edit" });

    expect(status).toBe(401);
    expect((await userRow(userId)).name).toBe("pf-upd-anon");
  });
});
