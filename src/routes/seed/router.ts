// 测试用户批量初始化路由（dev-only）：POST /api/seed/users。
// - 仅当 env.SEED_USERS 配置时可用；未配置 → 404（路由始终挂载，内部 gating，
//   避免"环境变量存在才注册路由"的冷启动时序问题）。
// - 用户创建走 Better Auth signUpEmail（正确哈希密码），admin 提升复用
//   DEPLOY.md Step 7 的 sanctioned 操作（UPDATE users SET role）。
// - 幂等：已存在的邮箱跳过（按 email 查询）。
// - 红线：生产禁止设置 SEED_USERS；任何人（含路由代码）不得在此回显密码。
// - 09-22-seed-users-dev-only：**种子用户自铸一次性邀请码**（seedOneUser）—— 原先"种子邮箱在
//   validateUserInfo 里被白名单放行、不消费邀请码"的逃生口已整体删除，种子改走与真实用户
//   **完全相同**的注册校验 + 消费链路。本文件 + src/lib/seed-users.ts 是 SEED_USERS 的全部读者。
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createAuth } from "../../lib/auth";
import { createDb } from "../../db";
import { inviteCodes, users } from "../../db/schema";
import { generateInviteCode } from "../../lib/invites";
import { parseSeedUsers, type SeedUserSpec } from "../../lib/seed-users";
import type { AppEnv } from "../../types";

/** 种子码有效期：码在本次请求内即被消费，1 小时只是"铸了没被消费"时的防御性上界。 */
const SEED_INVITE_TTL_MS = 60 * 60 * 1000;

const app = new Hono<AppEnv>();

app.post("/users", async (c) => {
  const specs = parseSeedUsers(c.env.SEED_USERS);
  if (specs === null) {
    return c.json({ error: { message: "Not Found" } }, 404);
  }

  const db = createDb(c.env);
  const auth = createAuth(c.env, db);
  const created: { email: string; role: string }[] = [];
  const skipped: { email: string }[] = [];
  const failed: { email: string; error: string }[] = [];

  for (const spec of specs) {
    try {
      const outcome = await seedOneUser(db, auth, spec);
      if (outcome.kind === "created") {
        created.push({ email: spec.email, role: spec.role });
      } else {
        skipped.push({ email: spec.email });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      c.get("logger").error("seed_user_failed", { email: spec.email, error: message });
      failed.push({ email: spec.email, error: message });
    }
  }

  return c.json({ success: true, created, skipped, failed });
});

type SeedOutcome = { kind: "created" } | { kind: "skipped" };

async function seedOneUser(
  db: ReturnType<typeof createDb>,
  auth: ReturnType<typeof createAuth>,
  spec: SeedUserSpec,
): Promise<SeedOutcome> {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, spec.email),
    columns: { id: true },
  });
  if (existing) {
    return { kind: "skipped" };
  }

  // 先铸一张一次性邀请码，再交给 signUpEmail —— 种子用户因此经过与真实用户相同的
  // validateUserInfo 校验与 create.before 消费（铸码失败即抛错 → 落 failed[]，不静默跳过）。
  //
  // createdBy 留 null（决策 D-F1）：**空库里的第一张邀请码结构性没有合法签发者** ——
  // 铸码必须早于 signUpEmail，此刻目标用户尚不存在，且 users.id 由 D1 自增
  // （advanced.database.generateId = "serial"）无从预知，而 FK 是立即检查 ⇒ 只能留空。
  // 生产路径恒有签发者（admin 在管理端发起），故该列在 prod 上不会出现 NULL。
  const code = generateInviteCode();
  await db.insert(inviteCodes).values({
    code,
    createdBy: null,
    expiresAt: new Date(Date.now() + SEED_INVITE_TTL_MS),
  });

  const res = await auth.api.signUpEmail({
    body: {
      email: spec.email,
      password: spec.password,
      name: spec.name,
      inviteCode: code,
    },
  });
  if (!res.user || !res.user.id) {
    throw new Error("signUpEmail returned no user");
  }

  if (spec.role === "admin") {
    await db
      .update(users)
      .set({ role: "admin" })
      .where(eq(users.id, Number(res.user.id)));
  }
  return { kind: "created" };
}

export default app;