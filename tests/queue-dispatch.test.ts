// Queues 分流单测（09-21-prod-resource-naming）。
//
// `queue()`（src/index.ts）按 `batch.queue === env.BILLING_QUEUE_NAME` **精确比对**分流：
// 相等 ⇒ 延迟计费消费者；否则 ⇒ 用量聚合消费者。`BILLING_QUEUE_NAME` 因而是**双重身份** token
// —— 既是 wrangler 的 producer/consumer 绑定值（`[[queues.*]] queue = "{BILLING_QUEUE_NAME}"`），
// 又是运行期分流谓词（`[vars] BILLING_QUEUE_NAME`）。两侧漂移的后果是**静默不扣费**：
// 计费事件体不含 `cost`（见 billingEventSchema），落进用量分支会被 usageEventSchema 挡下、
// 只留一条 warn 日志 —— 余额、流水、聚合三处都不动，无痕。
//
// 为什么单开一个文件：此前全仓**没有任何用例经过 queue()** —— billing-queue.test.ts 直驱
// consumeBillingBatch，而该函数根本不读 batch.queue。2026-09-22 变异验证：把 helpers 的批名
// 改回旧名 "billing-aggregation"，billing-queue.test.ts 仍 8/8 全绿（批名对它是死字面量）。
// 本文件把「**同一事件体，只改批名，落点不同**」锁成断言，使「改队列名」这类操作有判别性护栏。
//
// 覆盖矩阵（A 与 A′ 互为对照：没有 A′，A 会被「无条件扣费」的实现平凡满足）：
//   A  批名 = env.BILLING_QUEUE_NAME ⇒ 扣费 + 记流水
//   A′ 批名 = 历史名（≠）           ⇒ 不扣费、不留痕 —— 改名而谓词没跟上时的故障形态
//   B  env.BILLING_QUEUE_NAME 缺失  ⇒ 抛错（fail-fast，防计费消息被当用量批静默丢弃）
//   C  批名 = 用量队列名            ⇒ usage_daily 聚合（else 分支仍在，防「一切都计费」回归）
import { createExecutionContext, createMessageBatch, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { usageDaily } from "../src/db/schema";
import { queue } from "../src/index";
import type { BillingEvent } from "../src/lib/billing-queue";
import type { UsageEvent } from "../src/lib/usage-aggregation";
import {
  applyMigrations,
  countTxByType,
  getBalance,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

/** 测试价格（与 billing-queue.test.ts 同口径）：输入 0.15/M、输出 0.6/M、缓存输入 0.0375/M。 */
const INPUT_PRICE_SHORT = 0.15;
const INPUT_PRICE_LONG = 0.2;
const INPUT_PRICE_CACHED = 0.0375;
const OUTPUT_PRICE_SHORT = 0.6;
const OUTPUT_PRICE_LONG = 0.9;

const PROMPT_TOKENS = 1000;
const COMPLETION_TOKENS = 500;

function costOf(prompt: number, completion: number, cached = 0): number {
  return (
    cached * INPUT_PRICE_CACHED +
    Math.max(0, prompt - cached) * INPUT_PRICE_SHORT +
    completion * OUTPUT_PRICE_SHORT
  ) / 1e6;
}

/** 用量队列名（仅作标签：`else` 分支不做名字比对，故此处写字面量即可）。 */
const USAGE_QUEUE_NAME = "cf-ai-gateway-usage";

/** 2026-09-21 更名前的计费队列名 —— A′ 用它扮演「绑定已换名、运行期谓词没跟上」。 */
const LEGACY_BILLING_QUEUE_NAME = "billing-aggregation";

function billingEvent(
  userId: number,
  keyId: number,
  providerId: number,
  model: string,
  ts: number,
): BillingEvent {
  return {
    requestId: crypto.randomUUID(),
    userId,
    keyId,
    providerId,
    model,
    promptTokens: PROMPT_TOKENS,
    completionTokens: COMPLETION_TOKENS,
    status: "success",
    latencyMs: 10,
    upstreamLatencyMs: 8,
    ts,
  };
}

/** 单消息批（body 即为事件体；attempts/timestamp 是 ServiceBindingQueueMessage 的必填项）。 */
function oneMessageBatch(queueName: string, body: unknown, ts: number): MessageBatch<unknown> {
  return createMessageBatch(queueName, [
    { id: "qd-msg-1", timestamp: new Date(ts), attempts: 1, body },
  ]);
}

async function usageRowCount(userId: number): Promise<number> {
  const db = createDb(env);
  const rows = await db.select().from(usageDaily).where(eq(usageDaily.userId, userId));
  return rows.length;
}

describe("queue() 队列名分流", () => {
  beforeAll(applyMigrations);

  it("A: 批名 = env.BILLING_QUEUE_NAME ⇒ 扣费 + 记 usage 流水", async () => {
    const model = "qd-name-match";
    const userId = await setupUser("qd-a@test.dev", 1);
    const { keyId } = await setupKey(userId);
    const providerId = await setupProviderWithModel(model);
    await setupPrice(
      model,
      INPUT_PRICE_SHORT,
      INPUT_PRICE_LONG,
      INPUT_PRICE_CACHED,
      OUTPUT_PRICE_SHORT,
      OUTPUT_PRICE_LONG,
    );

    // 前置：本键必须已被 vitest.config.ts pin —— 否则 A 测的就不是分流（B 已单独覆盖「空值抛错」）。
    // 显式抛错而非 `!`：缺 pin 时报错点在这里，而不是伪装成一次金额断言失败。
    const configuredName = env.BILLING_QUEUE_NAME;
    if (!configuredName) {
      throw new Error("vitest.config.ts 未 pin BILLING_QUEUE_NAME —— 本用例测不到分流");
    }

    const ts = Date.now();
    const batch = oneMessageBatch(
      configuredName,
      billingEvent(userId, keyId, providerId, model, ts),
      ts,
    );
    await queue(batch, env, createExecutionContext());

    expect(await getBalance(userId)).toBeCloseTo(
      1 - costOf(PROMPT_TOKENS, COMPLETION_TOKENS),
      10,
    );
    expect(await countTxByType(userId, "usage")).toBe(1);
  });

  it("A′: 批名 ≠ env.BILLING_QUEUE_NAME ⇒ 不扣费、不留痕（同一事件体，仅批名不同）", async () => {
    const model = "qd-name-mismatch";
    const userId = await setupUser("qd-a2@test.dev", 1);
    const { keyId } = await setupKey(userId);
    const providerId = await setupProviderWithModel(model);
    await setupPrice(
      model,
      INPUT_PRICE_SHORT,
      INPUT_PRICE_LONG,
      INPUT_PRICE_CACHED,
      OUTPUT_PRICE_SHORT,
      OUTPUT_PRICE_LONG,
    );

    const ts = Date.now();
    const batch = oneMessageBatch(
      LEGACY_BILLING_QUEUE_NAME,
      billingEvent(userId, keyId, providerId, model, ts),
      ts,
    );
    await queue(batch, env, createExecutionContext());

    // 不扣费、不记流水：批名不匹配 ⇒ 落用量分支。
    expect(await getBalance(userId)).toBe(1);
    expect(await countTxByType(userId, "usage")).toBe(0);
    // 且**不留痕**：事件体不含 cost ⇒ usageEventSchema 挡下 ⇒ 连 usage_daily 也不新增。
    // 这三条合起来就是生产故障的完整形状：钱没扣，账上也没有任何迹象。
    expect(await usageRowCount(userId)).toBe(0);
  });

  it("B: env.BILLING_QUEUE_NAME 缺失 ⇒ 抛错（fail-fast，防计费消息被当用量批静默丢弃）", async () => {
    // 局部翻转而非并进 helpers.withSwitch：`BILLING_QUEUE_NAME` 在 Cloudflare.Env 里是**必填 string**
    // （不是 `string | undefined`），塞进 withSwitch 的联合类型会让 `env[key] = value` 类型检查失败
    // —— 与 BETTER_AUTH_URL 同一情形（见 helpers.ts 的 withBetterAuthUrl 注释）。
    const original = env.BILLING_QUEUE_NAME;
    const ts = Date.now();
    try {
      env.BILLING_QUEUE_NAME = "";
      const batch = oneMessageBatch(
        LEGACY_BILLING_QUEUE_NAME,
        billingEvent(1, 1, 1, "qd-unconfigured", ts),
        ts,
      );
      await expect(queue(batch, env, createExecutionContext())).rejects.toThrow(
        /BILLING_QUEUE_NAME/,
      );
    } finally {
      env.BILLING_QUEUE_NAME = original;
    }
  });

  it("C: 批名 = 用量队列名 ⇒ usage_daily 聚合（else 分支仍在）", async () => {
    const model = "qd-usage-branch";
    const userId = await setupUser("qd-c@test.dev", 1);
    const { keyId } = await setupKey(userId);

    const ts = Date.now();
    const event: UsageEvent = {
      userId,
      keyId,
      model,
      promptTokens: 100,
      completionTokens: 20,
      cost: 0.5,
      status: "success",
      ts,
    };
    const batch = oneMessageBatch(USAGE_QUEUE_NAME, event, ts);
    await queue(batch, env, createExecutionContext());

    const db = createDb(env);
    const rows = await db.select().from(usageDaily).where(eq(usageDaily.userId, userId));
    expect(rows.length).toBe(1);
    expect(rows[0]?.requests).toBe(1);
    expect(rows[0]?.cost).toBeCloseTo(0.5, 10);
    // 用量分支不碰余额（对照 A：同一次 queue() 调用，落点不同则账目不同）。
    expect(await getBalance(userId)).toBe(1);
  });
});
