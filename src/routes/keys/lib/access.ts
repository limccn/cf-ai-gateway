// 密钥归属校验（member 只能操作自己的 Key；admin 可操作全部）。
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db";
import { apiKeys } from "../../../db/schema";
import type { ApiKey } from "../../../db/schema";
import type { UserRole } from "../../../types";

/**
 * 按 id 读取 Key 并校验访问权。
 * @returns 无权/不存在返回 null（统一 404，不泄露 Key 是否存在）。
 */
export async function findAuthorizedKey(
  db: Db,
  keyId: number,
  userId: number,
  role: UserRole,
): Promise<ApiKey | null> {
  const where =
    role === "admin"
      ? eq(apiKeys.id, keyId)
      : and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId));
  const found = await db.query.apiKeys.findFirst({ where });
  return found ?? null;
}
