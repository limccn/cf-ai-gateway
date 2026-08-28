// /api/me/usage 与 /api/admin/usage 共享的查询构造与响应组装（api-module spec：逻辑提取到 lib，避免重复）。
import { and, asc, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db";
import { requestLogs, usageDaily } from "../../../db/schema";
import type { RequestLogStatus } from "../../../lib/billing";
import type { UsageGroupBy, UsageOutput } from "../types";

export interface UsageFilters {
  userId?: number;
  keyId?: number;
  model?: string;
  status?: RequestLogStatus; // 仅作用于 request_logs 查询（明细 + status/hour 聚合）；usage_daily 无 status 列
  from?: string; // YYYY-MM-DD（含）
  to?: string; // YYYY-MM-DD（含）
}

/** usage_daily 聚合条件：date 列直接按文本范围比较（YYYY-MM-DD 字典序 = 时间序）。 */
export function usageDailyWhere(filters: UsageFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.userId !== undefined) {
    conditions.push(eq(usageDaily.userId, filters.userId));
  }
  if (filters.keyId !== undefined) {
    conditions.push(eq(usageDaily.keyId, filters.keyId));
  }
  if (filters.model !== undefined) {
    conditions.push(eq(usageDaily.model, filters.model));
  }
  if (filters.from !== undefined) {
    conditions.push(gte(usageDaily.date, filters.from));
  }
  if (filters.to !== undefined) {
    conditions.push(lte(usageDaily.date, filters.to));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** request_logs 明细条件：from/to 按 UTC 日界转换（[from 00:00:00Z, to+1d 00:00:00Z)，含 to 当天）。 */
export function requestLogsWhere(filters: UsageFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.userId !== undefined) {
    conditions.push(eq(requestLogs.userId, filters.userId));
  }
  if (filters.keyId !== undefined) {
    conditions.push(eq(requestLogs.keyId, filters.keyId));
  }
  if (filters.model !== undefined) {
    conditions.push(eq(requestLogs.model, filters.model));
  }
  if (filters.status !== undefined) {
    conditions.push(eq(requestLogs.status, filters.status));
  }
  if (filters.from !== undefined) {
    conditions.push(
      gte(requestLogs.createdAt, new Date(`${filters.from}T00:00:00Z`)),
    );
  }
  if (filters.to !== undefined) {
    const end = new Date(`${filters.to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1); // 含 to 当天
    conditions.push(lt(requestLogs.createdAt, end));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

// ============ 聚合查询 ============

export interface UsageAggregateRow {
  group: string | null;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/** 聚合列（sum 空集 coalesce 0；无分组时 group 为 null 的总览行）。 */
const AGG_COLUMNS = {
  requests: sql<number>`coalesce(sum(${usageDaily.requests}), 0)`,
  tokensIn: sql<number>`coalesce(sum(${usageDaily.tokensIn}), 0)`,
  tokensOut: sql<number>`coalesce(sum(${usageDaily.tokensOut}), 0)`,
  cost: sql<number>`coalesce(sum(${usageDaily.cost}), 0)`,
};

export async function fetchUsageAggregates(
  db: Db,
  filters: UsageFilters,
  groupBy: UsageGroupBy | undefined,
): Promise<UsageAggregateRow[]> {
  const where = usageDailyWhere(filters);

  if (groupBy === "date") {
    const rows = await db
      .select({ group: usageDaily.date, ...AGG_COLUMNS })
      .from(usageDaily)
      .where(where)
      .groupBy(usageDaily.date)
      .orderBy(asc(usageDaily.date));
    return rows;
  }

  if (groupBy === "model") {
    const rows = await db
      .select({ group: usageDaily.model, ...AGG_COLUMNS })
      .from(usageDaily)
      .where(where)
      .groupBy(usageDaily.model)
      .orderBy(asc(usageDaily.model));
    return rows;
  }

  // 状态占比聚合：usage_daily 无 status 列，从 request_logs 按状态分桶（respect from/to）。
  // group 键 = status 枚举（success/error/cached/rejected）；前端补缺状态为 0。
  if (groupBy === "status") {
    const rows = await db
      .select({
        group: requestLogs.status,
        requests: sql<number>`count(*)`,
        tokensIn: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)`,
        tokensOut: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)`,
        cost: sql<number>`coalesce(sum(${requestLogs.cost}), 0)`,
      })
      .from(requestLogs)
      .where(requestLogsWhere(filters))
      .groupBy(requestLogs.status)
      .orderBy(asc(requestLogs.status));
    return rows;
  }

  // 最近 24 小时逐小时聚合：从 request_logs 按 UTC 小时分桶（usage_daily 无小时粒度）。
  // group 键格式 "YYYY-MM-DDTHH:00:00Z"（与 usage_daily.date 同口径的 UTC 日界）；前端补缺小时为 0。
  if (groupBy === "hour") {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    // createdAt 为秒（drizzle timestamp mode），直接作 unixepoch 时间戳
    const hourExpr = sql<string>`strftime('%Y-%m-%dT%H:00:00Z', ${requestLogs.createdAt}, 'unixepoch')`;
    const rows = await db
      .select({
        group: hourExpr,
        requests: sql<number>`count(*)`,
        tokensIn: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)`,
        tokensOut: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)`,
        cost: sql<number>`coalesce(sum(${requestLogs.cost}), 0)`,
      })
      .from(requestLogs)
      .where(and(requestLogsWhere(filters), gte(requestLogs.createdAt, since)))
      .groupBy(hourExpr)
      .orderBy(asc(hourExpr));
    return rows;
  }

  const rows = await db
    .select({ group: sql<string | null>`null`, ...AGG_COLUMNS })
    .from(usageDaily)
    .where(where);
  return rows;
}

// ============ 明细查询 ============

export interface UsageDetailRow {
  id: number;
  keyId: number | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  latencyMs: number | null;
  upstreamLatencyMs: number | null;
  status: string;
  createdAt: Date;
}

export interface UsageDetailsPage {
  items: UsageDetailRow[];
  total: number;
}

/** 明细分页（id 倒序 = 最新在前；limit/offset 与 total 供前端分页）。 */
export async function fetchUsageDetails(
  db: Db,
  filters: UsageFilters,
  limit: number,
  offset: number,
): Promise<UsageDetailsPage> {
  const where = requestLogsWhere(filters);
  const rows = await db
    .select({
      id: requestLogs.id,
      keyId: requestLogs.keyId,
      model: requestLogs.model,
      promptTokens: requestLogs.promptTokens,
      completionTokens: requestLogs.completionTokens,
      cost: requestLogs.cost,
      latencyMs: requestLogs.latencyMs,
      upstreamLatencyMs: requestLogs.upstreamLatencyMs,
      status: requestLogs.status,
      createdAt: requestLogs.createdAt,
    })
    .from(requestLogs)
    .where(where)
    .orderBy(desc(requestLogs.id))
    .limit(limit)
    .offset(offset);
  const totalRow = await db
    .select({ value: count() })
    .from(requestLogs)
    .where(where);
  const total = totalRow[0]?.value ?? 0;
  return { items: rows, total };
}

// ============ 响应组装 ============

/** 聚合 + 明细 → 统一响应体（me/admin 共用，保证响应格式稳定，M6 前端消费）。 */
export function toUsageOutput(
  aggregates: UsageAggregateRow[],
  page: UsageDetailsPage,
  limit: number,
  offset: number,
): UsageOutput {
  return {
    success: true,
    aggregates: aggregates.map((row) => ({
      group: row.group,
      requests: row.requests,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      cost: row.cost,
    })),
    details: page.items.map((row) => ({
      id: row.id,
      keyId: row.keyId,
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cost: row.cost,
      latencyMs: row.latencyMs,
      upstreamLatencyMs: row.upstreamLatencyMs,
      status: row.status as RequestLogStatus,
      createdAt: row.createdAt.toISOString(),
    })),
    total: page.total,
    limit,
    offset,
  };
}
