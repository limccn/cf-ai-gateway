// 计费核心（M4 4.1-4.3）：价格表查询、费用计算、条件 UPDATE 原子扣费 + balance_tx 流水。
// 原子性说明（design §8）：并发防超扣依赖**单条条件 UPDATE**（`balance >= cost`）的原子性，
// 不依赖显式 BEGIN/COMMIT 事务（并发多会话显式事务会互相干扰，且 D1 单语句本身原子）。
// 流水/明细为审计轨迹：扣费成功才写 usage 流水；扣费失败（余额耗尽）保留明细、不写流水。
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db";
import { balanceTx, models, requestLogs, users } from "../db/schema";
import type { TokenUsage } from "../providers/types";

export type RequestLogStatus = "success" | "error" | "cached" | "rejected";

export interface ModelPrice {
  inputPrice: number;
  outputPrice: number;
}

/** 单价单位：USD / 每百万 tokens（seed.sql 与 models 表一致）。 */
const PRICE_PER_MILLION = 1_000_000;

/** 费用 = prompt_tokens × 输入单价 + completion_tokens × 输出单价（PRD R5.2）。 */
export function calcCost(usage: TokenUsage, price: ModelPrice): number {
  const inputCost = (usage.promptTokens * price.inputPrice) / PRICE_PER_MILLION;
  const outputCost = (usage.completionTokens * price.outputPrice) / PRICE_PER_MILLION;
  return inputCost + outputCost;
}

/** 价格表查询（models 表 = seed 默认 + admin 覆盖的唯一来源；查不到返回 null → 免计）。 */
export async function findModelPrice(db: Db, model: string): Promise<ModelPrice | null> {
  const row = await db.query.models.findFirst({
    where: eq(models.model, model),
    columns: { inputPrice: true, outputPrice: true },
  });
  if (!row) {
    return null;
  }
  return { inputPrice: row.inputPrice, outputPrice: row.outputPrice };
}

/**
 * 宽松提取 usage（适配器 parseUsage 返回 null 时兜底，如 embeddings 仅 prompt_tokens）。
 * 顶层 usage 对象中任一 token 数字存在即可；缺失项按 0 计；负数防御性截为 0。
 */
export function extractLooseUsage(body: unknown): TokenUsage | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const usage = (body as Record<string, unknown>)["usage"];
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const prompt = u["prompt_tokens"];
  const completion = u["completion_tokens"];
  if (typeof prompt !== "number" && typeof completion !== "number") {
    return null;
  }
  const promptTokens = typeof prompt === "number" && Number.isFinite(prompt) ? Math.max(0, prompt) : 0;
  const completionTokens =
    typeof completion === "number" && Number.isFinite(completion) ? Math.max(0, completion) : 0;
  return { promptTokens, completionTokens };
}

// ============ request_logs 明细 ============

export interface RequestLogRecord {
  userId: number | null;
  keyId: number | null;
  providerId: number | null;
  model: string | null;
  status: RequestLogStatus;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  latencyMs?: number | null;
  upstreamLatencyMs?: number | null;
}

/** 写 request_logs 明细（成功/失败/缓存均落明细，PRD AC4/AC5）。返回明细 id。 */
export async function recordRequestLog(db: Db, input: RequestLogRecord): Promise<number> {
  const [row] = await db
    .insert(requestLogs)
    .values({
      userId: input.userId,
      keyId: input.keyId,
      providerId: input.providerId,
      model: input.model,
      status: input.status,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      cost: input.cost ?? 0,
      latencyMs: input.latencyMs ?? null,
      upstreamLatencyMs: input.upstreamLatencyMs ?? null,
    })
    .returning({ id: requestLogs.id });
  if (!row) {
    throw new Error("Failed to insert request log");
  }
  return row.id;
}

// ============ 原子扣费 ============

export interface ChargeUsageInput extends RequestLogRecord {
  userId: number;
  keyId: number;
  model: string;
  cost: number;
}

export interface ChargeResult {
  /** 是否实际扣费（余额足够）；false 可能表示 cost<=0 或并发下余额耗尽（overdraft） */
  charged: boolean;
  logId: number;
}

/**
 * 成功请求结算：写明细 → 条件 UPDATE 原子扣费 → balance_tx(usage) 流水。
 * - cost <= 0（无 usage / 无价格）→ 仅记明细不扣费。
 * - 条件 UPDATE 影响行数为 0 → 并发下余额不足（overdraft）：不扣费、不写 usage 流水，
 *   明细保留（响应已成功返回），返回 charged=false，由调用方记录 warn。
 */
export async function chargeUsage(db: Db, input: ChargeUsageInput): Promise<ChargeResult> {
  const logId = await recordRequestLog(db, input);

  if (input.cost <= 0) {
    return { charged: false, logId };
  }

  const updated = await db
    .update(users)
    .set({
      balance: sql`${users.balance} - ${input.cost}`,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, input.userId), gte(users.balance, input.cost)))
    .returning({ id: users.id });

  if (updated.length === 0) {
    return { charged: false, logId };
  }

  await db.insert(balanceTx).values({
    userId: input.userId,
    amount: -input.cost,
    type: "usage",
    note: `usage: ${input.model}`,
    refRequestId: logId,
  });
  return { charged: true, logId };
}

// ============ admin 余额调整（4.6 / R5.1） ============

export interface AdjustResult {
  success: boolean;
  balance: number | null;
  txId: number | null;
  txCreatedAt: Date | null;
}

/** 管理员代充/扣减：UPDATE users.balance += amount + balance_tx(type='adjust') 流水（± 均可）。 */
export async function adjustUserBalance(
  db: Db,
  userId: number,
  amount: number,
  note: string | null,
): Promise<AdjustResult> {
  const updated = await db
    .update(users)
    .set({
      balance: sql`${users.balance} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id, balance: users.balance });
  const row = updated[0];
  if (!row) {
    return { success: false, balance: null, txId: null, txCreatedAt: null };
  }

  const [tx] = await db
    .insert(balanceTx)
    .values({ userId, amount, type: "adjust", note })
    .returning({ id: balanceTx.id, createdAt: balanceTx.createdAt });
  if (!tx) {
    throw new Error("Failed to insert balance transaction");
  }
  return { success: true, balance: row.balance, txId: tx.id, txCreatedAt: tx.createdAt };
}
