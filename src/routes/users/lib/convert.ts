// DB → API 响应转换（type-safety spec：枚举列类型断言集中在转换工具，不散落在 handler）。
import type { User } from "../../../db/schema";
import type { UserRole, UserStatus } from "../../../types";
import { maskInviteCode } from "../../../lib/invites";
import type { InviteCodeResponse, UserResponse } from "../types";

/** DB 用户行 → API 响应（时间戳 ISO 字符串；role/status 窄化为字面量类型）。 */
export function toUserResponse(user: User): UserResponse {
  return {
    id: String(user.id),
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    status: user.status as UserStatus,
    balance: user.balance,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/** 邀请码行 → API 响应（列表不回显完整 code，仅创建响应返回完整 code）。 */
export function toInviteCodeResponse(
  invite: {
    id: number;
    code: string;
    createdBy: number;
    createdAt: Date;
    usedAt: Date | null;
    expiresAt: Date;
  },
  mask: boolean,
): InviteCodeResponse {
  return {
    id: invite.id,
    code: mask ? maskInviteCode(invite.code) : invite.code,
    status: invite.usedAt !== null
      ? "used"
      : invite.expiresAt.getTime() < Date.now()
        ? "expired"
        : "active",
    createdBy: invite.createdBy,
    createdAt: invite.createdAt.toISOString(),
    usedAt: invite.usedAt?.toISOString() ?? null,
    expiresAt: invite.expiresAt.toISOString(),
  };
}
