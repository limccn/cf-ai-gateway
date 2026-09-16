// O1 方案 B 限流计数器单测（09-11-kv-ops-optimization）：
// 模块级 isolate 计数 + KV 落账。用计数 KV mock 断言 KV 操作数（防回潮：
// 每请求写必须为 0，落账仅 delta≥5 / 30s 兜底触发）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  COUNTER_TTL_SECONDS,
  FLUSH_DELTA_THRESHOLD,
  FLUSH_FAIL_BACKOFF_SECONDS,
  FLUSH_MAX_AGE_SECONDS,
  ensureEntry,
  flushEntry,
  kvKey,
  recordIncrement,
  resetAllForTest,
  windowStartOf,
} from "../src/lib/rate-counter";

const FROZEN_NOW = 1_700_000_000_000;
const ORIGINAL_DATE_NOW = Date.now;

interface PutRecord {
  key: string;
  value: string;
  expirationTtl?: number;
}

/** 计数 KV mock：记录 get/put 调用次数与 put 参数，行为近似 miniflare KV。 */
function makeCountingKv(): {
  kv: KVNamespace;
  counts: { get: number; put: number };
  puts: PutRecord[];
  failNextPut: () => void;
} {
  const store = new Map<string, string>();
  const puts: PutRecord[] = [];
  const counts = { get: 0, put: 0 };
  let putShouldFail = false;
  const kv = {
    async get(key: string): Promise<string | null> {
      counts.get += 1;
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      counts.put += 1;
      if (putShouldFail) {
        putShouldFail = false;
        throw new Error("mock kv put failure");
      }
      puts.push({ key, value, expirationTtl: opts?.expirationTtl });
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return {
    kv,
    counts,
    puts,
    failNextPut: () => {
      putShouldFail = true;
    },
  };
}

beforeEach(() => {
  Date.now = () => FROZEN_NOW;
  resetAllForTest();
});

afterEach(() => {
  Date.now = ORIGINAL_DATE_NOW;
  resetAllForTest();
});

describe("rate-counter（O1 方案 B）", () => {
  it("窗口起点对齐 60s 分桶", () => {
    expect(windowStartOf(FROZEN_NOW)).toBe(Math.floor(FROZEN_NOW / 60_000) * 60);
    expect(kvKey(7, 1234)).toBe("rate:7:1234");
  });

  it("delta 未达阈值：每请求 0 KV 写（防回潮核心断言）", () => {
    const { counts } = makeCountingKv();
    const windowStart = windowStartOf(Date.now());
    ensureEntry(1, windowStart);
    for (let i = 0; i < FLUSH_DELTA_THRESHOLD - 1; i += 1) {
      expect(recordIncrement(1, windowStart)).toBe(false);
    }
    expect(counts.put).toBe(0);
    expect(counts.get).toBe(0);
  });

  it("delta 达阈值：触发一次落账，读改写合并，减量清零", async () => {
    const { kv, counts, puts } = makeCountingKv();
    const windowStart = windowStartOf(Date.now());
    const entry = ensureEntry(1, windowStart);
    for (let i = 0; i < FLUSH_DELTA_THRESHOLD; i += 1) {
      recordIncrement(1, windowStart);
    }
    await flushEntry(kv, 1, entry);
    expect(counts.get).toBe(1);
    expect(counts.put).toBe(1);
    expect(puts[0]).toEqual({
      key: kvKey(1, windowStart),
      value: String(FLUSH_DELTA_THRESHOLD),
      expirationTtl: COUNTER_TTL_SECONDS,
    });
    expect(entry.local).toBe(0);
    expect(entry.dirty).toBe(false);
    expect(entry.flushing).toBe(false);
  });

  it("落账期间新增量保留：减量不置零，二次落账补齐", async () => {
    const { kv, puts } = makeCountingKv();
    const windowStart = windowStartOf(Date.now());
    const entry = ensureEntry(1, windowStart);
    for (let i = 0; i < FLUSH_DELTA_THRESHOLD; i += 1) {
      recordIncrement(1, windowStart);
    }
    // 落账在飞时新增量（flushEntry 内 await 间隙的并发请求）
    const flushPromise = flushEntry(kv, 1, entry);
    recordIncrement(1, windowStart);
    recordIncrement(1, windowStart);
    await flushPromise;
    expect(entry.local).toBe(2);
    expect(entry.dirty).toBe(true);
    await flushEntry(kv, 1, entry);
    expect(puts[1]?.value).toBe(String(FLUSH_DELTA_THRESHOLD + 2));
    expect(entry.local).toBe(0);
  });

  it("窗口翻转：旧 dirty 丢弃不落账，新窗口从 0 起", async () => {
    const { kv, counts } = makeCountingKv();
    const oldWindow = windowStartOf(Date.now());
    const entry = ensureEntry(1, oldWindow);
    recordIncrement(1, oldWindow);
    recordIncrement(1, oldWindow);
    expect(entry.dirty).toBe(true);
    // 窗口翻转 → ensureEntry 重置
    const newEntry = ensureEntry(1, oldWindow + 60);
    expect(newEntry.local).toBe(0);
    expect(newEntry.dirty).toBe(false);
    // 旧窗口计数路径：比对不过 → 丢弃
    expect(recordIncrement(1, oldWindow)).toBe(false);
    // 旧条目引用落账：stale 防御守卫跳过，不写死数据
    await flushEntry(kv, 1, entry);
    expect(counts.put).toBe(0);
    expect(counts.get).toBe(0);
  });

  it("落账失败：退避且保持 dirty，退避期后恢复重试", async () => {
    const { kv, counts, failNextPut } = makeCountingKv();
    const windowStart = windowStartOf(Date.now());
    const entry = ensureEntry(1, windowStart);
    for (let i = 0; i < FLUSH_DELTA_THRESHOLD; i += 1) {
      recordIncrement(1, windowStart);
    }
    failNextPut();
    await flushEntry(kv, 1, entry);
    expect(counts.put).toBe(1);
    expect(entry.dirty).toBe(true);
    expect(entry.local).toBe(FLUSH_DELTA_THRESHOLD);
    expect(entry.flushing).toBe(false);
    // 退避期后恢复可触发
    const originalNow = Date.now();
    Date.now = () => originalNow + (FLUSH_FAIL_BACKOFF_SECONDS + 1) * 1000;
    expect(recordIncrement(1, windowStart)).toBe(true);
    await flushEntry(kv, 1, entry);
    expect(counts.put).toBe(2);
    expect(entry.local).toBe(0);
  });

  it("退避期内 delta 超阈值也不重试落账（KV 故障期写不放大）", async () => {
    const { kv, counts, failNextPut } = makeCountingKv();
    const windowStart = windowStartOf(Date.now());
    const entry = ensureEntry(1, windowStart);
    for (let i = 0; i < FLUSH_DELTA_THRESHOLD; i += 1) {
      recordIncrement(1, windowStart);
    }
    failNextPut();
    await flushEntry(kv, 1, entry);
    expect(counts.put).toBe(1);
    // 失败不减量 → local 仍 ≥ 阈值，delta 条件恒真（退避闸失效则为每请求重试）
    expect(entry.local).toBe(FLUSH_DELTA_THRESHOLD);
    const base = Date.now();
    Date.now = () => base + 1000;
    expect(recordIncrement(1, windowStart)).toBe(false);
    expect(recordIncrement(1, windowStart)).toBe(false);
    expect(counts.get).toBe(1); // 仅首次落账那次读：退避期零 KV 操作
    expect(counts.put).toBe(1);
    // 退避期满（+5s）→ 恢复触发（积压一并落账）
    Date.now = () => base + FLUSH_FAIL_BACKOFF_SECONDS * 1000;
    expect(recordIncrement(1, windowStart)).toBe(true);
    await flushEntry(kv, 1, entry);
    expect(counts.put).toBe(2);
    expect(entry.local).toBe(0);
  });

  it("MAX_AGE 兜底：低 QPS（delta 不达阈值）超时后落账", async () => {
    const { kv, counts, puts } = makeCountingKv();
    const windowStart = windowStartOf(Date.now());
    const entry = ensureEntry(1, windowStart);
    recordIncrement(1, windowStart);
    expect(entry.local).toBe(1);
    const originalNow = Date.now();
    Date.now = () => originalNow + (FLUSH_MAX_AGE_SECONDS + 1) * 1000;
    expect(recordIncrement(1, windowStart)).toBe(true);
    await flushEntry(kv, 1, entry);
    expect(counts.put).toBe(1);
    expect(puts[0]?.value).toBe("2");
  });

  it("不同 keyId 条目隔离", () => {
    const windowStart = windowStartOf(Date.now());
    const a = ensureEntry(1, windowStart);
    const b = ensureEntry(2, windowStart);
    recordIncrement(1, windowStart);
    recordIncrement(1, windowStart);
    expect(a.local).toBe(2);
    expect(b.local).toBe(0);
  });

  it("COUNTER_TTL_SECONDS = 2 × 窗口（常量防回潮）", () => {
    expect(COUNTER_TTL_SECONDS).toBe(120);
  });
});
