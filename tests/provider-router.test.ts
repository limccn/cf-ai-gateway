// provider-router 纯函数单测：FNV-1a 确定性、槽位构造、哈希分配（粘性/权重比例）、
// 断路器跳过、单候选短路。KV 使用 miniflare 内存 CACHE_KV（cloudflare:test env）。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  buildSlotMap,
  circuitKey,
  CIRCUIT_TTL_SECONDS,
  fnv1a32,
  isCircuitOpen,
  openCircuit,
  pickHealthyProvider,
  pickIndex,
  pickProvider,
  readCircuit,
  resetOpenSuppressionForTest,
  type RouteCandidate,
} from "../src/lib/provider-router";

const A: RouteCandidate = { providerId: 1, weight: 1 };
const B: RouteCandidate = { providerId: 2, weight: 1 };
const C: RouteCandidate = { providerId: 3, weight: 1 };

beforeAll(async () => {
  // 清空断路器 KV（防跨用例残留）
  const listed = await env.CACHE_KV.list({ prefix: "circuit:" });
  await Promise.all(listed.keys.map((k) => env.CACHE_KV.delete(k.name)));
});

afterEach(async () => {
  const listed = await env.CACHE_KV.list({ prefix: "circuit:" });
  await Promise.all(listed.keys.map((k) => env.CACHE_KV.delete(k.name)));
  resetOpenSuppressionForTest();
});

describe("fnv1a32", () => {
  it("确定性：同输入恒同输出；不同输入大概率不同", () => {
    expect(fnv1a32("1")).toBe(fnv1a32("1"));
    expect(fnv1a32("1")).not.toBe(fnv1a32("2"));
    expect(fnv1a32("12345")).toBe(fnv1a32("12345"));
  });

  it("分布在 32 位区间内", () => {
    for (let i = 0; i < 100; i++) {
      const h = fnv1a32(`key-${i}`);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("buildSlotMap / pickIndex", () => {
  it("权重 1:1 → 两个等宽槽位区间", () => {
    const map = buildSlotMap([A, B]);
    expect(map.total).toBe(2);
    expect(map.cum).toEqual([1, 2]);
    expect(pickIndex(0, map)).toBe(0);
    expect(pickIndex(1, map)).toBe(1);
  });

  it("权重 3:1 → 区间 [0,3)/[3,4)", () => {
    const map = buildSlotMap([{ providerId: 1, weight: 3 }, { providerId: 2, weight: 1 }]);
    expect(map.total).toBe(4);
    expect(map.cum).toEqual([3, 4]);
    expect(pickIndex(0, map)).toBe(0);
    expect(pickIndex(2, map)).toBe(0);
    expect(pickIndex(3, map)).toBe(1);
  });

  it("权重缺失/非法按 1 兜底", () => {
    const map = buildSlotMap([
      { providerId: 1, weight: 0 },
      { providerId: 2, weight: -5 },
      { providerId: 3, weight: 2 },
    ]);
    expect(map.cum).toEqual([1, 2, 4]);
  });
});

describe("pickProvider（哈希分配）", () => {
  it("单候选短路：直接返回，不依赖 keyId", () => {
    expect(pickProvider([A], 1).providerId).toBe(1);
    expect(pickProvider([A], 999).providerId).toBe(1);
  });

  it("粘性：同一 keyId 恒落同一 provider", () => {
    const first = pickProvider([A, B, C], 42);
    for (let i = 0; i < 20; i++) {
      expect(pickProvider([A, B, C], 42).providerId).toBe(first.providerId);
    }
  });

  it("权重 3:1：2000 个 key 落点比例约 75%/25%", () => {
    const candidates = [
      { providerId: 1, weight: 3 },
      { providerId: 2, weight: 1 },
    ];
    let hitsA = 0;
    for (let keyId = 1; keyId <= 2000; keyId++) {
      if (pickProvider(candidates, keyId).providerId === 1) {
        hitsA++;
      }
    }
    const ratio = hitsA / 2000;
    // 二项分布 p=0.75, n=2000 → 3σ ≈ ±2.9%；宽松断言 ±5% 防 flake
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(0.8);
  });

  it("均分：权重 1:1 时两 provider 大致各半", () => {
    let hitsA = 0;
    for (let keyId = 1; keyId <= 2000; keyId++) {
      if (pickProvider([A, B], keyId).providerId === 1) {
        hitsA++;
      }
    }
    const ratio = hitsA / 2000;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });
});

describe("断路器", () => {
  it("circuitKey / TTL 契约（KV 最小 TTL 60s，全分类统一 60s）", () => {
    expect(circuitKey(7)).toBe("circuit:7");
    expect(CIRCUIT_TTL_SECONDS["429"]).toBe(60);
    expect(CIRCUIT_TTL_SECONDS["5xx"]).toBe(60);
    expect(CIRCUIT_TTL_SECONDS.timeout).toBe(60);
    expect(CIRCUIT_TTL_SECONDS.network).toBe(60);
    expect(CIRCUIT_TTL_SECONDS).toMatchObject({
      network: 60,
      timeout: 60,
      "5xx": 60,
      "429": 60,
    });
  });

  it("openCircuit 后 isCircuitOpen = true；reason 可读回", async () => {
    await openCircuit(env.CACHE_KV, 1, "5xx");
    expect(await isCircuitOpen(env.CACHE_KV, 1)).toBe(true);
    const circuit = await readCircuit(env.CACHE_KV, 1);
    expect(circuit?.reason).toBe("5xx");
    expect(typeof circuit?.at).toBe("number");
    // 未断路的 provider 不受影响
    expect(await isCircuitOpen(env.CACHE_KV, 2)).toBe(false);
  });

  it("reason 分类可读回（429 与 5xx 均按 60s TTL 落 KV）", async () => {
    await openCircuit(env.CACHE_KV, 1, "429");
    await openCircuit(env.CACHE_KV, 2, "5xx");
    // KV expirationTtl 由 miniflare 管理，此处仅验证键存在且 reason 正确
    expect((await readCircuit(env.CACHE_KV, 1))?.reason).toBe("429");
    expect((await readCircuit(env.CACHE_KV, 2))?.reason).toBe("5xx");
  });

  it("O6：10s 内重复 openCircuit 只写一次 KV（抑制期内换 reason 也不覆盖）", async () => {
    resetOpenSuppressionForTest();
    await openCircuit(env.CACHE_KV, 11, "5xx");
    expect(await env.CACHE_KV.get(circuitKey(11))).not.toBeNull();
    await openCircuit(env.CACHE_KV, 11, "429");
    // 第二次 put 被抑制 → KV 值未变化（首 reason 的 TTL 生效）
    expect((await readCircuit(env.CACHE_KV, 11))?.reason).toBe("5xx");
  });

  it("O6：超过 10s 后可再次写入（新 reason 生效）", async () => {
    resetOpenSuppressionForTest();
    await openCircuit(env.CACHE_KV, 12, "5xx");
    const originalNow = Date.now;
    Date.now = () => originalNow() + 11_000;
    try {
      await openCircuit(env.CACHE_KV, 12, "429");
    } finally {
      Date.now = originalNow;
    }
    expect((await readCircuit(env.CACHE_KV, 12))?.reason).toBe("429");
  });
});

describe("pickHealthyProvider", () => {
  it("单候选短路：不查询断路器", async () => {
    let checked = false;
    const picked = await pickHealthyProvider([A], 1, async () => {
      checked = true;
      return true;
    });
    expect(picked?.providerId).toBe(1);
    expect(checked).toBe(false);
  });

  it("首选健康 → 直接返回首选（断路器零查询代价）", async () => {
    const opened = new Set<number>();
    const picked = await pickHealthyProvider([A, B, C], 5, async (id) => opened.has(id));
    expect(picked?.providerId).toBe(pickProvider([A, B, C], 5).providerId);
  });

  it("首选断路 → 跳过选下一健康候选（id 升序）", async () => {
    // 数据驱动：先找出落在 A 的 keyId，再断 A → 应取 B
    let keyOnA = 1;
    for (let keyId = 1; keyId < 1000 && pickProvider([A, B, C], keyId).providerId !== 1; keyId++) {
      keyOnA = keyId + 1;
    }
    expect(pickProvider([A, B, C], keyOnA).providerId).toBe(1);
    const opened = new Set<number>([1]);
    const picked = await pickHealthyProvider([A, B, C], keyOnA, async (id) => opened.has(id));
    expect(picked?.providerId).toBe(2);
  });

  it("全部断路 → null", async () => {
    const opened = new Set<number>([1, 2, 3]);
    const picked = await pickHealthyProvider([A, B, C], 5, async (id) => opened.has(id));
    expect(picked).toBeNull();
  });
});
