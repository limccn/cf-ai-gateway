// 快捷维度图表的桶生成（08-31-usage-stats-dimensions，替代 hourly.ts）：
// 后端 range 聚合只返回有数据的桶（小时键 "YYYY-MM-DDTHH:00:00Z" / 天键 "YYYY-MM-DD"，
// 值均为本地时间，Z 仅为格式标记），前端按与后端同口径的窗口公式补出固定 24/24/14/30 桶
// （缺数据补 0），label 直接取键的本地部分（键本身已是偏移后本地时间）。
import type { UsageAggregate, UsageRange } from "./types";

const HOUR_MS = 3_600_000;

/** 浏览器时区偏移分钟（UTC+8 → +480；模块加载时快照一次，与后端 tzOffsetMin 同口径）。 */
export function getTzOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

interface RangeShape {
  /** 窗口起点距今天的天数（today=0 / yesterday=1 / last14=13 / last30=29）。 */
  daysAgo: number;
  count: number;
  granularity: "hour" | "day";
}

const RANGE_SHAPES: Record<UsageRange, RangeShape> = {
  today: { daysAgo: 0, count: 24, granularity: "hour" },
  yesterday: { daysAgo: 1, count: 24, granularity: "hour" },
  last14: { daysAgo: 13, count: 14, granularity: "day" },
  last30: { daysAgo: 29, count: 30, granularity: "day" },
};

/** 窗口的桶粒度：today/yesterday 逐小时，last14/last30 逐日。
 *  导出给调用方**措辞**用 —— 例如「N 个活跃小时」与「N 个活跃天」不能混用
 *  （dashboard 原先把 hour 桶也写成 "active days"，是句假话）。 */
export function rangeGranularity(range: UsageRange): "hour" | "day" {
  return RANGE_SHAPES[range].granularity;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** N 个本地日前（今天=0）的本地日 0:00 的 UTC 时刻。
 * 本地日减法而非固定 24h 倍数：DST 切换日（23/25 小时）下仍对齐本地日界，
 * 与后端 resolveRangeWindow 同公式（跨端窗口必须重合）。 */
function dayStartUtcDaysAgo(nowMs: number, tzOffsetMin: number, daysAgo: number): number {
  const offsetMs = tzOffsetMin * 60_000;
  const local = new Date(nowMs + offsetMs);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo) - offsetMs
  );
}

/** 本地日（startMs 所在日）+ i 天后的本地日 0:00 的 UTC 时刻（day 桶推进，DST 鲁棒）。 */
function dayStartUtcPlusDays(startMs: number, tzOffsetMin: number, i: number): number {
  const offsetMs = tzOffsetMin * 60_000;
  const local = new Date(startMs + offsetMs);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i) - offsetMs
  );
}

/** 窗口内第 i 个桶的键（本地时间以 UTC 字段表示，与后端 strftime 偏移输出一致）。
 * hour 桶：本地对齐的 UTC 时刻 + 固定 1h 步进（DST 切换日的 23/25h 边界偏 1h，接受）；
 * day 桶：本地日 + i 天（DST 鲁棒，与后端同公式）。 */
function bucketKey(
  startMs: number,
  i: number,
  granularity: "hour" | "day",
  tzOffsetMin: number,
): string {
  if (granularity === "hour") {
    const ms = startMs + i * HOUR_MS + tzOffsetMin * 60_000;
    return `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;
  }
  const d = new Date(dayStartUtcPlusDays(startMs, tzOffsetMin, i));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 桶 label：hour → "HH:00"（本地时）；day → "MM-DD"（跨月自动正确）。 */
function bucketLabel(key: string, granularity: "hour" | "day"): string {
  if (granularity === "hour") {
    return `${key.slice(11, 13)}:00`;
  }
  return `${key.slice(5, 7)}-${key.slice(8, 10)}`;
}

/** 快捷窗口定义（dashboard 与 usage 页共用；usage 页另加 Custom 选项）。
 * usage 页有三张柱状图（请求 / 消费 / tokens），故每个窗口各配一组标题说明：
 * `title`/`desc` 给请求卡，`costTitle`/`costDesc` 给消费卡（09-14 批次 A），
 * `tokensTitle`/`tokensDesc` 给 tokens 卡（09-14 批次 B）—— 都是新增字段，不动既有字段。
 *
 * **用词（批次 J，2026-09-18 用户裁决）**：用户可见文案统一用 **spend**，不再用 cost
 * （原文「全局统一 spend 和 cost 的词语表述，优先使用 spend」）。`costTitle` / `costDesc`
 * 这类**字段名**刻意保留：裁决同时限定「只改用户可见文案，不要动后台和表」，
 * 改字段名属纯 churn，且会与后端 `cost` 字段名分叉。 */
export const RANGE_OPTIONS: Array<{
  value: UsageRange;
  label: string;
  title: string;
  desc: string;
  costTitle: string;
  costDesc: string;
  tokensTitle: string;
  tokensDesc: string;
}> = [
  {
    value: "today",
    label: "Today",
    title: "Requests today",
    desc: "Hourly request count (local timezone)",
    costTitle: "Spend today",
    costDesc: "Hourly spend (local timezone)",
    tokensTitle: "Tokens today",
    tokensDesc: "Hourly token usage, input + output (local timezone)",
  },
  {
    value: "yesterday",
    label: "Yesterday",
    title: "Requests yesterday",
    desc: "Hourly request count (local timezone)",
    costTitle: "Spend yesterday",
    costDesc: "Hourly spend (local timezone)",
    tokensTitle: "Tokens yesterday",
    tokensDesc: "Hourly token usage, input + output (local timezone)",
  },
  {
    value: "last14",
    label: "Last 14 days",
    title: "Requests per day",
    desc: "Daily request count over the last 14 days",
    costTitle: "Spend per day",
    costDesc: "Daily spend over the last 14 days",
    tokensTitle: "Tokens per day",
    tokensDesc: "Daily token usage, input + output over the last 14 days",
  },
  {
    value: "last30",
    label: "Last 30 days",
    title: "Requests per day",
    desc: "Daily request count over the last 30 days",
    costTitle: "Spend per day",
    costDesc: "Daily spend over the last 30 days",
    tokensTitle: "Tokens per day",
    tokensDesc: "Daily token usage, input + output over the last 30 days",
  },
];

/** 柱状图取值维度：同一套桶窗口，三张柱子图各取一列（请求数 / 成本 / tokens）。 */
export type SeriesMetric = "requests" | "cost" | "tokens";

/** 按 metric 从聚合行取对应列。tokens 取「输入 + 输出」，与 tokens 环形图两段之和同口径。 */
function metricValue(agg: UsageAggregate, metric: SeriesMetric): number {
  if (metric === "cost") {
    return agg.cost;
  }
  if (metric === "tokens") {
    return agg.tokensIn + agg.tokensOut;
  }
  return agg.requests;
}

/**
 * 快捷维度系列：固定桶数（24/24/14/30），缺数据补 0。
 * metric 决定取桶里的哪一列：请求柱状图取 `requests`，成本柱状图取 `cost`（09-14 批次 A），
 * tokens 柱状图取 `tokensIn + tokensOut`（09-14 批次 B）—— 共用同一条窗口公式是刻意的，
 * 三图的桶边界必须逐桶对齐。
 * nowMs 必传：必须与发起查询时同源快照（组件 state），否则页面跨本地午夜后
 * useMemo 重算会取新 Date.now() → 桶窗口整体偏移一天，与后端窗口错位。
 * 调用方（usage.tsx updateFilters）在每次筛选变更时刷新快照。
 */
export function buildRangeSeries(
  aggregates: UsageAggregate[],
  range: UsageRange,
  tzOffsetMin: number,
  nowMs: number,
  metric: SeriesMetric = "requests",
): { label: string; value: number }[] {
  const shape = RANGE_SHAPES[range];
  const startMs = dayStartUtcDaysAgo(nowMs, tzOffsetMin, shape.daysAgo);
  const byKey = new Map<string, number>();
  for (const agg of aggregates) {
    if (agg.group !== null) {
      byKey.set(agg.group, metricValue(agg, metric));
    }
  }
  return Array.from({ length: shape.count }, (_, i) => {
    const key = bucketKey(startMs, i, shape.granularity, tzOffsetMin);
    return { label: bucketLabel(key, shape.granularity), value: byKey.get(key) ?? 0 };
  });
}
