// 限流计数器（09-11-kv-ops-optimization O1 方案 B，2026-09-16 用户裁决）：
// isolate 内模块级计数 + KV 定期落账，替换每请求 KV put。
// 动机：KV 写价 ≈ 读价 10 倍 + 单键 1 写/秒软限速 → 降写优先。
// 语义保留：每 key 自由限速值、计数后移（5xx 不计数）、429 不计数、Remaining 头公式。
// 精度代价（已裁决）：跨 isolate 超发 ≈ FLUSH_DELTA_THRESHOLD × 活跃 isolate 数，
//   与现状「get+put 非原子 + 跨 colo 最终一致」同量级（design.md §2.2）。
import type { KVNamespace } from "@cloudflare/workers-types";

/** 固定窗口长度（秒）；qpsLimit 语义 = 每分钟请求上限。 */
export const WINDOW_SECONDS = 60;
/** KV 计数器 TTL：两倍窗口，防残留。 */
export const COUNTER_TTL_SECONDS = WINDOW_SECONDS * 2;
/** local 增量达此值即落账（低 QPS 收益杠杆；同时是超发上界系数）。 */
export const FLUSH_DELTA_THRESHOLD = 5;
/** dirty 超过此秒数未落账则随下次请求兜底落账（极低 QPS 不悬挂）。 */
export const FLUSH_MAX_AGE_SECONDS = 30;
/** 落账失败退避秒数（防 KV 故障期每请求重试落账）。 */
export const FLUSH_FAIL_BACKOFF_SECONDS = 5;

interface CounterEntry {
  windowStart: number;
  /** 本 isolate 未落账增量。 */
  local: number;
  dirty: boolean;
  /** 落账在飞（合并同键并发触发；isolate 单线程，标志读写无竞争）。 */
  flushing: boolean;
  lastFlushAt: number;
}

/** isolate 模块级状态：keyId → 当前窗口计数条目。 */
const counters = new Map<number, CounterEntry>();

export function kvKey(keyId: number, windowStart: number): string {
  return `rate:${keyId}:${windowStart}`;
}

/** 窗口起点（unix 秒）：对齐 60s 分桶。 */
export function windowStartOf(nowMs: number): number {
  return Math.floor(nowMs / (WINDOW_SECONDS * 1000)) * WINDOW_SECONDS;
}

/**
 * 检查路径：确保窗口条目存在。窗口翻转 → 重置；旧窗口未落账 local 直接丢弃
 * （旧键已无读者——新请求全部用新 windowStart，TTL 120s 自灭，无需翻转落账）。
 */
export function ensureEntry(keyId: number, windowStart: number): CounterEntry {
  const existing = counters.get(keyId);
  if (existing && existing.windowStart === windowStart) {
    return existing;
  }
  const entry: CounterEntry = {
    windowStart,
    local: 0,
    dirty: false,
    flushing: false,
    lastFlushAt: Date.now(),
  };
  counters.set(keyId, entry);
  return entry;
}

/**
 * 计数路径（next() 后 status<500）：本地 +1，返回是否应触发落账。
 * 窗口比对防长流式跨边界误记（流式 next() 可达 30s+，期间窗口可能翻转、
 * entry 可能已被其他请求重置——旧窗口计数丢弃，与检查侧丢旧逻辑对称）。
 */
export function recordIncrement(keyId: number, windowStart: number): boolean {
  const entry = counters.get(keyId);
  if (!entry || entry.windowStart !== windowStart) {
    return false;
  }
  entry.local += 1;
  entry.dirty = true;
  return shouldFlush(entry);
}

/**
 * 落账触发：dirty ∧ 未在飞 ∧ 非退避期 ∧（delta 达阈值 ∨ 兜底时限到）。
 * 退避闸（`now < lastFlushAt`）：落账失败时 lastFlushAt 被推后到 now + 5s——若无此闸，
 * 失败不减量（local 仍 ≥ 阈值）使 delta 条件恒真 → KV 故障期每请求重试落账
 * （1 读 + 1 写/请求，写量反而超过优化前的每请求 1 写），FLUSH_FAIL_BACKOFF_SECONDS 形同虚设。
 * 成功落账 lastFlushAt = now → 闸立即放行（正常路径零影响）。
 */
export function shouldFlush(entry: CounterEntry): boolean {
  if (!entry.dirty || entry.flushing) {
    return false;
  }
  const now = Date.now();
  if (now < entry.lastFlushAt) {
    return false;
  }
  return (
    entry.local >= FLUSH_DELTA_THRESHOLD ||
    now - entry.lastFlushAt >= FLUSH_MAX_AGE_SECONDS * 1000
  );
}

/**
 * 落账：读改写合并到 KV（调用方 waitUntil 旁路）。
 * 成功后减量不置零（落账期间的新增量保留，下次触发再合并）；
 * 失败退避保持 dirty（下次请求重试，不每请求撞 KV）。
 * 双 isolate 并发落账互覆 → 少记 → 超发，有界（design.md §2.2）。
 */
export async function flushEntry(
  kv: KVNamespace,
  keyId: number,
  entry: CounterEntry,
): Promise<void> {
  if (counters.get(keyId) !== entry) {
    // 窗口翻转后条目已被替换：旧窗口键已无读者，防御性跳过（不写死数据）
    return;
  }
  entry.flushing = true;
  const delta = entry.local;
  try {
    const raw = await kv.get(kvKey(keyId, entry.windowStart));
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    const snapshot = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    await kv.put(kvKey(keyId, entry.windowStart), String(snapshot + delta), {
      expirationTtl: COUNTER_TTL_SECONDS,
    });
    entry.local -= delta;
    entry.lastFlushAt = Date.now();
    entry.dirty = entry.local > 0;
  } catch {
    entry.lastFlushAt = Date.now() + FLUSH_FAIL_BACKOFF_SECONDS * 1000;
  } finally {
    entry.flushing = false;
  }
}

/** 测试隔离：清空模块级计数状态（同 isolate 跨用例残留防护）。 */
export function resetAllForTest(): void {
  counters.clear();
}
