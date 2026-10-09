// M4 计费核心单测（vitest + miniflare）：
// 1) calcCost 分层/缓存矩阵（short/long/cached、128K 边界）；2) 价格表查询 5 列映射；
// 3) usage 缓存 token 提取（openai / anthropic 非流式 / anthropic 流式尾包 / loose 兜底）；
// 4) 扣费正确性（余额/流水/明细）；5) 并发扣费不超扣（条件 UPDATE 原子性）；6) admin 余额调整。
// 7) 免费模式（批次 P / D17）：极小有效价让免费行仍走**真实扣费路径**（末尾新增 describe，
//    既有断言一行未动 —— 尤其 124 行的 `toEqual(PRICE)`，它同时是"非免费行原样返回"的回归锁）。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { balanceTx, requestLogs } from "../src/db/schema";
import {
  adjustUserBalance,
  calcCost,
  chargeUsage,
  extractLooseUsage,
  findModelPrice,
  SHORT_CONTEXT_THRESHOLD,
  type ModelPrice,
} from "../src/lib/billing";
import { parseOpenAiUsage } from "../src/providers/openai";
import { anthropicAdapter } from "../src/providers/anthropic";
import {
  applyMigrations,
  countTxByType,
  getBalance,
  latestLogStatus,
  setModelFlags,
  settleDelayedBilling,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

/** 测试价格档（long=short×2、cached=short×10%，与 seed 中 gpt-5.x 量级一致）。 */
const PRICE: ModelPrice = {
  inputPriceShort: 2,
  inputPriceLong: 4,
  inputPriceCached: 0.2,
  outputPriceShort: 10,
  outputPriceLong: 15,
};

// ============ SSE 测试辅助（Anthropic 流式） ============

/** 组装 SSE 字节流（事件块间空行分隔，与上游 text/event-stream 一致）。 */
function sseBody(blocks: string[]): ReadableStream<Uint8Array> {
  const response = new Response(new TextEncoder().encode(blocks.join("\n\n") + "\n\n"));
  const body = response.body;
  if (!body) {
    throw new Error("test: Response body is null");
  }
  return body;
}

/** 解析转换后 OpenAI SSE 文本的 data: 块（跳过 [DONE] 终止符）。 */
function parseSseLines(text: string): unknown[] {
  const chunks: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6);
      if (payload !== "[DONE]") {
        chunks.push(JSON.parse(payload) as unknown);
      }
    }
  }
  return chunks;
}

describe("calcCost 分层 + 缓存矩阵", () => {
  it("short 档：未缓存输入 ≤ 128K → short 输入价 + short 输出价", () => {
    const cost = calcCost({ promptTokens: 1000, completionTokens: 500 }, PRICE);
    // 1000*2 + 500*10 = 7000 → /1e6 = 0.007
    expect(cost).toBeCloseTo(0.007, 12);
  });

  it("long 档：未缓存输入 > 128K → long 输入价 + long 输出价（输出联动）", () => {
    const cost = calcCost({ promptTokens: 200_000, completionTokens: 500 }, PRICE);
    // 200000*4 + 500*15 = 807500 → 0.8075
    expect(cost).toBeCloseTo(0.8075, 12);
  });

  it("边界：未缓存输入恰好 128000 → short；128001 → long", () => {
    expect(SHORT_CONTEXT_THRESHOLD).toBe(128_000);
    expect(calcCost({ promptTokens: 128_000, completionTokens: 0 }, PRICE)).toBeCloseTo(0.256, 12);
    expect(calcCost({ promptTokens: 128_001, completionTokens: 0 }, PRICE)).toBeCloseTo(0.512004, 12);
  });

  it("缓存命中输入按 cached 价，未缓存部分按档计价", () => {
    const cost = calcCost(
      { promptTokens: 2000, completionTokens: 500, cachedTokens: 1000 },
      PRICE,
    );
    // 1000*0.2 + 1000*2 + 500*10 = 7200 → 0.0072
    expect(cost).toBeCloseTo(0.0072, 12);
  });

  it("档位只看未缓存输入：大量缓存命中输入不触发 long 档", () => {
    const cost = calcCost(
      { promptTokens: 200_000, completionTokens: 1000, cachedTokens: 100_000 },
      PRICE,
    );
    // 未缓存 100000 ≤ 128K → short 档；100000*0.2 + 100000*2 + 1000*10 = 230000 → 0.23
    expect(cost).toBeCloseTo(0.23, 12);
  });

  it("cachedTokens 缺失或为 0 按 0 计（无缓存细分）", () => {
    expect(calcCost({ promptTokens: 1000, completionTokens: 500 }, PRICE)).toBeCloseTo(0.007, 12);
    expect(calcCost({ promptTokens: 1000, completionTokens: 500, cachedTokens: 0 }, PRICE)).toBeCloseTo(
      0.007,
      12,
    );
  });

  it("负数缓存 token 防御性截为 0", () => {
    const cost = calcCost({ promptTokens: 1000, completionTokens: 500, cachedTokens: -100 }, PRICE);
    expect(cost).toBeCloseTo(0.007, 12);
  });
});

describe("findModelPrice 价格表查询", () => {
  it("返回全部 5 个价格档（short/long/cached 输入 + short/long 输出）", async () => {
    const db = createDb(env);
    await setupPrice("pricing-tier-test", 2, 4, 0.2, 10, 15);
    expect(await findModelPrice(db, "pricing-tier-test")).toEqual(PRICE);
  });

  it("查不到价格返回 null（免计路径）", async () => {
    const db = createDb(env);
    expect(await findModelPrice(db, "no-such-model")).toBeNull();
  });
});

describe("usage 缓存 token 提取", () => {
  it("OpenAI 形态：prompt_tokens_details.cached_tokens → cachedTokens", () => {
    const usage = parseOpenAiUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    });
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 4 });
  });

  it("OpenAI 形态：无缓存细分 → cachedTokens undefined", () => {
    expect(parseOpenAiUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: undefined,
    });
  });

  it("OpenAI 形态：非对象 / 无 usage 返回 null", () => {
    expect(parseOpenAiUsage("oops")).toBeNull();
    expect(parseOpenAiUsage({ id: "x", choices: [] })).toBeNull();
  });

  it("Anthropic 非流式：cache_read_input_tokens → cachedTokens（写入量留在输入内按普通计）", () => {
    const usage = anthropicAdapter.parseUsage({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 6,
      },
    });
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 4 });
  });

  it("Anthropic 非流式：仅 cache_creation（缓存写入）→ cachedTokens undefined", () => {
    const usage = anthropicAdapter.parseUsage({
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 6 },
    });
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: undefined });
  });

  it("Anthropic 流式尾包：message_start 的 cache_read 进入 usage.prompt_tokens_details", async () => {
    const transformed = anthropicAdapter.transformStreamToOpenAI(
      sseBody([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":6}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ]),
    );
    const chunks = parseSseLines(await new Response(transformed).text());
    // 最后一个 data 块为 usage 尾包（[DONE] 终止符已被跳过）
    const tail = chunks[chunks.length - 1];
    expect(tail).toBeDefined();
    expect(parseOpenAiUsage(tail)).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 4 });
  });

  it("Anthropic 流式尾包：无缓存读取时不带 prompt_tokens_details", async () => {
    const transformed = anthropicAdapter.transformStreamToOpenAI(
      sseBody([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"claude-x","usage":{"input_tokens":10}}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ]),
    );
    const chunks = parseSseLines(await new Response(transformed).text());
    const tail = chunks[chunks.length - 1];
    expect(tail).toBeDefined();
    expect(parseOpenAiUsage(tail)).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: undefined,
    });
  });

  it("extractLooseUsage 兜底：OpenAI 形态缓存细分 + 仅 prompt_tokens 场景（embeddings）", () => {
    expect(
      extractLooseUsage({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 4 });
    expect(extractLooseUsage({ usage: { prompt_tokens: 3, total_tokens: 3 } })).toEqual({
      promptTokens: 3,
      completionTokens: 0,
      cachedTokens: undefined,
    });
  });

  it("extractLooseUsage 对无 usage 返回 null（免计路径）", () => {
    expect(extractLooseUsage({ id: "x", choices: [] })).toBeNull();
  });

  it("extractLooseUsage 兜底：Responses 原生形态（input_tokens/output_tokens + input_tokens_details）", () => {
    expect(
      extractLooseUsage({
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          total_tokens: 42,
          input_tokens_details: { cached_tokens: 7 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      }),
    ).toEqual({ promptTokens: 30, completionTokens: 12, cachedTokens: 7 });
  });

  it("extractLooseUsage：chat 两键与 Responses 两键并存 → chat 键优先（既有形态回归锚）", () => {
    expect(
      extractLooseUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          input_tokens: 30,
          output_tokens: 12,
        },
      }),
    ).toEqual({ promptTokens: 100, completionTokens: 50, cachedTokens: undefined });
  });

  it("extractLooseUsage：chat 与 Responses 形态 token 键全缺 → null（免计路径不变）", () => {
    expect(extractLooseUsage({ usage: { total_tokens: 42 } })).toBeNull();
  });
});

describe("chargeUsage 扣费（D2 债务模型）", () => {
  /** 建用户 + Key + Provider（request_logs 有外键约束，必须引用真实行）。 */
  async function setupBillingUser(
    email: string,
    balance: number,
  ): Promise<{ userId: number; keyId: number; providerId: number }> {
    const userId = await setupUser(email, balance);
    const { keyId } = await setupKey(userId);
    const providerId = await setupProviderWithModel("gpt-5.6-sol");
    return { userId, keyId, providerId };
  }

  it("成功请求扣除正确金额，写 usage 流水与 success 明细", async () => {
    const db = createDb(env);
    const { userId, keyId, providerId } = await setupBillingUser("charge@test.dev", 10);
    const cost = calcCost({ promptTokens: 1000, completionTokens: 500 }, PRICE);
    const result = await chargeUsage(db, {
      userId,
      keyId,
      providerId,
      model: "gpt-5.6-sol",
      promptTokens: 1000,
      completionTokens: 500,
      cost,
      latencyMs: 12,
      upstreamLatencyMs: 9,
      status: "success",
    });
    expect(result.charged).toBe(true);
    expect(await getBalance(userId)).toBeCloseTo(10 - cost, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });

  it("cost<=0 不扣费不写流水（免计场景）", async () => {
    const db = createDb(env);
    const { userId, keyId, providerId } = await setupBillingUser("free@test.dev", 5);
    const result = await chargeUsage(db, {
      userId,
      keyId,
      providerId,
      model: "gpt-5.6-sol",
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      latencyMs: 5,
      upstreamLatencyMs: 3,
      status: "success",
    });
    expect(result.charged).toBe(false);
    expect(await getBalance(userId)).toBe(5);
    expect(await countTxByType(userId, "usage")).toBe(0);
    // 明细仍然记录
    expect(await latestLogStatus(userId)).toBe("success");
  });

  it("债务透支（D2）：余额不足 → 无条件扣费，余额可为负，流水照记", async () => {
    const db = createDb(env);
    const { userId, keyId, providerId } = await setupBillingUser("poor@test.dev", 0.5);
    const result = await chargeUsage(db, {
      userId,
      keyId,
      providerId,
      model: "gpt-5.6-sol",
      promptTokens: 1000,
      completionTokens: 500,
      cost: 10,
      latencyMs: 5,
      upstreamLatencyMs: 3,
      status: "success",
    });
    expect(result.charged).toBe(true);
    expect(await getBalance(userId)).toBeCloseTo(0.5 - 10, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });

  it("并发扣费全部生效（债务模型）：50 并发 × cost=1，余额 10 → 余额 -40，50 条流水", async () => {
    const db = createDb(env);
    const { userId, keyId, providerId } = await setupBillingUser("concurrent@test.dev", 10);
    const attempts = Array.from({ length: 50 }, () =>
      chargeUsage(db, {
        userId,
        keyId,
        providerId,
        model: "gpt-5.6-sol",
        promptTokens: 0,
        completionTokens: 0,
        cost: 1,
        latencyMs: 1,
        upstreamLatencyMs: 1,
        status: "success",
      }),
    );
    const results = await Promise.all(attempts);
    expect(results.every((r) => r.charged)).toBe(true);
    expect(await getBalance(userId)).toBeCloseTo(10 - 50, 10);
    expect(await countTxByType(userId, "usage")).toBe(50);
  });
});

describe("adjustUserBalance admin 余额调整", () => {
  it("充值 +50 与 扣减 -20，流水 type=adjust", async () => {
    const db = createDb(env);
    const userId = await setupUser("adjust@test.dev", 0);
    const credit = await adjustUserBalance(db, userId, 50, "admin credit");
    expect(credit.success).toBe(true);
    expect(credit.balance).toBe(50);
    const debit = await adjustUserBalance(db, userId, -20, "admin debit");
    expect(debit.success).toBe(true);
    expect(debit.balance).toBe(30);
    expect(await countTxByType(userId, "adjust")).toBe(2);
  });

  it("用户不存在返回 success=false", async () => {
    const db = createDb(env);
    const result = await adjustUserBalance(db, 999_999, 10, null);
    expect(result.success).toBe(false);
    expect(result.balance).toBeNull();
  });
});

describe("免费模式（批次 P / D17）：极小有效价让免费行仍走真实扣费路径", () => {
  const FREE_MODEL = "pricing-free-mode-test";
  const PAID_MODEL = "pricing-free-mode-control";

  it("同批两条：免费行 cost 极小但 > 0（有负数流水、余额真的下降），非免费行照旧 ≈0.007", async () => {
    const db = createDb(env);
    const userId = await setupUser("free-mode@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const providerId = await setupProviderWithModel(PAID_MODEL);

    // 两行**同一档真价**，只有标记不同 —— 这样两个模型走的是同一条代码路径，
    // cost 的差异只能来自 free_mode（而不是"碰巧价格不一样"）。
    await setupPrice(FREE_MODEL, 2, 4, 0.2, 10, 15);
    await setupPrice(PAID_MODEL, 2, 4, 0.2, 10, 15);
    await setModelFlags(FREE_MODEL, { freeMode: true });

    await settleDelayedBilling([
      { userId, keyId, providerId, model: FREE_MODEL, promptTokens: 1000, completionTokens: 500 },
      { userId, keyId, providerId, model: PAID_MODEL, promptTokens: 1000, completionTokens: 500 },
    ]);

    const logs = await db
      .select({ model: requestLogs.model, cost: requestLogs.cost })
      .from(requestLogs)
      .where(eq(requestLogs.userId, userId));
    const freeLog = logs.find((l) => l.model === FREE_MODEL);
    const paidLog = logs.find((l) => l.model === PAID_MODEL);
    if (!freeLog || !paidLog) {
      throw new Error(`明细未落行：${JSON.stringify(logs)}`);
    }

    // 关键在**严格大于 0**：billing-queue.ts 的 `if (cost > 0)` 是「扣费 + balance_tx」那一批的
    // 唯一闸门。取 0 会让免费请求只有 usage_daily 零额入账、流水与余额纹丝不动 ——
    // 这正是常量取极小值而非 0 的**唯一**理由（不是"防计价失败"）。
    expect(freeLog.cost).toBeGreaterThan(0);
    expect(freeLog.cost).toBeLessThan(1e-6);
    // 对照：同批非免费行仍按 short 档计价（1000×2 + 500×10）/1e6
    expect(paidLog.cost).toBeCloseTo(0.007, 12);

    // 流水：免费行**有**一条负数 usage 流水，金额 = -cost
    const txs = await db
      .select({ amount: balanceTx.amount, note: balanceTx.note })
      .from(balanceTx)
      .where(eq(balanceTx.userId, userId));
    expect(txs).toHaveLength(2);
    const freeTx = txs.find((t) => t.note === `usage: ${FREE_MODEL}`);
    if (!freeTx) {
      throw new Error(`免费行没有流水：${JSON.stringify(txs)}`);
    }
    expect(freeTx.amount).toBeLessThan(0);
    expect(freeTx.amount).toBeCloseTo(-freeLog.cost, 15);

    // 余额真的下降，且下降量 = 两条 cost 之和。两侧都断言：只比 `10 - paid.cost` 小一点
    // 证明免费那笔确实扣了，而不小于 1e-6 证明扣的**只是**极小值（没按真价扣）。
    const balance = await getBalance(userId);
    expect(balance).toBeLessThan(10 - paidLog.cost);
    expect(balance).toBeGreaterThan(10 - paidLog.cost - 1e-6);
  });
});
