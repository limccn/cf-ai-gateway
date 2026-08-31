// M5 用量聚合管道（5.2）：明细落库后 enqueue 聚合事件 → Queues consumer 批量 upsert usage_daily。
// 设计（design.md §3 步骤 8 / §8 权衡）：聚合异步化，明细写入不阻塞请求路径；报表分钟级延迟可接受。
// 日期口径：统一 UTC 的 YYYY-MM-DD（toDateKey），消费侧与报表侧同源，避免时区歧义。
// 生产者：proxy 结算点（成功/流式结算/缓存命中/失败）落明细后调用 enqueueUsageEvent（waitUntil 旁路）。
// 消费者：批内按 (user_id, key_id, model, date) 分组求和（无循环内 await），分批 upsert。
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db";
import { usageDaily } from "../db/schema";
import type { RequestLogRecord } from "./billing";
import { logger } from "./logger";

/** 聚合事件（Queues 消息体）：一条 request_logs 明细对应的增量；consumer 侧再次校验（unknown 窄化）。 */
export const usageEventSchema = z.object({
  userId: z.number().int().positive(),
  keyId: z.number().int().positive(),
  model: z.string().min(1).max(200),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  cost: z.number().min(0),
  status: z.enum(["success", "error", "cached", "rejected"]),
  ts: z.number().int().positive(), // epoch ms（结算时刻），用于推导聚合日期
});

export type UsageEvent = z.infer<typeof usageEventSchema>;

/** epoch ms → UTC YYYY-MM-DD（usage_daily.date 与报表分组的统一口径）。 */
export function toDateKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * 由明细记录构建聚合事件。
 * 无归属记录（userId/keyId/model 任一为 null，如鉴权失败的 rejected 行）不参与聚合 → 返回 null。
 */
export function buildUsageEvent(log: RequestLogRecord): UsageEvent | null {
  if (log.userId === null || log.keyId === null || log.model === null) {
    return null;
  }
  return {
    userId: log.userId,
    keyId: log.keyId,
    model: log.model,
    promptTokens: log.promptTokens ?? 0,
    completionTokens: log.completionTokens ?? 0,
    cost: log.cost ?? 0,
    status: log.status,
    ts: Date.now(),
  };
}

/**
 * 发送聚合事件（Queues at-least-once；consumer upsert 累加幂等）。
 * 失败只记日志不抛错：enqueue 是旁路管道，不应影响请求路径（waitUntil 场景）。
 */
export async function sendUsageEvent(
  queue: Queue<UsageEvent>,
  event: UsageEvent,
): Promise<void> {
  try {
    await queue.send(event);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("usage_event_send_failed", { error: error.message });
    } else {
      logger.error("usage_event_send_failed", {});
    }
  }
}

/** 明细落库后的标准 enqueue 入口：由 record 构建事件并发送（无归属记录自动跳过）。 */
export async function enqueueUsageEvent(
  queue: Queue<UsageEvent>,
  log: RequestLogRecord,
): Promise<void> {
  const event = buildUsageEvent(log);
  if (event === null) {
    return;
  }
  await sendUsageEvent(queue, event);
}

// ============ 消费者（Queues handler → upsert usage_daily） ============

interface UsageAggRow {
  userId: number;
  keyId: number;
  model: string;
  date: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/**
 * 单条 INSERT 的行数上限：D1 每语句 bound parameters 上限 100（并非 SQLite 的 999；
 * 实测 30 行×8 列=240 参数整语句失败）→ 8 列/行 → 每 chunk ≤ 12 行（12×8=96 ≤ 100）。
 */
const UPSERT_CHUNK_SIZE = 12;

/**
 * Queues 消费者：批内先按 (user_id, key_id, model, date) 内存分组求和（无循环内 await），
 * 再分批 INSERT ... ON CONFLICT DO UPDATE 累加。非法消息跳过并记日志，不中断整批。
 */
export async function consumeUsageBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const db = createDb(env);
  const grouped = new Map<string, UsageAggRow>();

  for (const message of batch.messages) {
    const parsed = usageEventSchema.safeParse(message.body);
    if (!parsed.success) {
      logger.warn("usage_event_invalid", {
        queue: batch.queue,
        error: parsed.error.message,
      });
      continue;
    }
    const event = parsed.data;
    const date = toDateKey(event.ts);
    // JSON 编码组键：字段值可能含分隔符（model 为用户侧任意文本），JSON 序列化保证分组无歧义。
    const rowKey = JSON.stringify([event.userId, event.keyId, event.model, date]);
    const existing = grouped.get(rowKey);
    if (existing !== undefined) {
      existing.requests += 1;
      existing.tokensIn += event.promptTokens;
      existing.tokensOut += event.completionTokens;
      existing.cost += event.cost;
    } else {
      grouped.set(rowKey, {
        userId: event.userId,
        keyId: event.keyId,
        model: event.model,
        date,
        requests: 1,
        tokensIn: event.promptTokens,
        tokensOut: event.completionTokens,
        cost: event.cost,
      });
    }
  }

  const rows = [...grouped.values()];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    await db
      .insert(usageDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          usageDaily.userId,
          usageDaily.keyId,
          usageDaily.model,
          usageDaily.date,
        ],
        set: {
          requests: sql`${usageDaily.requests} + excluded.requests`,
          tokensIn: sql`${usageDaily.tokensIn} + excluded.tokens_in`,
          tokensOut: sql`${usageDaily.tokensOut} + excluded.tokens_out`,
          cost: sql`${usageDaily.cost} + excluded.cost`,
        },
      });
  }

  logger.info("usage_batch_aggregated", {
    queue: batch.queue,
    messages: batch.messages.length,
    rows: rows.length,
  });
}
