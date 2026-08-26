// 邀请码体系（M2 2.3）：admin 生成 → 邮箱密码注册携带。
// 存储：invite_codes 表；code 明文存储（一次性使用），usedAt 通过条件 UPDATE 乐观锁置位。
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { inviteCodes } from "../db/schema";

// 邀请码字符集：去掉易混淆的 0/O/1/I/L
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * 生成一次性邀请码（crypto.getRandomValues，~62 bits 熵）。
 * 注意：必须在请求处理函数内调用（Cloudflare Workers 禁止全局作用域随机）。
 */
export function generateInviteCode(length = 10): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => CODE_CHARS[byte % CODE_CHARS.length]).join(
    "",
  );
}

/**
 * 校验并消费邀请码（原子：条件 UPDATE 防并发重复使用）。
 * 注意：在 validateUserInfo 中调用时新用户 id 尚未生成，故只记录 usedAt。
 * @returns 消费成功返回 true；不存在/已使用/已过期返回 false。
 */
export async function consumeInviteCode(
  db: Db,
  code: string,
): Promise<boolean> {
  const normalized = code.trim().toUpperCase();
  if (normalized.length === 0) {
    return false;
  }
  const record = await db.query.inviteCodes.findFirst({
    where: eq(inviteCodes.code, normalized),
  });
  if (!record) {
    return false;
  }
  if (record.usedAt !== null) {
    return false;
  }
  if (record.expiresAt.getTime() < Date.now()) {
    return false;
  }
  // 乐观锁：仅当仍未被使用时置位
  const result = await db
    .update(inviteCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(inviteCodes.id, record.id), isNull(inviteCodes.usedAt)));
  return result.meta.changes === 1;
}

/** 展示用脱敏：仅保留前 4 位（列表接口不回显完整 code）。 */
export function maskInviteCode(code: string): string {
  return `${code.slice(0, 4)}****`;
}
