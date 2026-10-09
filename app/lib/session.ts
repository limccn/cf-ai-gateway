// 会话用户信息的窄化读取（spec type-safety.md：unknown 窄化，不用 any / 非空断言）。
// 后端把 role/status/balance 注册为 Better Auth additionalFields（input: false），
// 随 get-session 的 user 对象下发；客户端类型不感知这些字段，这里做防御性读取。
import type { User } from "better-auth/types";

export type UserRole = "admin" | "member";
export type UserStatus = "active" | "disabled";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: UserRole;
  status: UserStatus;
  balance: number;
}

/** 服务端 additionalFields 的运行时形状（仅用于读取，不用于赋值）。 */
interface ExtendedUserFields {
  role?: unknown;
  status?: unknown;
  balance?: unknown;
  image?: string | null;
}

export function toSessionUser(user: User): SessionUser {
  const extended = user as unknown as ExtendedUserFields;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: extended.image ?? null,
    role: extended.role === "admin" ? "admin" : "member",
    status: extended.status === "disabled" ? "disabled" : "active",
    balance: typeof extended.balance === "number" ? extended.balance : 0,
  };
}
