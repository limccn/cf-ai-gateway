// M4 计费核心单测（vitest + miniflare）：
// 1) 费用计算与宽松 usage 提取；2) 扣费正确性（余额/流水/明细）；3) 并发扣费不超扣（条件 UPDATE 原子性）；4) admin 余额调整。
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import {
  adjustUserBalance,
  calcCost,
  chargeUsage,
  extractLooseUsage,
  findModelPrice,
} from "../src/lib/billing";
import {
  applyMigrations,
  countTxByType,
  getBalance,
  latestLogStatus,
  setupKey,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

describe("calcCost / 价格表", () => {
  it("按 每百万 tokens 单价计算费用（USD/1e6）", () => {
    const cost = calcCost(
      { promptTokens: 1000, completionTokens: 500 },
      { inputPrice: 2.5, outputPrice: 10 },
    );
    // 1000*2.5/1e6 + 500*10/1e6 = 0.0025 + 0.005
    expect(cost).toBeCloseTo(0.0075, 12);
  });

  it("extractLooseUsage 兜底只含 prompt_tokens 的 usage（embeddings 场景）", () => {
    const usage = extractLooseUsage({ usage: { prompt_tokens: 3, total_tokens: 3 } });
    expect(usage).toEqual({ promptTokens: 3, completionTokens: 0 });
  });

  it("extractLooseUsage 对无 usage 返回 null（免计路径）", () => {
    expect(extractLooseUsage({ id: "x", choices: [] })).toBeNull();
  });

  it("查不到价格返回 null", async () => {
    const db = createDb(env);
    expect(await findModelPrice(db, "no-such-model")).toBeNull();
  });
});

describe("chargeUsage 原子扣费", () => {
  /** 建用户 + Key + Provider（request_logs 有外键约束，必须引用真实行）。 */
  async function setupBillingUser(
    email: string,
    balance: number,
  ): Promise<{ userId: number; keyId: number; providerId: number }> {
    const userId = await setupUser(email, balance);
    const { keyId } = await setupKey(userId);
    const providerId = await setupProviderWithModel("gpt-4o");
    return { userId, keyId, providerId };
  }

  it("成功请求扣除正确金额，写 usage 流水与 success 明细", async () => {
    const db = createDb(env);
    const { userId, keyId, providerId } = await setupBillingUser("charge@test.dev", 10);
    const cost = calcCost(
      { promptTokens: 1000, completionTokens: 500 },
      { inputPrice: 2.5, outputPrice: 10 },
    );
    const result = await chargeUsage(db, {
      userId,
      keyId,
      providerId,
      model: "gpt-4o",
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
      model: "gpt-4o",
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

  it("余额不足不扣费：返回 charged=false，余额不变，无 usage 流水", async () => {
    const db = createDb(env);
    const { userId, keyId, providerId } = await setupBillingUser("poor@test.dev", 0.5);
    const result = await chargeUsage(db, {
      userId,
      keyId,
      providerId,
      model: "gpt-4o",
      promptTokens: 1000,
      completionTokens: 500,
      cost: 10,
      latencyMs: 5,
      upstreamLatencyMs: 3,
      status: "success",
    });
    expect(result.charged).toBe(false);
    expect(await getBalance(userId)).toBe(0.5);
    expect(await countTxByType(userId, "usage")).toBe(0);
  });

  it("并发扣费不超扣：50 并发 × cost=1，余额 10 → 恰好扣 10 次，最终余额 0", async () => {
    const db = createDb(env);
    const { userId, keyId, providerId } = await setupBillingUser("concurrent@test.dev", 10);
    const attempts = Array.from({ length: 50 }, () =>
      chargeUsage(db, {
        userId,
        keyId,
        providerId,
        model: "gpt-4o",
        promptTokens: 0,
        completionTokens: 0,
        cost: 1,
        latencyMs: 1,
        upstreamLatencyMs: 1,
        status: "success",
      }),
    );
    const results = await Promise.all(attempts);
    const charged = results.filter((r) => r.charged).length;
    expect(charged).toBe(10);
    expect(await getBalance(userId)).toBe(0);
    expect(await countTxByType(userId, "usage")).toBe(10);
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
