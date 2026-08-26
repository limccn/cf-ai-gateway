// 响应缓存（M4 4.5）：规范化请求体 hash → KV 缓存（仅非流式）。
// 缓存键 = keyId + model + 规范化 body hash（R7.2：键含 Key 隔离，避免不同 Key 路由到
// 不同 Provider 时串缓存）；命中直接返回（不转发、不扣费），TTL 由 key.cacheTtl 控制。
import { hashToken } from "./security";

const CACHE_PREFIX = "resp:";

/** 递归规范化 JSON：object key 排序、array 逐项、原始值原样，保证等价请求体哈希一致。 */
export function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizeJson(item)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

/** 规范化请求体 → sha256 hex（缓存键主体）。 */
export async function hashRequestBody(body: Record<string, unknown>): Promise<string> {
  return hashToken(JSON.stringify(normalizeJson(body)));
}

export function buildCacheKey(keyId: number, model: string, bodyHash: string): string {
  return `${CACHE_PREFIX}${keyId}:${model}:${bodyHash}`;
}

export async function getCachedResponse(
  kv: KVNamespace,
  cacheKey: string,
): Promise<unknown | null> {
  const raw = await kv.get(cacheKey);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

export async function setCachedResponse(
  kv: KVNamespace,
  cacheKey: string,
  data: unknown,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(cacheKey, JSON.stringify(data), { expirationTtl: ttlSeconds });
}
