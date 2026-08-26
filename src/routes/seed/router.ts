// 测试用户批量初始化路由（dev-only）：POST /api/seed/users。
// - 仅当 env.SEED_USERS 配置时可用；未配置 → 404（路由始终挂载，内部 gating，
//   避免"环境变量存在才注册路由"的冷启动时序问题）。
// - 用户创建走 Better Auth signUpEmail（正确哈希密码），admin 提升复用
//   DEPLOY.md Step 7 的 sanctioned 操作（UPDATE users SET role）。
// - 幂等：已存在的邮箱跳过（按 email 查询）。
// - 红线：生产禁止设置 SEED_USERS；任何人（含路由代码）不得在此回显密码。
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createAuth } from "../../lib/auth";
import { createDb } from "../../db";
import { users } from "../../db/schema";
import { parseSeedUsers, type SeedUserSpec } from "../../lib/seed-users";
import type { AppEnv } from "../../types";

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

  const res = await auth.api.signUpEmail({
    body: {
      email: spec.email,
      password: spec.password,
      name: spec.name,
      // inviteCode 是 input additionalField（类型必填）；种子路径在 validateUserInfo
      // 中按邮箱白名单直接放行，不会消费该值 —— 传空串即可。
      inviteCode: "",
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