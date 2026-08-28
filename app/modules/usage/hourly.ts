// 24h 逐小时图表的桶生成：后端 hour 聚合只返回有数据的小时（UTC 小时键
// "YYYY-MM-DDTHH:00:00Z"），前端补出连续 24 个桶（缺数据补 0），label 转本地时区。
import type { UsageAggregate } from "./types";

/** 最近 24 个整点（UTC 对齐），每个生成 { label: 本地小时, value: requests }。 */
export function buildHourlySeries(
  aggregates: UsageAggregate[],
): { label: string; value: number }[] {
  const byHour = new Map<string, number>();
  for (const agg of aggregates) {
    if (agg.group !== null) {
      byHour.set(agg.group, agg.requests);
    }
  }

  const now = new Date();
  const currentHourStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
  );

  const buckets: { label: string; value: number }[] = [];
  for (let i = 23; i >= 0; i--) {
    const ms = currentHourStart - i * 3600_000;
    const key = `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;
    buckets.push({
      label: new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      value: byHour.get(key) ?? 0,
    });
  }
  return buckets;
}
