// O3c（09-11-kv-ops-optimization）：modelcap 常量权威 + 慢路径测试。
// 常量模型 "gpt-5.6-luna"（1x 档 = 16384）与 "glm-5.3"（2x 档 = 32768）；
// 2026-09-16 用户手工调档后常量无 null 档（「不限」经 D1 null 慢路径保留）。
// 断言面：
//   快路径（索求 ≤ 常量 / 省略 / 不限）→ 0 modelcap KV get、0 D1 查询、clamp 用常量；
//   慢路径（索求 > 常量 / 不在常量）→ KV get（含 cacheTtl:60）+ D1 权威；
//   降调契约（design.md §3.1）：D1 调低后索求超常量者即时 clamp，索求 ≤ 常量者按常量放行
//   （需重新生成常量 + 部署才生效——契约预期行为）。
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/upstream", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/upstream")>();
  return { ...mod, fetchUpstream: vi.fn() };
});
import { createDb } from "../src/db";
import { fetchUpstream } from "../src/lib/upstream";
import { models } from "../src/db/schema";
import {
  applyMigrations,
  clearKv,
  selfFetch,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

/** 常量模型：1x 档（8192×2×1=16384）、2x 档（8192×2×2=32768）。 */
const CONST_MODEL = "gpt-5.6-luna";
const TWOX_MODEL = "glm-5.3";

const CHAT_RESPONSE = {
  id: "chatcmpl-cap",
  object: "chat.completion",
  created: 1_700_000_000,
  model: CONST_MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

/** 捕获最近一次 fetchUpstream 调用的上游 body。 */
function lastUpstreamBody(): Record<string, unknown> {
  const calls = vi.mocked(fetchUpstream).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const call = calls[calls.length - 1];
  if (call === undefined) {
    throw new Error("fetchUpstream never called");
  }
  return JSON.parse(String(call[1]?.body ?? "{}")) as Record<string, unknown>;
}

/** 计数 KV 包装：拦截 modelcap:* 键的 get/put（其余键透明转发）。 */
interface KvGetOpts {
  cacheTtl?: number;
}
interface KvPutOpts {
  expirationTtl?: number;
}
function wrapModelcapKv(): {
  gets: Array<{ key: string; options?: KvGetOpts }>;
  puts: string[];
  unwrap: () => void;
} {
  const original = env.CACHE_KV;
  const gets: Array<{ key: string; options?: KvGetOpts }> = [];
  const puts: string[] = [];
  const wrapped = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return async (key: string, options?: KvGetOpts) => {
          if (typeof key === "string" && key.startsWith("modelcap:")) {
            gets.push({ key, options });
          }
          return target.get(key, options);
        };
      }
      if (prop === "put") {
        return async (key: string, value: string, options?: KvPutOpts) => {
          if (typeof key === "string" && key.startsWith("modelcap:")) {
            puts.push(key);
          }
          return target.put(key, value, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  env.CACHE_KV = wrapped;
  return {
    gets,
    puts,
    unwrap: () => {
      env.CACHE_KV = original;
    },
  };
}

async function setupModelCap(model: string, cap: number | null): Promise<{ plaintext: string }> {
  const userId = await setupUser(`cap-${model}-${crypto.randomUUID().slice(0, 8)}@test.dev`, 10);
  const { plaintext } = await setupKey(userId);
  await setupProviderWithModel(model);
  await setupPrice(model, 0.15, 0.15, 0.04, 0.6, 0.6);
  const db = createDb(env);
  await db.update(models).set({ maxOutputTokens: cap }).where(eq(models.model, model));
  // 清 cap KV 缓存（同 MODEL 用例间 KV 残留互相污染；缓存命中语义由「缓存值 = DB 值」保证）
  await env.CACHE_KV.delete(`modelcap:${model}`);
  return { plaintext };
}

function stubUpstream(): void {
  vi.mocked(fetchUpstream).mockImplementation(async () => {
    return new Response(JSON.stringify(CHAT_RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

async function postChat(
  plaintext: string,
  model: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return selfFetch("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.mocked(fetchUpstream).mockClear();
});

describe("O3c modelcap 常量权威 + 慢路径", () => {
  it("快路径（索求 ≤ 常量）：0 modelcap KV 操作，clamp 用常量无操作", async () => {
    const { plaintext } = await setupModelCap(CONST_MODEL, 9999); // D1 值 ≠ 常量，证明常量生效
    stubUpstream();
    const kv = wrapModelcapKv();
    try {
      const res = await postChat(plaintext, CONST_MODEL, { max_tokens: 100, stream: false });
      expect(res.status).toBe(200);
      expect(lastUpstreamBody()["max_tokens"]).toBe(100); // 未被 clamp（100 ≤ 常量 16384）
      expect(kv.gets).toEqual([]);
      expect(kv.puts).toEqual([]);
    } finally {
      kv.unwrap();
    }
  });

  it("快路径（省略 max）：常量注入 max_tokens（U6 兜底保留），0 KV 操作", async () => {
    const { plaintext } = await setupModelCap(CONST_MODEL, 9999);
    stubUpstream();
    const kv = wrapModelcapKv();
    try {
      const res = await postChat(plaintext, CONST_MODEL, { stream: false });
      expect(res.status).toBe(200);
      // 缺省兜底按常量注入（防 adapter 缺省注入超 cap 的事故形态）
      expect(lastUpstreamBody()["max_tokens"]).toBe(16384);
      expect(kv.gets).toEqual([]);
      expect(kv.puts).toEqual([]);
    } finally {
      kv.unwrap();
    }
  });

  it("快路径（2x 档模型）：cap = 8192 × 2 × 2 = 32768，索求 20000 放行，0 KV 操作", async () => {
    const { plaintext } = await setupModelCap(TWOX_MODEL, 40000); // D1 值 ≠ 乘算值，证明档位乘算生效
    stubUpstream();
    const kv = wrapModelcapKv();
    try {
      const res = await postChat(plaintext, TWOX_MODEL, { max_tokens: 20000, stream: false });
      expect(res.status).toBe(200);
      expect(lastUpstreamBody()["max_tokens"]).toBe(20000); // ≤ 32768 常量 → 不 clamp
      expect(kv.gets).toEqual([]);
      expect(kv.puts).toEqual([]);
    } finally {
      kv.unwrap();
    }
  });

  it("慢路径（不在常量 + D1 null = 不限）：不 clamp（null 哨兵路径）", async () => {
    // 2026-09-16 用户调档后常量无 null 档模型；「不限」语义经 D1 null 慢路径保留
    const CUSTOM_UNLIMITED = "my-unlimited-model";
    const { plaintext } = await setupModelCap(CUSTOM_UNLIMITED, null);
    stubUpstream();
    const res = await postChat(plaintext, CUSTOM_UNLIMITED, { max_tokens: 65536, stream: false });
    expect(res.status).toBe(200);
    expect(lastUpstreamBody()["max_tokens"]).toBe(65536);
  });

  it("慢路径（索求 > 常量）：KV get 带 cacheTtl:60 + D1 权威 + 写回", async () => {
    // D1 cap 25000 > 常量 16384：索求 20000 走慢路径，见 D1 新值 → 不 clamp（升调即时生效）
    const { plaintext } = await setupModelCap(CONST_MODEL, 25000);
    stubUpstream();
    const kv = wrapModelcapKv();
    try {
      const res = await postChat(plaintext, CONST_MODEL, { max_tokens: 20000, stream: false });
      expect(res.status).toBe(200);
      expect(lastUpstreamBody()["max_tokens"]).toBe(20000);
      expect(kv.gets.length).toBe(1);
      expect(kv.gets[0]?.key).toBe(`modelcap:${CONST_MODEL}`);
      expect(kv.gets[0]?.options).toEqual({ cacheTtl: 60 });
      // D1 miss → waitUntil 写回缓存
      await vi.waitFor(() => expect(kv.puts.length).toBe(1));
      expect(kv.puts[0]).toBe(`modelcap:${CONST_MODEL}`);
    } finally {
      kv.unwrap();
    }
  });

  it("降调契约：索求超常量即时 clamp 到 D1 新值；索求 ≤ 常量按常量放行", async () => {
    // D1 cap 8000 < 常量 16384（admin 降调，常量未重新生成——契约预期行为）
    const { plaintext } = await setupModelCap(CONST_MODEL, 8000);
    stubUpstream();
    // 索求 20000 > 常量 → 慢路径 → D1 8000 → clamp
    const resOver = await postChat(plaintext, CONST_MODEL, { max_tokens: 20000, stream: false });
    expect(resOver.status).toBe(200);
    expect(lastUpstreamBody()["max_tokens"]).toBe(8000);
    // 索求 12000 ≤ 常量 16384（但 > D1 8000）→ 快路径放行（漂移窗口，需重新生成 + 部署）
    const resUnder = await postChat(plaintext, CONST_MODEL, { max_tokens: 12000, stream: false });
    expect(resUnder.status).toBe(200);
    expect(lastUpstreamBody()["max_tokens"]).toBe(12000);
  });

  it("不在常量（自定义模型）：慢路径 D1 权威（既有行为保持）", async () => {
    const CUSTOM = "my-custom-model";
    const { plaintext } = await setupModelCap(CUSTOM, 4000);
    stubUpstream();
    const res = await postChat(plaintext, CUSTOM, { max_tokens: 8000, stream: false });
    expect(res.status).toBe(200);
    expect(lastUpstreamBody()["max_tokens"]).toBe(4000);
  });
});
