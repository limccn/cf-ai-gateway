// 计费核心（M4 4.1-4.3 + 09-01-review D2 债务模型）：价格表查询、费用计算、
// 无条件递减扣费 + balance_tx 流水。
// 债务模型（用户确认）：扣费不再条件 UPDATE——余额允许变为负（= 债务，充值自愈，
// 预检在 balance < 0 时 402 拦截新请求）。扣费与流水在 D1 batch 内原子写入
// （deductBalanceAndLog；消费侧同批还含 usage_daily，见 billing-queue.ts H9/H10）。
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { balanceTx, models, requestLogs, users } from "../db/schema";
import type { TokenUsage } from "../providers/types";

export type RequestLogStatus = "success" | "error" | "cached" | "rejected";

export interface ModelPrice {
  inputPriceShort: number;
  inputPriceLong: number;
  inputPriceCached: number;
  outputPriceShort: number;
  outputPriceLong: number;
}

/** 单价单位：USD / 每百万 tokens（seed.sql 与 models 表一致）。 */
const PRICE_PER_MILLION = 1_000_000;

/**
 * 免费模式（`models.free_mode`）的**有效单价**：USD / 每百万 tokens，与其余价列同单位
 * （09-14-admin-ui-adjustments-2 批次 P，D17）。
 *
 * 取极小值而非 0 的目的**只有一个**：让这行仍走**真实扣费路径**。`calcCost` 得 0 时
 * `billing-queue.ts` 的 `if (cost > 0)` 会跳过「扣费 + balance_tx」那一批（`usage_daily`
 * 仍以零额入账）—— 用极小值就能保留下真实的流水与余额变动。**不是防计价失败**：
 * 0 token 的请求 cost 恰为 0，连极小值也救不了（那是算式的性质，不是缺陷）。
 *
 * 单位写进常量名，避免日后被读成"每次请求 0.00001 美元"。
 */
export const FREE_MODE_PRICE_PER_MILLION = 0.00001;

/** 分层阈值（M9）：未命中缓存的输入 tokens 超过该值时按 long 档（输入+输出），否则 short 档。 */
export const SHORT_CONTEXT_THRESHOLD = 128_000;

/**
 * 费用 = 缓存命中输入 × 缓存价 + 未缓存输入 × (short|long) 输入价 + 输出 × (short|long) 输出价
 * 档位判定只看未缓存输入长度（边界：恰好 = 阈值走 short 档）；缓存命中的部分已按缓存价计，不参与分层。
 */
export function calcCost(usage: TokenUsage, price: ModelPrice): number {
  // cached 封顶 promptTokens：上游口径不保证 cached <= prompt（异常/转换偏差），
  // 超限会按缓存价多收本不存在的输入（LOW finding：billing.ts:30）
  const cached = Math.min(
    Math.max(0, usage.promptTokens),
    Math.max(0, usage.cachedTokens ?? 0),
  );
  const uncachedInput = Math.max(0, usage.promptTokens - cached);
  const longTier = uncachedInput > SHORT_CONTEXT_THRESHOLD;
  const inputPrice = longTier ? price.inputPriceLong : price.inputPriceShort;
  const outputPrice = longTier ? price.outputPriceLong : price.outputPriceShort;
  return (
    cached * price.inputPriceCached +
    uncachedInput * inputPrice +
    usage.completionTokens * outputPrice
  ) / PRICE_PER_MILLION;
}

/**
 * 价格表查询（models 表 = seed 默认 + admin 覆盖的唯一来源；查不到返回 null → 免计）。
 *
 * ⚠ 返回的是**有效计费价**，不是库里的价：`free_mode` 为真的行**五个字段一律**返回
 * `FREE_MODE_PRICE_PER_MILLION`，库里那 5 个价列原样不动（批次 P，D17 —— 只改生效值，
 * 不碰底层数据）。故「库里存的价格」与「实际扣的价」在免费行上**不相等**，读库排查时别混。
 *
 * 返回类型刻意**不带** freeMode 字段：一是调用方（calcCost / 路由）没有任何分支需要它，
 * 加了就是死字段；二是 `tests/billing.test.ts` 用 `toEqual(PRICE)` 精确对照，多一个键即红 ——
 * 那条对照本身就是「非免费行**原样返回**、不掺任何东西」的回归锁。
 */
export async function findModelPrice(db: Db, model: string): Promise<ModelPrice | null> {
  const row = await db.query.models.findFirst({
    where: eq(models.model, model),
    columns: {
      inputPriceShort: true,
      inputPriceLong: true,
      inputPriceCached: true,
      outputPriceShort: true,
      outputPriceLong: true,
      // ⚠ 漏掉这一行 = 「编译过、测试过、什么也没发生」的静默失效：
      //    drizzle 只 select 声明的列，row.freeMode 未声明时**根本不存在于返回对象**
      //    （不是 undefined 的偶然，是构造上取不到），下面的判断会一路 false，
      //    免费模型照原价收钱且不报任何错。改本函数时这一行必须留住。
      freeMode: true,
    },
  });
  if (!row) {
    return null;
  }
  if (row.freeMode) {
    return {
      inputPriceShort: FREE_MODE_PRICE_PER_MILLION,
      inputPriceLong: FREE_MODE_PRICE_PER_MILLION,
      inputPriceCached: FREE_MODE_PRICE_PER_MILLION,
      outputPriceShort: FREE_MODE_PRICE_PER_MILLION,
      outputPriceLong: FREE_MODE_PRICE_PER_MILLION,
    };
  }
  return {
    inputPriceShort: row.inputPriceShort,
    inputPriceLong: row.inputPriceLong,
    inputPriceCached: row.inputPriceCached,
    outputPriceShort: row.outputPriceShort,
    outputPriceLong: row.outputPriceLong,
  };
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
  // OpenAI 形态缓存细分（prompt_tokens_details.cached_tokens）；缺失按 undefined（≈0 计）
  const details = u["prompt_tokens_details"];
  const cachedRaw =
    details && typeof details === "object"
      ? (details as Record<string, unknown>)["cached_tokens"]
      : undefined;
  const cachedTokens =
    typeof cachedRaw === "number" && Number.isFinite(cachedRaw) && cachedRaw > 0
      ? cachedRaw
      : undefined;
  return { promptTokens, completionTokens, cachedTokens };
}

// ============ request_logs 明细 ============

export interface RequestLogRecord {
  /** 幂等键（请求路径统一生成的 UUID；成功路径由计费消费者落行，错误/缓存路径同步落行）。 */
  requestId?: string | null;
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
      requestId: input.requestId ?? null,
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
  /** 是否实际扣费；false 仅表示 cost<=0（债务模型下 cost>0 恒扣，余额可为负） */
  charged: boolean;
  logId: number;
}

/**
 * 无条件扣费 + balance_tx 流水（D2 债务模型）：余额允许变为负（= 债务，充值自愈）。
 * 扣费与流水在同一 D1 batch（事务）内原子写入——扣费成功而流水缺失/重投双写的
 * 窗口被消除（H10）。计费消费者（billing-queue）与 send 降级路径共用本 helper。
 */
export async function deductBalanceAndLog(
  db: Db,
  userId: number,
  cost: number,
  model: string,
  refRequestId: number,
  ts: Date,
): Promise<void> {
  await db.batch([
    db
      .update(users)
      .set({ balance: sql`${users.balance} - ${cost}`, updatedAt: new Date() })
      .where(eq(users.id, userId)),
    db.insert(balanceTx).values({
      userId,
      amount: -cost,
      type: "usage",
      note: `usage: ${model}`,
      refRequestId,
      createdAt: ts,
    }),
  ]);
}

/**
 * 成功请求结算（同步路径兼容入口）：写明细 → 债务化扣费 + 流水。
 * - cost <= 0（无 usage / 无价格）→ 仅记明细不扣费。
 * - 债务模型：cost > 0 恒扣费（余额可为负）；用户不存在由 balance_tx 外键约束暴露（batch 抛错）。
 */
export async function chargeUsage(db: Db, input: ChargeUsageInput): Promise<ChargeResult> {
  const logId = await recordRequestLog(db, input);

  if (input.cost <= 0) {
    return { charged: false, logId };
  }

  await deductBalanceAndLog(db, input.userId, input.cost, input.model, logId, new Date());
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
