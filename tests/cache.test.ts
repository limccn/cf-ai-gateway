// M4 响应缓存单测（4.5）：命中直接返回、不转发、不扣费、明细记 cached。
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCacheKey, hashRequestBody } from "../src/lib/response-cache";
import {
  applyMigrations,
  clearKv,
  countTxByType,
  getBalance,
  latestLogStatus,
  selfFetch,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const BODY = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hello" }],
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

describe("响应缓存", () => {
  it("开启缓存的 Key：预置缓存后命中 → 返回缓存体、余额不变、无 usage 流水、明细 cached", async () => {
    const userId = await setupUser("cache@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");
    await setupPrice("gpt-4o-mini", 0.15, 0.6);

    const bodyHash = await hashRequestBody(BODY);
    const cacheKey = buildCacheKey(keyId, "gpt-4o-mini", bodyHash);
    const cachedPayload = {
      id: "chatcmpl-cached",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "cached reply" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    await env.CACHE_KV.put(cacheKey, JSON.stringify(cachedPayload));

    const res = await postChat(plaintext);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string };
    expect(json["id"]).toBe("chatcmpl-cached");

    // 不扣费：余额不变、无 usage 流水
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    // 明细记 cached
    expect(await latestLogStatus(userId)).toBe("cached");
  });

  it("开启缓存但未命中：走真实转发（上游不可达 → 502，不扣费，明细记 error）", async () => {
    const userId = await setupUser("cache-miss@test.dev", 10);
    const { plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");
    await setupPrice("gpt-4o-mini", 0.15, 0.6);

    const res = await postChat(plaintext);
    expect(res.status).toBe(502);
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("error");
  });

  it("未开启缓存的 Key：即使 KV 中存在对应键也不读缓存（直接转发路径）", async () => {
    const userId = await setupUser("cache-off@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: false });
    await setupProviderWithModel("gpt-4o-mini");

    const bodyHash = await hashRequestBody(BODY);
    const cacheKey = buildCacheKey(keyId, "gpt-4o-mini", bodyHash);
    await env.CACHE_KV.put(cacheKey, JSON.stringify({ id: "should-not-be-used" }));

    const res = await postChat(plaintext);
    // cacheEnabled=false → 未命中缓存 → 转发 → 上游不可达 502
    expect(res.status).toBe(502);
    expect(await latestLogStatus(userId)).toBe("error");
  });

  it("不同 Key 的缓存互相隔离（缓存键含 keyId）", async () => {
    const userId = await setupUser("cache-iso@test.dev", 10);
    const { plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");

    // 用另一个 keyId（不存在的 key）预置缓存 → 本 key 不应命中
    const bodyHash = await hashRequestBody(BODY);
    const otherCacheKey = buildCacheKey(999_999, "gpt-4o-mini", bodyHash);
    await env.CACHE_KV.put(otherCacheKey, JSON.stringify({ id: "other-key-cache" }));

    const res = await postChat(plaintext);
    expect(res.status).toBe(502); // 未命中 → 转发 → 不可达
  });

  it("缓存键对请求体 key 顺序不敏感（规范化 hash）", async () => {
    const userId = await setupUser("cache-norm@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");

    // 用 key 顺序不同的等价体 hash 预置
    const shuffled = {
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-4o-mini",
    };
    const bodyHash = await hashRequestBody(shuffled);
    const cacheKey = buildCacheKey(keyId, "gpt-4o-mini", bodyHash);
    await env.CACHE_KV.put(cacheKey, JSON.stringify({ id: "normalized-hit" }));

    const res = await postChat(plaintext);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string };
    expect(json["id"]).toBe("normalized-hit");
  });
});
