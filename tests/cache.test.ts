// M4 响应缓存单测（4.5）：命中直接返回、不转发、不扣费、明细记 cached。
// R3：非流式响应 >5MB 跳过 KV 缓存（照常返回，避免 waitUntil 内 stringify 大响应的峰值）。
// 09-03：全局开关（CACHE_ENABLED）——缺省关闭，proxy 接入点见 tests 环境绑定 CACHE_ENABLED="true"。
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CACHE_HIT_WINDOW_SECONDS,
  buildCacheKey,
  buildCountKey,
  bumpCacheMissCount,
  hashRequestBody,
  isGlobalCacheEnabled,
  resetMissCountsForTest,
} from "../src/lib/response-cache";
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

afterEach(() => {
  vi.unstubAllGlobals();
  // O2：miss 计数为 isolate 模块级 Map，防跨用例残留（keyId 各异理论上无碰撞，防御性清空）
  resetMissCountsForTest();
});

/** mock provider 的 baseUrl（setupProviderWithModel 固定值），stub 按此前缀回 canned 上游。 */
const UPSTREAM_BASE = "http://127.0.0.1:1";

/** 拦截 fetch：上游前缀 → canned 响应；其余 → 转发主 worker（网关路径）。 */
function stubUpstream(upstreamHandler: () => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(UPSTREAM_BASE)) {
        return upstreamHandler();
      }
      const app = exports.default as { fetch(request: Request): Promise<Response> };
      return app.fetch(new Request(url, init));
    }),
  );
}

/** 上游非流式 chat.completion（内部形态）。 */
function upstreamChat(id: string, content: string): Response {
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created: 1_700_000_000,
      model: "gpt-4o-mini",
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("响应缓存", () => {
  it("开启缓存的 Key：预置缓存后命中 → 返回缓存体、余额不变、无 usage 流水、明细 cached", async () => {
    const userId = await setupUser("cache@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");
    await setupPrice("gpt-4o-mini", 0.15, 0.15, 0.0375, 0.6, 0.6);

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
    await setupPrice("gpt-4o-mini", 0.15, 0.15, 0.0375, 0.6, 0.6);

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

  it("R2+R3：非流式响应 ≤5MB 写入缓存（第 1 次只计数、第 2 次写缓存并清计数、第 3 次命中不转发）", async () => {
    const userId = await setupUser("cache-write@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");
    await setupPrice("gpt-4o-mini", 0.15, 0.15, 0.0375, 0.6, 0.6);

    let upstreamCalls = 0;
    stubUpstream(() => {
      upstreamCalls += 1;
      return upstreamChat("chatcmpl-fresh", "small reply");
    });

    const bodyHash = await hashRequestBody(BODY);
    const cacheKey = buildCacheKey(keyId, "gpt-4o-mini", bodyHash);
    const countKey = buildCountKey(keyId, "gpt-4o-mini", bodyHash);

    // 第 1 次：仅计数（未达高频重传阈值 → 不写缓存）；bump 在响应后 waitUntil 异步执行。
    // O2：计数在 isolate 模块级 Map——countKey 永不出现在 KV（0 KV 操作契约）
    const first = await postChat(plaintext);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { id: string })["id"]).toBe("chatcmpl-fresh");
    expect(await env.CACHE_KV.get(cacheKey)).toBeNull();
    await vi.waitFor(async () => {
      expect(await env.CACHE_KV.get(countKey)).toBeNull();
    });

    // 第 2 次：达到阈值 → waitUntil 异步写缓存（计数清零在 isolate 内，KV 无痕）
    const second = await postChat(plaintext);
    expect(second.status).toBe(200);
    expect(upstreamCalls).toBe(2);
    await vi.waitFor(async () => {
      expect(await env.CACHE_KV.get(cacheKey)).not.toBeNull();
    });

    // 第 3 次：命中缓存值（上游未被再次调用）
    const third = await postChat(plaintext);
    expect(third.status).toBe(200);
    expect(((await third.json()) as { id: string })["id"]).toBe("chatcmpl-fresh");
    expect(upstreamCalls).toBe(2);
  });

  it("H11：失败请求不消耗计数（bump 只在成功路径；错误突发不饿死缓存）", async () => {
    const userId = await setupUser("cache-h11-fail@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");
    await setupPrice("gpt-4o-mini", 0.15, 0.15, 0.0375, 0.6, 0.6);

    const bodyHash = await hashRequestBody(BODY);
    const cacheKey = buildCacheKey(keyId, "gpt-4o-mini", bodyHash);
    const countKey = buildCountKey(keyId, "gpt-4o-mini", bodyHash);

    // 第 1 次成功 → 计数 1（isolate 内，KV 无痕——O2 契约）
    stubUpstream(() => upstreamChat("chatcmpl-h11-1", "ok"));
    const first = await postChat(plaintext);
    expect(first.status).toBe(200);
    await vi.waitFor(async () => {
      expect(await env.CACHE_KV.get(countKey)).toBeNull();
    });

    // 第 2 次失败（上游 5xx）→ 不消耗计数（bump 只在成功路径 waitUntil——错误突发
    // 不把热度清零 → 上游恢复后无需重新累积）
    stubUpstream(() => new Response("boom", { status: 502 }));
    const failed = await postChat(plaintext);
    expect(failed.status).toBe(502);
    expect(await env.CACHE_KV.get(cacheKey)).toBeNull();

    // 第 3 次成功 → 计数 2 = 阈值 → 写缓存（失败未消耗热度，3 次总流量即触发）
    stubUpstream(() => upstreamChat("chatcmpl-h11-3", "ok"));
    const third = await postChat(plaintext);
    expect(third.status).toBe(200);
    await vi.waitFor(async () => {
      expect(await env.CACHE_KV.get(cacheKey)).not.toBeNull();
    });
  });

  it("H11：count key 带协议前缀（协议分支计数隔离）", () => {
    expect(buildCountKey(1, "m", "h")).toBe("cachecnt:1:m:h");
    expect(buildCountKey(1, "m", "h", "anthropic:")).toBe("cachecnt:anthropic:1:m:h");
  });

  it("R3：非流式响应 >5MB 跳过 KV 缓存（照常返回 200，不写缓存）", async () => {
    const userId = await setupUser("cache-big@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");
    await setupPrice("gpt-4o-mini", 0.15, 0.15, 0.0375, 0.6, 0.6);

    // 正文 6MB > 阈值 5MB（MAX_CACHE_RESPONSE_BYTES）
    stubUpstream(() => upstreamChat("chatcmpl-big", "x".repeat(6 * 1024 * 1024)));

    const res = await postChat(plaintext);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string })["id"]).toBe("chatcmpl-big");

    // 跳过是确定性的（写入前判断），无需等待
    const bodyHash = await hashRequestBody(BODY);
    const cacheKey = buildCacheKey(keyId, "gpt-4o-mini", bodyHash);
    expect(await env.CACHE_KV.get(cacheKey)).toBeNull();
  });

  it("R2：请求体 >32KB 跳过整个缓存评估（不计数、不写缓存，照常转发两次）", async () => {
    const userId = await setupUser("cache-bigbody@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel("gpt-4o-mini");
    await setupPrice("gpt-4o-mini", 0.15, 0.15, 0.0375, 0.6, 0.6);

    // 请求体（messages content）> 32KB（MAX_CACHE_BODY_BYTES）
    const bigBody = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "x".repeat(40 * 1024) }],
    };
    const bodyHash = await hashRequestBody(bigBody);
    const cacheKey = buildCacheKey(keyId, "gpt-4o-mini", bodyHash);
    const countKey = buildCountKey(keyId, "gpt-4o-mini", bodyHash);

    let upstreamCalls = 0;
    stubUpstream(() => {
      upstreamCalls += 1;
      return upstreamChat("chatcmpl-bigbody", "reply");
    });

    // 连发两次（同 body）：若无 R2 前置过滤将触发计数并写缓存 → 应无任何 KV 痕迹
    for (let i = 0; i < 2; i++) {
      const res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify(bigBody),
      });
      expect(res.status).toBe(200);
    }
    expect(upstreamCalls).toBe(2);
    expect(await env.CACHE_KV.get(countKey)).toBeNull();
    expect(await env.CACHE_KV.get(cacheKey)).toBeNull();
  });
});

describe("全局缓存总开关（CACHE_ENABLED）", () => {
  it("真值：true/1/yes/on（大小写不敏感、可带空白）→ 开启", () => {
    expect(isGlobalCacheEnabled("true")).toBe(true);
    expect(isGlobalCacheEnabled("1")).toBe(true);
    expect(isGlobalCacheEnabled("yes")).toBe(true);
    expect(isGlobalCacheEnabled("on")).toBe(true);
    expect(isGlobalCacheEnabled(" TRUE ")).toBe(true);
    expect(isGlobalCacheEnabled("On")).toBe(true);
  });

  it("缺省/其他值 → 关闭（默认关闭语义：false、空串、未知词、undefined）", () => {
    expect(isGlobalCacheEnabled(undefined)).toBe(false);
    expect(isGlobalCacheEnabled("false")).toBe(false);
    expect(isGlobalCacheEnabled("")).toBe(false);
    expect(isGlobalCacheEnabled("0")).toBe(false);
    expect(isGlobalCacheEnabled("enabled")).toBe(false);
    expect(isGlobalCacheEnabled("  ")).toBe(false);
  });
});

// O2（09-11-kv-ops-optimization）：miss 计数 isolate 化 —— 纯函数语义（0 KV 由签名保证：
// bumpCacheMissCount(countKey) 不再接收 KV 入参，KV 读写在该路径上不可能发生）。
describe("O2 miss 计数（isolate 窗口分桶）", () => {
  const ORIGINAL_DATE_NOW = Date.now;

  it("同窗口 ≥ 阈值 → true 并清零；窗口翻转 → 重新累积", () => {
    resetMissCountsForTest();
    const key = "cachecnt:o2:1:gpt-4o-mini:deadbeef";
    const base = 1_700_000_000_000;
    Date.now = () => base;
    try {
      expect(bumpCacheMissCount(key)).toBe(false); // 第 1 次：计数 1
      expect(bumpCacheMissCount(key)).toBe(true); // 第 2 次 = 阈值 → 写缓存 + 清零
      expect(bumpCacheMissCount(key)).toBe(false); // 清零后重新计数 1
      Date.now = () => base + CACHE_HIT_WINDOW_SECONDS * 1000; // 窗口翻转
      expect(bumpCacheMissCount(key)).toBe(false); // 陈旧条目按 1 重计（惰性清理）
      expect(bumpCacheMissCount(key)).toBe(true); // 新窗口重新累积到阈值
    } finally {
      Date.now = ORIGINAL_DATE_NOW;
      resetMissCountsForTest();
    }
  });

  it("不同 countKey 计数隔离（键含 keyId/model/bodyHash/协议前缀）", () => {
    resetMissCountsForTest();
    expect(bumpCacheMissCount("cachecnt:1:m:h")).toBe(false); // key1 → 1
    expect(bumpCacheMissCount("cachecnt:2:m:h")).toBe(false); // key2 → 1（与 key1 隔离）
    expect(bumpCacheMissCount("cachecnt:2:m:h")).toBe(true); // key2 → 达阈值
    expect(bumpCacheMissCount("cachecnt:1:m:h")).toBe(true); // key1 → 达阈值（未被 key2 消耗）
  });
});
