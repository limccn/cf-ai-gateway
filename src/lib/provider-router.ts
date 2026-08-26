// 多 Upstream 路由纯函数层（design.md §2）：候选池选择 + FNV-1a 哈希槽位分配 + 断路器读写。
// 无状态、确定性、零共享存储：分配只需 keyId（integer），无需轮询计数器或跨请求状态。
// 断路器 KV 由调用方注入（复用 CACHE_KV，键前缀 `circuit:` 与缓存键隔离）。
// 单候选短路保证：|C|==1 时调用方不应进入本模块的 KV/重试路径，行为与现状逐字节一致。
import type { Provider } from "../db/schema";

export interface RouteCandidate {
  providerId: number;
  weight: number;
}

/** 上游失败分类 → 断路器 reason（保留分类供管理面展示/诊断）。 */
export type CircuitReason = "network" | "timeout" | "5xx" | "429";

export const CIRCUIT_KEY_PREFIX = "circuit:";
/**
 * 断路器 TTL：统一 60s — Cloudflare KV expirationTtl 最小值为 60，
 * 设计中的 429 短 TTL（30s）不可行（实测 miniflare 拒绝 <60 的 TTL）。
 * 60s 窗口内跳过断路 provider，到期自动恢复（open 态标准语义）。
 */
export const CIRCUIT_TTL_SECONDS: Record<CircuitReason, number> = {
  network: 60,
  timeout: 60,
  "5xx": 60,
  "429": 60,
};

/** DB providers 行 → 候选（weight 缺失/非法按 1 兜底，防御性）。 */
export function toCandidates(rows: Provider[]): RouteCandidate[] {
  return rows.map((r) => ({
    providerId: r.id,
    weight: typeof r.weight === "number" && r.weight >= 1 ? r.weight : 1,
  }));
}

/**
 * FNV-1a 32 位（确定性、同步，跨运行时一致）。
 * Math.imul 保证 32 位乘法精确（普通乘法的 2^56 乘积会丢精度）。
 */
export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(hash ^ str.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 权重 → 累加上界区间（半开区间 [cum[i-1], cum[i]) 归属候选 i；总槽位 = Σweight）。 */
export function buildSlotMap(candidates: RouteCandidate[]): { cum: number[]; total: number } {
  const cum: number[] = [];
  let acc = 0;
  for (const c of candidates) {
    acc += Math.max(1, Math.floor(c.weight));
    cum.push(acc);
  }
  return { cum, total: acc };
}

/**
 * 索引访问守卫：越界抛 RangeError（调用方保证在界内，防御性兜底）。
 * 仓库 lint 禁用非空断言，统一用显式守卫模式。
 */
export function atOrThrow<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`${label}: index ${index} out of bounds`);
  }
  return item;
}

/** hash 落点 → 候选下标（候选数少（≤ 数百），线性扫描即可，无分配开销）。 */
export function pickIndex(slot: number, map: { cum: number[]; total: number }): number {
  const s = slot % map.total;
  let i = 0;
  for (const bound of map.cum) {
    // cum 恒非空且升序（buildSlotMap 保证至少一项）；落点必落在某区间内
    if (s < bound) {
      return i;
    }
    i++;
  }
  return map.cum.length - 1;
}

/**
 * keyId 级哈希选择：同 keyId + 同候选池恒同落点（粘性）；权重按槽位比例分配。
 * 单候选直接返回（零计算）。权重配置变更 → 槽位重分布（配置变更语义，可接受）。
 */
export function pickProvider(candidates: RouteCandidate[], keyId: number): RouteCandidate {
  if (candidates.length === 1) {
    return atOrThrow(candidates, 0, "pickProvider");
  }
  const map = buildSlotMap(candidates);
  return atOrThrow(candidates, pickIndex(fnv1a32(String(keyId)), map), "pickProvider");
}

/** 断路器键（CACHE_KV 复用；与缓存键（keyId:model:hash）前缀隔离，无冲突）。 */
export function circuitKey(providerId: number): string {
  return `${CIRCUIT_KEY_PREFIX}${providerId}`;
}

/** 断路器读：有值即断路（open 态）；null 即健康。 */
export async function isCircuitOpen(kv: KVNamespace, providerId: number): Promise<boolean> {
  return (await readCircuit(kv, providerId)) !== null;
}

/** 断路器详情读（管理面展示用）：返回断路时间与原因；健康返回 null。 */
export async function readCircuit(
  kv: KVNamespace,
  providerId: number,
): Promise<{ at: number; reason: CircuitReason } | null> {
  const raw = await kv.get(circuitKey(providerId));
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      const at = typeof o.at === "number" ? o.at : Date.now();
      const reason = ["network", "timeout", "5xx", "429"].includes(String(o.reason))
        ? (o.reason as CircuitReason)
        : "5xx";
      return { at, reason };
    }
  } catch {
    // 值损坏按断路处理（TTL 自灭，无需清理）
  }
  return { at: Date.now(), reason: "5xx" };
}

/** 断路器写：失败分类 → TTL 自动过期恢复（open 态标准语义，无需清理任务）。 */
export async function openCircuit(
  kv: KVNamespace,
  providerId: number,
  reason: CircuitReason,
): Promise<void> {
  await kv.put(
    circuitKey(providerId),
    JSON.stringify({ at: Date.now(), reason }),
    { expirationTtl: CIRCUIT_TTL_SECONDS[reason] },
  );
}

/**
 * 首选（hash 落点）断路 → 按 id 升序取下一健康候选；全部断路返回 null（调用方 502）。
 * 典型路径 1 次 KV 读（首选健康）；首选断路时最多读全部候选。
 */
export async function pickHealthyProvider(
  candidates: RouteCandidate[],
  keyId: number,
  isOpen: (providerId: number) => Promise<boolean>,
): Promise<RouteCandidate | null> {
  if (candidates.length === 1) {
    return atOrThrow(candidates, 0, "pickHealthyProvider");
  }
  const primary = pickProvider(candidates, keyId);
  if (!(await isOpen(primary.providerId))) {
    return primary;
  }
  for (const c of candidates) {
    if (c.providerId === primary.providerId) {
      continue;
    }
    if (!(await isOpen(c.providerId))) {
      return c;
    }
  }
  return null;
}
