// 延迟计费（08-31-perf-v2：Queues 解耦）：成功路径（非流式/流式 settle）只发计费事件，
// 扣费 + 明细 + balance_tx 流水 + 聚合事件全部在消费者（consumeBillingBatch）批内完成。
//
// 设计决策（design.md §3）：
// - 事件不含 cost：响应路径不查价格（findModelPrice 是 D1 读），消费者用**结算时刻价格**计算。
// - 幂等 = DB 唯一约束：request_logs.request_id 部分唯一索引；重复投递（at-least-once 整批重投）
//   INSERT ... ON CONFLICT DO NOTHING → 冲突跳过。无 KV 去重窗口。
// - 透支 = 尽力扣费：复用条件 UPDATE（balance >= cost），0 行 → overdraft 日志不追扣。
// - 聚合事件（usage_daily）从消费者发出：成功路径不再双发（0 queue 双发）。
// - 错误路径（上游失败/拒绝/缓存命中）保持同步明细（proxy.ts），request_id 统一生成。
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db";
import { balanceTx, requestLogs, users } from "../db/schema";
import type { TokenUsage } from "../providers/types";
import { calcCost, findModelPrice } from "./billing";
import { logger } from "./logger";
import { sendUsageEvent } from "./usage-aggregation";

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
 * 发送计费事件（响应路径旁路管道）。失败只记日志不抛错：
 * 延迟计费是性能优化，不应让响应路径因 enqueue 失败而 5xx（与 sendUsageEvent 同规范）。
 */
export async function sendBillingEvent(
  queue: Queue<BillingEvent>,
  event: BillingEvent,
): Promise<void> {
  try {
    await queue.send(event);
  } catch (error) {
    logger.error("billing_event_send_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 计费消费者（Queues handler → consumeBillingBatch）：批内逐消息
 * 校验 → 结算时刻价格 → cost → 明细(幂等) → 条件扣费 → 流水 → 聚合事件。
 * 非法消息跳过并记日志，不中断整批（与 consumeUsageBatch 同规范）。
 */
export async function consumeBillingBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const db = createDb(env);

  for (const message of batch.messages) {
    const parsed = billingEventSchema.safeParse(message.body);
    if (!parsed.success) {
      logger.warn("billing_event_invalid", {
        queue: batch.queue,
        error: parsed.error.message,
      });
      continue;
    }
    const event = parsed.data;

    // 结算时刻价格（响应路径不查价；价格缺失 → cost=0 只记明细不扣费）
    const price = await findModelPrice(db, event.model);
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
      })
      .onConflictDoNothing()
      .returning({ id: requestLogs.id });
    if (inserted.length === 0) {
      logger.info("billing_duplicate_skipped", {
        queue: batch.queue,
        requestId: event.requestId,
      });
      continue;
    }
    const logId = inserted[0];
    if (!logId) {
      // returning 有行时必含 id（不可达防御）
      continue;
    }

    // 尽力扣费（透支策略 = 条件 UPDATE 复用）：0 行 → 余额不足，记日志不追扣
    if (cost > 0) {
      const updated = await db
        .update(users)
        .set({
          balance: sql`${users.balance} - ${cost}`,
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, event.userId), gte(users.balance, cost)))
        .returning({ id: users.id });
      if (updated.length === 0) {
        logger.warn("overdraft_rejected", {
          userId: event.userId,
          cost,
          model: event.model,
        });
      } else {
        await db.insert(balanceTx).values({
          userId: event.userId,
          amount: -cost,
          type: "usage",
          note: `usage: ${event.model}`,
          refRequestId: logId.id,
        });
      }
    }

    // 聚合事件（原请求路径 enqueueUsageEvent 搬入；日期口径 = 结算时刻 event.ts，
    // 避免消费侧 Date.now() 在 UTC 日界漂移一天）
    await sendUsageEvent(env.USAGE_QUEUE, {
      userId: event.userId,
      keyId: event.keyId,
      model: event.model,
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      cost,
      status: "success",
      ts: event.ts,
    });
  }

  logger.info("billing_batch_processed", {
    queue: batch.queue,
    messages: batch.messages.length,
  });
}
