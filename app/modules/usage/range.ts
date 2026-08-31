// 快捷维度图表的桶生成（08-31-usage-stats-dimensions，替代 hourly.ts）：
// 后端 range 聚合只返回有数据的桶（小时键 "YYYY-MM-DDTHH:00:00Z" / 天键 "YYYY-MM-DD"，
// 值均为本地时间，Z 仅为格式标记），前端按与后端同口径的窗口公式补出固定 24/24/14/30 桶
// （缺数据补 0），label 直接取键的本地部分（键本身已是偏移后本地时间）。
import type { UsageAggregate, UsageRange } from "./types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 浏览器时区偏移分钟（UTC+8 → +480；模块加载时快照一次，与后端 tzOffsetMin 同口径）。 */
export function getTzOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

/** 本地日 0:00 的 UTC 时刻（与后端 resolveRangeWindow 同公式）。 */
function localTodayStartUtc(nowMs: number, tzOffsetMin: number): number {
  const offsetMs = tzOffsetMin * 60_000;
  return Math.floor((nowMs + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
}

interface RangeShape {
  startOffsetDays: number;
  count: number;
  granularity: "hour" | "day";
}

const RANGE_SHAPES: Record<UsageRange, RangeShape> = {
  today: { startOffsetDays: 0, count: 24, granularity: "hour" },
  yesterday: { startOffsetDays: -1, count: 24, granularity: "hour" },
  last14: { startOffsetDays: -13, count: 14, granularity: "day" },
  last30: { startOffsetDays: -29, count: 30, granularity: "day" },
};

const pad = (n: number) => String(n).padStart(2, "0");

/** 窗口内第 i 个桶的键（本地时间以 UTC 字段表示，与后端 strftime 偏移输出一致）。
 * 桶起点已是本地对齐的 UTC 时刻，取字段前需再加偏移：否则 +8 时区下 day 桶会落到前一天、
 * hour 桶会偏移 -8 小时。 */
function bucketKey(
  startMs: number,
  i: number,
  granularity: "hour" | "day",
  tzOffsetMin: number,
): string {
  const ms = startMs + i * (granularity === "hour" ? HOUR_MS : DAY_MS) + tzOffsetMin * 60_000;
  if (granularity === "hour") {
    return `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;
  }
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 桶 label：hour → "HH:00"（本地时）；day → "MM-DD"（跨月自动正确）。 */
function bucketLabel(key: string, granularity: "hour" | "day"): string {
  if (granularity === "hour") {
    return `${key.slice(11, 13)}:00`;
  }
  return `${key.slice(5, 7)}-${key.slice(8, 10)}`;
}

/** 快捷维度按钮定义（dashboard 与 usage 页共用；usage 页另加 Custom 选项）。 */
export const RANGE_OPTIONS: Array<{ value: UsageRange; label: string; title: string; desc: string }> = [
  { value: "today", label: "Today", title: "Requests today", desc: "Hourly request count (local timezone)" },
  { value: "yesterday", label: "Yesterday", title: "Requests yesterday", desc: "Hourly request count (local timezone)" },
  { value: "last14", label: "Last 14 days", title: "Requests per day", desc: "Daily request count over the last 14 days" },
  { value: "last30", label: "Last 30 days", title: "Requests per day", desc: "Daily request count over the last 30 days" },
];

/**
 * 快捷维度系列：固定桶数（24/24/14/30），缺数据补 0。
 * 时间参数快照（nowMs/tzOffsetMin）需与发起查询时一致，保证桶边界与后端窗口重合。
 */
export function buildRangeSeries(
  aggregates: UsageAggregate[],
  range: UsageRange,
  tzOffsetMin: number,
  nowMs = Date.now(),
): { label: string; value: number }[] {
  const shape = RANGE_SHAPES[range];
  const startMs = localTodayStartUtc(nowMs, tzOffsetMin) + shape.startOffsetDays * DAY_MS;
  const byKey = new Map<string, number>();
  for (const agg of aggregates) {
    if (agg.group !== null) {
      byKey.set(agg.group, agg.requests);
    }
  }
  return Array.from({ length: shape.count }, (_, i) => {
    const key = bucketKey(startMs, i, shape.granularity, tzOffsetMin);
    return { label: bucketLabel(key, shape.granularity), value: byKey.get(key) ?? 0 };
  });
}
