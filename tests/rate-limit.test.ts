// M4 限流单测（4.4）：KV 固定窗口计数器；qps_limit 可配置；超限 429。
// 说明：限流按分钟窗口分桶，而不可达上游每次请求耗时约 2s，容易跨分钟边界；
// 因此本文件冻结 Date.now 保证窗口确定（主 worker 与测试同 isolate，全局 mock 对其生效）。
// 计数后移语义：响应返回后才消耗配额 —— 5xx（上游失败）不计数、4xx（网关拦截，如
// 债务模型下负余额 402）计数。限流用例用负余额制造稳定 402（计数确定，不依赖上游）。
// 09-11-kv-ops-optimization（O1 方案 B）：计数在 isolate 模块级 Map + KV 定期落账，
// 末段用例以计数 KV 包装（helpers.countKvOps）断言「每请求 1 读 0 写」防回潮。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllForTest } from "../src/lib/rate-counter";
import {
  applyMigrations,
  clearKv,
  countKvOps,
  selfFetch,
  setupKey,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const FROZEN_NOW = 1_700_000_000_000;
const ORIGINAL_DATE_NOW = Date.now;

beforeEach(() => {
  Date.now = () => FROZEN_NOW;
});

afterEach(() => {
  // 恢复真实时钟，避免影响其他用例
  Date.now = ORIGINAL_DATE_NOW;
  // O1：计数为 isolate 模块级 Map（clearKv 清不掉）→ 用例间显式复位
  resetAllForTest();
});

const BODY = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
};

async function postChat(plaintext: string): Promise<Response> {
  return selfFetch("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify(BODY),
  });
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

describe("限流（KV 固定窗口）", () => {
  it("qpsLimit=2：前两次放行（非 429），第三次 429", async () => {
    // 负余额：债务模型下每请求被 402 网关拦截（4xx 计数）→ 限流计数确定
    const userId = await setupUser("ratelimit@test.dev", -1);
    const { plaintext } = await setupKey(userId, { qpsLimit: 2 });
    await setupProviderWithModel("gpt-4o-mini");

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await postChat(plaintext);
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(402);
    expect(statuses[1]).toBe(402);
    expect(statuses[2]).toBe(429);

    // 429 响应为 OpenAI 风格错误体
    const res = await postChat(plaintext);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBeTruthy();
  });

  it("默认 qpsLimit=60：三次请求均放行（不 429）", async () => {
    const userId = await setupUser("ratelimit-default@test.dev", -1);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel("gpt-4o-mini");

    for (let i = 0; i < 3; i += 1) {
      const res = await postChat(plaintext);
      expect(res.status).not.toBe(429);
    }
  });

  it("不同 Key 的计数器相互隔离", async () => {
    const userId = await setupUser("ratelimit-iso@test.dev", -1);
    const a = await setupKey(userId, { qpsLimit: 1 });
    const b = await setupKey(userId, { qpsLimit: 1 });
    await setupProviderWithModel("gpt-4o-mini");

    // key a 消耗掉唯一配额
    const firstA = await postChat(a.plaintext);
    expect(firstA.status).toBe(402);
    const secondA = await postChat(a.plaintext);
    expect(secondA.status).toBe(429);

    // key b 不受影响
    const firstB = await postChat(b.plaintext);
    expect(firstB.status).toBe(402);
  });

  it("5xx 上游失败不消耗配额（计数后移）：qpsLimit=1 连续 502 均非 429", async () => {
    const userId = await setupUser("ratelimit-5xx@test.dev", 10);
    const { plaintext } = await setupKey(userId, { qpsLimit: 1 });
    await setupProviderWithModel("gpt-4o-mini");

    // 正余额 → 请求触达不可达上游 → 502；计数后移语义下 502 不计数 → 不触发 429
    const first = await postChat(plaintext);
    expect(first.status).toBe(502);
    const second = await postChat(plaintext);
    expect(second.status).toBe(502);
  });
});

/** O1 防回潮：每请求 KV 操作数断言（含落账写上界）。 */
describe("O1 限流 KV 操作数（每请求 1 读 0 写，防回潮）", () => {
  it("delta 达阈值前零写；10 请求写 ≤ 3（旧实现为 10 写）", async () => {
    // 负余额：每请求被网关 402 拦截（4xx 计数）→ 计数确定，不依赖上游
    const userId = await setupUser("ratelimit-kvops@test.dev", -1);
    const { plaintext } = await setupKey(userId); // qpsLimit 默认 60（本用例不触限）
    await setupProviderWithModel("gpt-4o-mini");

    const kv = countKvOps("rate:");
    try {
      for (let i = 0; i < 4; i += 1) {
        const res = await postChat(plaintext);
        expect(res.status).toBe(402);
      }
      // FLUSH_DELTA_THRESHOLD = 5：未达阈值 → 0 写；每请求恰 1 读（快照合成）
      expect(kv.puts).toHaveLength(0);
      expect(kv.gets).toHaveLength(4);

      for (let i = 0; i < 6; i += 1) {
        await postChat(plaintext);
      }
      // 第 5 / 10 次请求触发落账（waitUntil 异步）→ 等待落地后核对上界
      await vi.waitFor(() => expect(kv.puts.length).toBeGreaterThan(0));
      expect(kv.puts.length).toBeLessThanOrEqual(3);
      // 读 = 请求数 + 落账读（每请求 1 读 + 每次落账 1 读）
      expect(kv.gets.length).toBeLessThanOrEqual(12);
    } finally {
      kv.unwrap();
    }
  });
});
