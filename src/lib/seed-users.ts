// 测试用户种子配置（dev-only）：解析 env.SEED_USERS，**仅供** dev-only 种子路由
// （POST /api/seed/users）使用 —— 生产鉴权路径（src/lib/auth.ts）对它已无任何引用点
// （09-22-seed-users-dev-only 删除"种子邮箱绕过邀请码"逃生口之后成立）。
// 红线：本开关只在本地 dev 设置；生产/staging 收到该 env 即视为配置事故（`POST /api/seed/users`
// 造号端点被暴露）。⚠ 安全**不再依赖"变量没被设置"** —— 鉴权侧已与它结构性无关，见上。
// 格式（JSON 数组字符串）：
//   [{"email":"admin@local.dev","password":"min8","name":"Admin","role":"admin"}, ...]
import type { UserRole } from "../types";

export interface SeedUserSpec {
  email: string;
  password: string;
  name: string;
  role: UserRole;
}

/**
 * 解析 SEED_USERS。返回 null 表示未配置（种子功能关闭）；
 * 配置了但格式非法时抛错（fail-fast —— 配置事故必须当场暴露，而不是静默降级）。
 */
export function parseSeedUsers(raw: string | undefined): SeedUserSpec[] | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SEED_USERS is not valid JSON — fix or remove the variable");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEED_USERS must be a JSON array");
  }
  return parsed.map((item, index): SeedUserSpec => {
    const row = item as Record<string, unknown>;
    if (typeof row.email !== "string" || !row.email.includes("@")) {
      throw new Error(`SEED_USERS[${index}]: invalid email`);
    }
    if (typeof row.password !== "string" || row.password.length < 8) {
      throw new Error(`SEED_USERS[${index}] (${row.email}): password must be >= 8 chars`);
    }
    const role: UserRole =
      row.role === "admin" || row.role === "member" ? row.role : "member";
    const defaultName = row.email.split("@")[0] ?? row.email;
    return {
      email: row.email,
      password: row.password,
      name: typeof row.name === "string" && row.name !== "" ? row.name : defaultName,
      role,
    };
  });
}
