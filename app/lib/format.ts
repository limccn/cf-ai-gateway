// 展示格式化工具（纯函数，便于单测；spec quality.md：工具函数测试用 Vitest）。

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatUsd(value: number): string {
  return usdFormatter.format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateOnly(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** YYYY-MM-DD（UTC），用于报表 API from/to 参数。 */
export function toDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → MM-DD（图表轴标签；原始串不变则原样返回）。 */
export function formatShortDate(iso: string): string {
  const match = /^\d{4}-(\d{2}-\d{2})$/.exec(iso);
  return match?.[1] ?? iso;
}

/** 当前日期前推 days 天的 YYYY-MM-DD（UTC）。 */
export function daysAgoParam(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return toDateParam(date);
}
