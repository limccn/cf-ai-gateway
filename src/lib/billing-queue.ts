// 延迟计费（08-31-perf-v2：Queues 解耦）：成功路径（非流式/流式 settle）只发计费事件，
// 扣费 + 明细 + balance_tx 流水 + usage_daily 聚合全部在消费者（consumeBillingBatch）批内完成。
//
// 设计决策（design.md §3 + 09-01-review 用户确认）：
// - 事件不含 cost：响应路径不查价格（findModelPrice 是 D1 读），消费者用**结算时刻价格**计算。
// - 幂等 = DB 唯一约束：request_logs.request_id 部分唯一索引；重复投递（at-least-once 整批重投）
//   INSERT ... ON CONFLICT DO NOTHING → 冲突跳过。无 KV 去重窗口。
// - 债务模型（D2/U3）：扣费为**无条件递减**——余额允许变为负（= 债务，充值自愈，
//   预检在 balance < 0 时 402 拦截新请求）。不再条件 UPDATE（旧语义：并发突发超额部分
//   被拒 → 白送且无追扣）。
// - 原子性（H9/H10）：per-message 的 [扣费 + balance_tx + usage_daily upsert] 在
//   同一 D1 batch（事务）内执行——消除"扣费成功但聚合丢失/重投双计"窗口；重投时
//   request_logs 冲突跳过 → 批不执行 → 不双计。
// - 逐条容错（U4）：单条消息失败（D1 抖动等）只记日志不中断整批（Queues 消息级
//   重投不可行）；request_id 幂等 + error 日志（含 requestId，可检索人工重放）。
// - enqueue 降级（U5）：queue.send 失败 → 同环境同步执行该消息扣费（事件不丢）；
//   仍失败 → 大声告警（错误可见）。
// - 错误路径（上游失败/拒绝/缓存命中）保持同步明细（proxy.ts），request_id 统一生成。
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "../db";
import { balanceTx, requestLogs, usageDaily, users } from "../db/schema";
import type { TokenUsage } from "../providers/types";
import { calcCost, findModelPrice, type ModelPrice } from "./billing";
import { logger } from "./logger";
import { toDateKey } from "./usage-aggregation";

/** 计费事件（Queues 消息体）：一条成功请求的完整结算数据。cost 不在事件内（见文件头）。 */
export const billingEventSchema = z.object({
  /** 幂等键：请求路径 crypto.randomUUID()（handler 顶部生成，错误路径明细同键）。 */
  requestId: z.string().min(1).max(64),
  userId: z.number().int().positive(),
  keyId: z.number().int().positive(),
  providerId: z.number().int().positive().nullable(),
  /** billingModel：掩码后的公开名（剥离 [1m] 后缀；与 request_logs.model 口径一致）。 */
  model: z.string().min(1).max(200),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  /** 缓存命中输入 tokens（Anthropic cache_read / OpenAI cached_tokens）；缺失按 0 计。
   * 相对 design.md §3 的补充：calcCost 分层依赖缓存细分，缺失会按未缓存全价计（计费回归）。 */
  cachedTokens: z.number().int().min(0).optional(),
  status: z.literal("success"),
  latencyMs: z.number().int().min(0),
  upstreamLatencyMs: z.number().int().min(0).nullable(),
  /** epoch ms（请求结算时刻，聚合日期口径；消费者按此写 usage_daily 日期键）。 */
  ts: z.number().int().positive(),
});

export type BillingEvent = z.infer<typeof billingEventSchema>;

export interface BillingEventInput {
  requestId: string;
  userId: number;
  keyId: number;
  providerId: number;
  model: string;
  usage: TokenUsage | null;
  latencyMs: number;
  upstreamLatencyMs: number | null;
  ts: number;
}

/** 事件组装 helper（请求路径统一入口；usage 缺失 → tokens 按 0，免计由消费者按价格判定）。 */
export function buildBillingEvent(input: BillingEventInput): BillingEvent {
  return {
    requestId: input.requestId,
    userId: input.userId,
    keyId: input.keyId,
    providerId: input.providerId,
    model: input.model,
    promptTokens: input.usage?.promptTokens ?? 0,
    completionTokens: input.usage?.completionTokens ?? 0,
    ...(input.usage?.cachedTokens !== undefined
      ? { cachedTokens: input.usage.cachedTokens }
      : {}),
    status: "success",
    latencyMs: input.latencyMs,
    upstreamLatencyMs: input.upstreamLatencyMs,
    ts: input.ts,
  };
}

/**
 * 发送计费事件（响应路径旁路管道）。失败 → **降级同步扣费**（U5：事件不丢；
 * 绑定缺失/worker 换置前未完成 send 不再导致"200 但永不记账"）。
 * 同步扣费仍失败 → 大声告警（错误可见、requestId 可检索，人工重放兜底）。
 */
export async function sendBillingEvent(
  queue: Queue<BillingEvent>,
  event: BillingEvent,
  env: Env,
): Promise<void> {
  try {
    await queue.send(event);
  } catch (error) {
    logger.error("billing_event_send_failed", {
      error: error instanceof Error ? error.message : String(error),
      requestId: event.requestId,
    });
    try {
      const db = createDb(env);
      await processBillingEvent(db, event);
      logger.error("billing_event_sync_charged", { requestId: event.requestId });
    } catch (syncError) {
      logger.error("billing_event_sync_charge_failed", {
        requestId: event.requestId,
        error: syncError instanceof Error ? syncError.message : String(syncError),
      });
    }
  }
}

/**
 * 单条计费事件处理（消费者逐条执行；也是 enqueue 失败时的同步降级路径）：
 * 明细（幂等）→ 结算时刻价格 → [扣费 + 流水 + usage_daily] 同批原子（H9/H10）。
 * 抛错由调用方处理（消费者逐条 catch 不中断整批；降级路径 loud error）。
 * 效率项（09-01-review）：priceCache 按 model 去重 findModelPrice（同批多消息同模型只查一次
 * D1；批处理毫秒级，结算时刻价格一致）。同步降级路径不传 → 行为不变。
 */
export async function processBillingEvent(
  db: Db,
  event: BillingEvent,
  priceCache?: Map<string, ModelPrice | null>,
): Promise<void> {
  // 结算时刻价格（响应路径不查价；价格缺失 → cost=0 只记明细不扣费）
  let price = priceCache?.get(event.model);
  if (price === undefined) {
    price = await findModelPrice(db, event.model);
    priceCache?.set(event.model, price);
  }
  const usage: TokenUsage = {
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
    ...(event.cachedTokens !== undefined ? { cachedTokens: event.cachedTokens } : {}),
  };
  const cost = price !== null ? calcCost(usage, price) : 0;
  if (price === null) {
    logger.info("charge_skipped", {
      providerId: event.providerId,
      model: event.model,
      reason: "no_price",
    });
  }

  // 幂等：request_id 唯一约束（部分唯一索引）→ 重复投递冲突跳过（已处理的行不再重复扣费）。
  // 注意：不指定 conflict target —— SQLite 对「部分索引列」做冲突目标要求 UPSERT 重复其 WHERE
  // 子句，drizzle 的 onConflictDoNothing({target}) 不生成该 WHERE（实测 D1 SQLITE_ERROR）；
  // 无 target 的 `ON CONFLICT DO NOTHING` 匹配任意唯一约束（含部分唯一索引），PRD 原文即此形态。
  const inserted = await db
    .insert(requestLogs)
    .values({
      requestId: event.requestId,
      userId: event.userId,
      keyId: event.keyId,
      providerId: event.providerId,
      model: event.model,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      cost,
      latencyMs: event.latencyMs,
      upstreamLatencyMs: event.upstreamLatencyMs,
      status: "success",
      // H7：行时间 = 事件时刻（跨日积压时 range/usage_daily 桶不错位）
      createdAt: new Date(event.ts),
    })
    .onConflictDoNothing()
    .returning({ id: requestLogs.id });
  if (inserted.length === 0) {
    logger.info("billing_duplicate_skipped", {
      requestId: event.requestId,
    });
    return;
  }
  const logRow = inserted[0];
  if (!logRow) {
    // returning 有行时必含 id（不可达防御）
    return;
  }
  const logId = logRow.id;

  // usage_daily 聚合（无论 cost 是否 > 0：免计请求也以零额入报表，口径与原 USAGE_QUEUE 一致）
  const dailyUpsert = db
    .insert(usageDaily)
    .values({
      userId: event.userId,
      keyId: event.keyId,
      model: event.model,
      date: toDateKey(event.ts),
      requests: 1,
      tokensIn: event.promptTokens,
      tokensOut: event.completionTokens,
      cost,
    })
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.keyId, usageDaily.model, usageDaily.date],
      set: {
        requests: sql`${usageDaily.requests} + excluded.requests`,
        tokensIn: sql`${usageDaily.tokensIn} + excluded.tokens_in`,
        tokensOut: sql`${usageDaily.tokensOut} + excluded.tokens_out`,
        cost: sql`${usageDaily.cost} + excluded.cost`,
      },
    });

  // D2 债务模型：无条件递减（余额可为负）；扣费 + 流水 + usage_daily 同批原子（H9/H10）。
  if (cost > 0) {
    const [updated] = await db.batch([
      db
        .update(users)
        .set({
          balance: sql`${users.balance} - ${cost}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, event.userId))
        .returning({ balance: users.balance }),
      db.insert(balanceTx).values({
        userId: event.userId,
        amount: -cost,
        type: "usage",
        note: `usage: ${event.model}`,
        refRequestId: logId,
        createdAt: new Date(event.ts),
      }),
      dailyUpsert,
    ]);
    const balance = updated[0]?.balance;
    if (balance !== undefined && balance < 0) {
      // 债务：余额进入负值（预检在下一次请求 402 拦截；充值自愈）
      logger.warn("balance_debt", {
        userId: event.userId,
        balance,
        model: event.model,
      });
    }
  } else {
    await db.batch([dailyUpsert]);
  }
}

/**
 * 计费消费者（Queues handler → consumeBillingBatch）：批内逐消息容错处理。
 * 单条失败不中断整批（U4）——队列 at-least-once 重投是批次级（一条失败整批重投会
 * 拖垮全部），以 request_id 幂等 + error 日志（requestId 可检索）兜底。
 */
export async function consumeBillingBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const db = createDb(env);
  let failed = 0;
  // 效率项（09-01-review）：批内按 model 去重查价（同批多消息同模型只查一次 D1）
  const priceCache = new Map<string, ModelPrice | null>();

  for (const message of batch.messages) {
    const parsed = billingEventSchema.safeParse(message.body);
    if (!parsed.success) {
      logger.warn("billing_event_invalid", {
        queue: batch.queue,
        error: parsed.error.message,
      });
      continue;
    }
    try {
      await processBillingEvent(db, parsed.data, priceCache);
    } catch (error) {
      failed += 1;
      logger.error("billing_event_processing_failed", {
        queue: batch.queue,
        requestId: parsed.data.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("billing_batch_processed", {
    queue: batch.queue,
    messages: batch.messages.length,
    ...(failed > 0 ? { failed } : {}),
  });
}
