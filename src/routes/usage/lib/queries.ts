// /api/me/usage 与 /api/admin/usage 共享的查询构造与响应组装（api-module spec：逻辑提取到 lib，避免重复）。
import { and, asc, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db";
import { requestLogs, usageDaily } from "../../../db/schema";
import type { RequestLogStatus } from "../../../lib/billing";
import type { UsageGroupBy, UsageOutput, UsageRange } from "../types";

export interface UsageFilters {
  userId?: number;
  keyId?: number;
  model?: string;
  status?: RequestLogStatus; // 仅作用于 request_logs 查询（明细 + status/hour 聚合）；usage_daily 无 status 列
  from?: string; // YYYY-MM-DD（含）
  to?: string; // YYYY-MM-DD（含）
  range?: UsageRange; // 预设快捷窗口（08-31-usage-stats-dimensions），优先于 from/to
  tzOffsetMin?: number; // 客户端时区偏移分钟（缺省 0 = UTC），作用于窗口边界与分桶
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

// ============ 快捷窗口（08-31-usage-stats-dimensions） ============

/** N 个本地日前（今天=0）的本地日 0:00 的 UTC 时刻（tzOffsetMin = 客户端时区偏移分钟，UTC+8 → 480）。
 * 本地日减法而非固定 24h 倍数：DST 切换日（23/25 小时）下仍对齐本地日界；
 * 与前端 app/modules/usage/range.ts 的 dayStartUtcDaysAgo 同公式（跨端窗口必须重合）。 */
function dayStartUtcDaysAgo(nowMs: number, tzOffsetMin: number, daysAgo: number): number {
  const offsetMs = tzOffsetMin * 60_000;
  const local = new Date(nowMs + offsetMs);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo) - offsetMs
  );
}

export interface RangeWindow {
  start: Date;
  end: Date;
  granularity: "hour" | "day";
}

/**
 * 预设窗口解析（design §3，含今日）：本地日界按 tzOffsetMin 计算。
 * - today      [todayStart, todayStart+24h)        小时 24 桶
 * - yesterday  [todayStart-24h, todayStart)        小时 24 桶
 * - last14     [todayStart-13d, todayStart+24h)    天 14 桶
 * - last30     [todayStart-29d, todayStart+24h)    天 30 桶
 * last14/last30 终点为明日日界（含今日整天），与「含今日」口径一致。
 */
export function resolveRangeWindow(
  range: UsageRange,
  tzOffsetMin: number,
  nowMs = Date.now(),
): RangeWindow {
  const todayStart = dayStartUtcDaysAgo(nowMs, tzOffsetMin, 0);
  const tomorrowStart = dayStartUtcDaysAgo(nowMs, tzOffsetMin, -1);
  switch (range) {
    case "today":
      return { start: new Date(todayStart), end: new Date(tomorrowStart), granularity: "hour" };
    case "yesterday":
      return {
        start: new Date(dayStartUtcDaysAgo(nowMs, tzOffsetMin, 1)),
        end: new Date(todayStart),
        granularity: "hour",
      };
    case "last14":
      return {
        start: new Date(dayStartUtcDaysAgo(nowMs, tzOffsetMin, 13)),
        end: new Date(tomorrowStart),
        granularity: "day",
      };
    case "last30":
      return {
        start: new Date(dayStartUtcDaysAgo(nowMs, tzOffsetMin, 29)),
        end: new Date(tomorrowStart),
        granularity: "day",
      };
  }
}

/** SQLite strftime modifier："+480 minutes" / "-120 minutes"（zod int 校验后拼接，无注入面）。 */
export function tzOffsetModifier(tzOffsetMin: number): string {
  return `${tzOffsetMin >= 0 ? "+" : ""}${tzOffsetMin} minutes`;
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
  // range 快捷窗口优先（08-31-usage-stats-dimensions）：从 request_logs 按本地时区窗口实时聚合
  if (filters.range !== undefined) {
    const { start, end, granularity } = resolveRangeWindow(
      filters.range,
      filters.tzOffsetMin ?? 0,
    );
    const modifier = tzOffsetModifier(filters.tzOffsetMin ?? 0);
    // createdAt 为秒（drizzle timestamp mode），直接作 unixepoch 时间戳；
    // 分桶键 = 偏移后本地时间（小时 "YYYY-MM-DDTHH:00:00Z" / 天 "YYYY-MM-DD"，Z 仅为格式标记）
    const bucketExpr =
      granularity === "hour"
        ? sql<string>`strftime('%Y-%m-%dT%H:00:00Z', ${requestLogs.createdAt}, 'unixepoch', ${modifier})`
        : sql<string>`strftime('%Y-%m-%d', ${requestLogs.createdAt}, 'unixepoch', ${modifier})`;
    const rows = await db
      .select({
        group: bucketExpr,
        requests: sql<number>`count(*)`,
        tokensIn: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)`,
        tokensOut: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)`,
        cost: sql<number>`coalesce(sum(${requestLogs.cost}), 0)`,
      })
      .from(requestLogs)
      .where(and(requestLogsWhere(filters), gte(requestLogs.createdAt, start), lt(requestLogs.createdAt, end)))
      .groupBy(bucketExpr)
      .orderBy(asc(bucketExpr));
    return rows;
  }

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
  // range 快捷窗口优先（与聚合同窗口）；requestLogsWhere 不含 range 分支，需显式叠加窗口条件
  let where = requestLogsWhere(filters);
  if (filters.range !== undefined) {
    const { start, end } = resolveRangeWindow(filters.range, filters.tzOffsetMin ?? 0);
    const window = and(gte(requestLogs.createdAt, start), lt(requestLogs.createdAt, end));
    where = where === undefined ? window : and(where, window);
  }
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
