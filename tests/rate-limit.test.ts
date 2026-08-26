// M4 限流单测（4.4）：KV 固定窗口计数器；qps_limit 可配置；超限 429。
// 说明：限流按分钟窗口分桶，而不可达上游每次请求耗时约 2s，容易跨分钟边界；
// 因此本文件冻结 Date.now 保证窗口确定（主 worker 与测试同 isolate，全局 mock 对其生效）。
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  clearKv,
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
    const userId = await setupUser("ratelimit@test.dev", 10);
    const { plaintext } = await setupKey(userId, { qpsLimit: 2 });
    await setupProviderWithModel("gpt-4o-mini");

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await postChat(plaintext);
      statuses.push(res.status);
    }
    expect(statuses[0]).not.toBe(429);
    expect(statuses[1]).not.toBe(429);
    expect(statuses[2]).toBe(429);

    // 429 响应为 OpenAI 风格错误体
    const res = await postChat(plaintext);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json["error"]?.["message"]).toBeTruthy();
  });

  it("默认 qpsLimit=60：三次请求均放行", async () => {
    const userId = await setupUser("ratelimit-default@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel("gpt-4o-mini");

    for (let i = 0; i < 3; i += 1) {
      const res = await postChat(plaintext);
      expect(res.status).not.toBe(429);
    }
  });

  it("不同 Key 的计数器相互隔离", async () => {
    const userId = await setupUser("ratelimit-iso@test.dev", 10);
    const a = await setupKey(userId, { qpsLimit: 1 });
    const b = await setupKey(userId, { qpsLimit: 1 });
    await setupProviderWithModel("gpt-4o-mini");

    // key a 消耗掉唯一配额
    const firstA = await postChat(a.plaintext);
    expect(firstA.status).not.toBe(429);
    const secondA = await postChat(a.plaintext);
    expect(secondA.status).toBe(429);

    // key b 不受影响
    const firstB = await postChat(b.plaintext);
    expect(firstB.status).not.toBe(429);
  });
});
