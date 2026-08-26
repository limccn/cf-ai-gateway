// /api/me/transactions 与 /api/admin/transactions 共享的查询构造与响应组装
// （api-module spec：逻辑提取到 lib，避免重复；me/admin 共用同一 procedure 逻辑）。
import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db";
import { balanceTx } from "../../../db/schema";
import type {
  BalanceTxType,
  TransactionItem,
  TransactionsOutput,
} from "../types";

export interface TransactionsFilters {
  userId?: number;
  type?: BalanceTxType;
  from?: string; // YYYY-MM-DD（含）
  to?: string; // YYYY-MM-DD（含）
}

/** balance_tx 查询条件：from/to 按 UTC 日界转换（[from 00:00:00Z, to+1d 00:00:00Z)，含 to 当天）。 */
export function transactionsWhere(filters: TransactionsFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.userId !== undefined) {
    conditions.push(eq(balanceTx.userId, filters.userId));
  }
  if (filters.type !== undefined) {
    conditions.push(eq(balanceTx.type, filters.type));
  }
  if (filters.from !== undefined) {
    conditions.push(
      gte(balanceTx.createdAt, new Date(`${filters.from}T00:00:00Z`)),
    );
  }
  if (filters.to !== undefined) {
    const end = new Date(`${filters.to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1); // 含 to 当天
    conditions.push(lt(balanceTx.createdAt, end));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

interface BalanceTxRow {
  id: number;
  type: string;
  amount: number;
  note: string | null;
  refRequestId: number | null;
  createdAt: Date;
}

export interface TransactionsPage {
  items: TransactionItem[];
  total: number;
}

/** 流水分页（id 倒序 = 最新在前；limit/offset 与 total 供前端分页）。 */
export async function fetchTransactions(
  db: Db,
  filters: TransactionsFilters,
  limit: number,
  offset: number,
): Promise<TransactionsPage> {
  const where = transactionsWhere(filters);
  const rows = await db
    .select({
      id: balanceTx.id,
      type: balanceTx.type,
      amount: balanceTx.amount,
      note: balanceTx.note,
      refRequestId: balanceTx.refRequestId,
      createdAt: balanceTx.createdAt,
    })
    .from(balanceTx)
    .where(where)
    .orderBy(desc(balanceTx.id))
    .limit(limit)
    .offset(offset);
  const totalRow = await db
    .select({ value: count() })
    .from(balanceTx)
    .where(where);
  const total = totalRow[0]?.value ?? 0;
  return { items: rows.map(toTransactionItem), total };
}

/** DB 行 → API item（type 窄化断言集中在此转换函数，type-safety spec）。 */
export function toTransactionItem(row: BalanceTxRow): TransactionItem {
  return {
    id: row.id,
    type: row.type as BalanceTxType,
    amount: row.amount,
    note: row.note,
    refRequestId: row.refRequestId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 组装统一响应体（me/admin 共用，保证响应格式稳定，M8 前端消费）。 */
export function toTransactionsOutput(
  page: TransactionsPage,
  limit: number,
  offset: number,
): TransactionsOutput {
  return {
    success: true,
    items: page.items,
    total: page.total,
    limit,
    offset,
  };
}
