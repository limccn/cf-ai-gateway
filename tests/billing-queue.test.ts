// 延迟计费消费者单测（08-31-perf-v2）：consumeBillingBatch 批内语义。
// 请求路径成功时只发 BILLING_QUEUE 事件（0 同步 D1 写），本文件直接驱动消费者，
// 验证：批内落账（明细带 requestId + 条件扣费 + usage 流水 + 聚合事件）、
// 幂等（request_id 唯一约束重复投递跳过）、透支尽力扣费（余额不足不欠款）、
// 免计（价格缺失 cost=0 只记明细）、缓存分层定价（cachedTokens 按缓存价）、
// 结算时刻价格（事件发出后调价按新价扣费）、非法消息跳过不中断整批。
//
// 隔离约定：每个用例用独立模型名（价格表/明细全局共享，同名模型会跨用例泄漏价格）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { requestLogs } from "../src/db/schema";
import { calcCost } from "../src/lib/billing";
import { consumeBillingBatch, type BillingEvent } from "../src/lib/billing-queue";
import { sendUsageEvent } from "../src/lib/usage-aggregation";
import {
  applyMigrations,
  clearKv,
  countTxByType,
  getBalance,
  latestLogStatus,
  makeBillingBatch,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

// 拦截消费者发出的聚合事件（不真正投递 USAGE_QUEUE；断言事件载荷即可）
vi.mock("../src/lib/usage-aggregation", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/usage-aggregation")>();
  return { ...mod, sendUsageEvent: vi.fn() };
});

/** 测试价格（与 proxy-pipeline.test.ts 同口径）：输入 0.15/M、输出 0.6/M、缓存输入 0.0375/M。 */
const INPUT_PRICE_SHORT = 0.15;
const INPUT_PRICE_LONG = 0.2;
const INPUT_PRICE_CACHED = 0.0375;
const OUTPUT_PRICE_SHORT = 0.6;
const OUTPUT_PRICE_LONG = 0.9;

function costOf(prompt: number, completion: number, cached = 0): number {
  return (
    cached * INPUT_PRICE_CACHED +
    Math.max(0, prompt - cached) * INPUT_PRICE_SHORT +
    completion * OUTPUT_PRICE_SHORT
  ) / 1e6;
}

/** 每个用例独立模型 + 用户/Key/Provider（价格表与明细全局共享，防跨用例泄漏）。 */
async function prepare(
  model: string,
  balance: number,
): Promise<{ userId: number; keyId: number; providerId: number }> {
  const userId = await setupUser(`bq-${model}@test.dev`, balance);
  const { keyId } = await setupKey(userId);
  const providerId = await setupProviderWithModel(model);
  return { userId, keyId, providerId };
}

async function registerPrice(model: string): Promise<void> {
  await setupPrice(
    model,
    INPUT_PRICE_SHORT,
    INPUT_PRICE_LONG,
    INPUT_PRICE_CACHED,
    OUTPUT_PRICE_SHORT,
    OUTPUT_PRICE_LONG,
  );
}

function event(
  requestId: string,
  userId: number,
  keyId: number,
  providerId: number,
  model: string,
  promptTokens: number,
  completionTokens: number,
  extra: Partial<BillingEvent> = {},
): BillingEvent {
  return {
    requestId,
    userId,
    keyId,
    providerId,
    model,
    promptTokens,
    completionTokens,
    status: "success",
    latencyMs: 5,
    upstreamLatencyMs: null,
    ts: Date.now(),
    ...extra,
  };
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.mocked(sendUsageEvent).mockClear();
});

describe("延迟计费消费者（consumeBillingBatch）", () => {
  it("批内落账：明细(带 requestId) + 条件扣费 + usage 流水 + 聚合事件", async () => {
    const model = "bq-ok-model";
    const { userId, keyId, providerId } = await prepare(model, 10);
    await registerPrice(model);

    const e = event(crypto.randomUUID(), userId, keyId, providerId, model, 1000, 500);
    await consumeBillingBatch(makeBillingBatch([e]), env);

    const cost = costOf(1000, 500);
    expect(await getBalance(userId)).toBeCloseTo(10 - cost, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");

    // 明细行携带 request_id（幂等键落库）
    const db = createDb(env);
    const log = await db.query.requestLogs.findFirst({
      where: eq(requestLogs.requestId, e.requestId),
      columns: { requestId: true, cost: true, model: true },
    });
    expect(log).toEqual({ requestId: e.requestId, cost, model });

    // 聚合事件从消费者发出（cost/日期口径 = 结算时刻 ts）
    expect(sendUsageEvent).toHaveBeenCalledTimes(1);
    expect(sendUsageEvent).toHaveBeenCalledWith(
      env.USAGE_QUEUE,
      expect.objectContaining({
        userId,
        keyId,
        model,
        promptTokens: 1000,
        completionTokens: 500,
        cost,
        status: "success",
        ts: e.ts,
      }),
    );
  });

  it("幂等：同 requestId 重复投递 → 冲突跳过（余额只扣一次、单条流水、单条明细）", async () => {
    const model = "bq-dupe-model";
    const { userId, keyId, providerId } = await prepare(model, 10);
    await registerPrice(model);

    const e = event(crypto.randomUUID(), userId, keyId, providerId, model, 100, 50);
    // at-least-once 整批重投：同一事件投两次
    await consumeBillingBatch(makeBillingBatch([e]), env);
    await consumeBillingBatch(makeBillingBatch([e]), env);

    const cost = costOf(100, 50);
    expect(await getBalance(userId)).toBeCloseTo(10 - cost, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    const db = createDb(env);
    const rows = await db
      .select({ requestId: requestLogs.requestId })
      .from(requestLogs)
      .where(eq(requestLogs.requestId, e.requestId));
    expect(rows).toHaveLength(1);
    expect(sendUsageEvent).toHaveBeenCalledTimes(1); // 重复消息不再发聚合事件
  });

  it("透支：余额不足 → 尽力扣费失败：明细照记、余额不变（不欠款）、无 usage 流水", async () => {
    const model = "bq-poor-model";
    const { userId, keyId, providerId } = await prepare(model, 0.5);
    await registerPrice(model);

    // 100 万输入 + 100 万输出 → cost = 0.15 + 0.6 = 0.75 > 余额 0.5
    const e = event(crypto.randomUUID(), userId, keyId, providerId, model, 1_000_000, 1_000_000);
    await consumeBillingBatch(makeBillingBatch([e]), env);

    // 明细照记（cost 全价），余额不足 → 不扣款不欠款、无流水
    const cost = costOf(1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.75, 12);
    expect(cost).toBeGreaterThan(0.5);
    expect(await getBalance(userId)).toBe(0.5);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("success");
    // 聚合事件仍发出（按实际 cost 口径，报表与明细一致）
    expect(sendUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("免计：价格缺失 → cost=0 只记明细，不扣费、无流水", async () => {
    const model = "bq-noprice-model";
    const { userId, keyId, providerId } = await prepare(model, 10);
    // 不注册价格

    const e = event(crypto.randomUUID(), userId, keyId, providerId, model, 100, 50);
    await consumeBillingBatch(makeBillingBatch([e]), env);

    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("success");
    expect(sendUsageEvent).toHaveBeenCalledWith(
      env.USAGE_QUEUE,
      expect.objectContaining({ cost: 0, status: "success" }),
    );
  });

  it("缓存分层定价：cachedTokens 按缓存价计费（calcCost 口径）", async () => {
    const model = "bq-cached-model";
    const { userId, keyId, providerId } = await prepare(model, 10);
    await registerPrice(model);

    const e = event(crypto.randomUUID(), userId, keyId, providerId, model, 10_000, 500, {
      cachedTokens: 8_000,
      latencyMs: 4,
      upstreamLatencyMs: 3,
    });
    await consumeBillingBatch(makeBillingBatch([e]), env);

    const price = {
      inputPriceShort: INPUT_PRICE_SHORT,
      inputPriceLong: INPUT_PRICE_LONG,
      inputPriceCached: INPUT_PRICE_CACHED,
      outputPriceShort: OUTPUT_PRICE_SHORT,
      outputPriceLong: OUTPUT_PRICE_LONG,
    };
    const expected = calcCost(
      { promptTokens: 10_000, completionTokens: 500, cachedTokens: 8_000 },
      price,
    );
    expect(expected).toBeCloseTo(costOf(10_000, 500, 8_000), 12);
    expect(await getBalance(userId)).toBeCloseTo(10 - expected, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });

  it("结算时刻价格：事件发出后调价，消费按新价扣费（响应路径不查价）", async () => {
    const model = "bq-reprice-model";
    const { userId, keyId, providerId } = await prepare(model, 10);
    await registerPrice(model);

    // 事件 1：按当前价扣
    const e1 = event(crypto.randomUUID(), userId, keyId, providerId, model, 100, 50);
    await consumeBillingBatch(makeBillingBatch([e1]), env);
    const costA = costOf(100, 50);
    expect(await getBalance(userId)).toBeCloseTo(10 - costA, 10);

    // 调价后的事件 2：消费按结算时刻（当前）价格扣 —— 与事件 1 同 token 但价不同
    await setupPrice(model, 0.3, 0.4, 0.0375, 1.2, 1.8);
    const e2 = { ...e1, requestId: crypto.randomUUID() };
    await consumeBillingBatch(makeBillingBatch([e2]), env);
    const costB = (100 * 0.3 + 50 * 1.2) / 1e6;
    expect(costB).not.toBeCloseTo(costA, 12);
    expect(await getBalance(userId)).toBeCloseTo(10 - costA - costB, 10);
  });

  it("非法消息跳过：批内坏消息不影响其余消息结算", async () => {
    const model = "bq-invalid-model";
    const { userId, keyId, providerId } = await prepare(model, 10);
    await registerPrice(model);

    const valid = event(crypto.randomUUID(), userId, keyId, providerId, model, 100, 50);
    // 坏消息：缺 userId、tokens 为负数、model 为空
    const badMessage = {
      id: "billing-msg-bad",
      timestamp: new Date(),
      body: { requestId: crypto.randomUUID(), promptTokens: -1, model: "" },
      attempts: 1,
      retry: () => {},
      ack: () => {},
    };
    const base = makeBillingBatch([valid]);
    const batch = { ...base, messages: [...base.messages, badMessage] };
    await consumeBillingBatch(batch, env);

    const cost = costOf(100, 50);
    expect(await getBalance(userId)).toBeCloseTo(10 - cost, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });
});
