// DB → API 响应转换（type-safety spec：枚举/状态窄化集中在转换工具）。
import type { ApiKey } from "../../../db/schema";
import type { KeyResponse } from "../types";

export type ApiKeyStatus = "active" | "revoked";

/** DB api_keys 行 → API 响应（prefix 已脱敏展示）。 */
export function toKeyResponse(key: ApiKey): KeyResponse {
  return {
    id: key.id,
    userId: key.userId,
    name: key.name,
    prefix: `${key.prefix}****`,
    status: key.status as ApiKeyStatus,
    qpsLimit: key.qpsLimit,
    cacheEnabled: key.cacheEnabled,
    cacheTtl: key.cacheTtl,
    createdAt: key.createdAt.toISOString(),
  };
}
