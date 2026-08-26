// 共享类型（spec environment.md：集中式类型系统）。
// Bindings 来自 `wrangler types` 生成的 worker-configuration.d.ts（D1/KV/Queues 绑定），
// 字符串环境变量（BETTER_AUTH_* 等）在 src/env.d.ts 中通过接口合并补充。
import type { Logger } from "./lib/logger";
import type { AuthInstance } from "./lib/auth";
import type { ApiKey, User } from "./db/schema";

export type Bindings = Env;

// 用户角色 / 状态（users.role / users.status 列的窄化字面量类型）
export type UserRole = "admin" | "member";
export type UserStatus = "active" | "disabled";

// Better Auth getSession 的返回类型（user 携带 additionalFields：role/status/balance）
type SessionResult = Awaited<ReturnType<AuthInstance["api"]["getSession"]>>;
export type AuthSession = NonNullable<SessionResult>["session"];
export type SessionUser = NonNullable<SessionResult>["user"];

/** 代理面鉴权上下文（由 gatewayAuth 中间件注入 /v1/* 请求）。 */
export type GatewayAuthContext = {
  /** api_keys 行（active） */
  key: ApiKey;
  /** 关联 users 行（active，balance 用于余额检查） */
  user: User;
};

export type Variables = {
  requestId: string;
  logger: Logger;
  // 由 requireSession 注入（Better Auth 会话解析结果 + userId/role 快照）
  session?: AuthSession;
  user?: SessionUser;
  userId?: string;
  role?: UserRole;
  // 由 gatewayAuth 注入（代理面 Bearer 网关 Key 鉴权，与 /api/* 会话鉴权并存）
  gatewayAuth?: GatewayAuthContext;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
