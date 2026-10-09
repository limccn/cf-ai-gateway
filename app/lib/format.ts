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

const usdShortFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

/**
 * 图表标签用的美元格式：小数位收窄到 3（09-14 批次 B / D8）。
 *
 * 为什么不直接改 `formatUsd`：它被 7 个页面共用（users / dashboard / models / usage 明细 /
 * billing / settings / welcome-dialog），其中 `models.tsx` 的缓存单价（如 `$0.000150`）
 * 确实需要 6 位 —— 改全局会**静默丢精度**。故收窄只发生在图表调用处。
 * 已知代价：4 位以上小数的单桶值会被截断（`$0.0001` → `$0.000`），桶是聚合量级，罕见。
 */
export function formatUsdShort(value: number): string {
  return usdShortFormatter.format(value);
}

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * 大数紧凑格式（`1234567` → `1.2M`，`12345` → `12.3K`，`999` → `999`）。
 *
 * 用于柱顶数值标签：token 数是百万量级，完整写法（`1,234,567` ≈ 54px）在 24/30 桶的
 * 30~37px 槽位下**必然重叠**。环形图图例空间充裕，仍用精确的 `formatNumber`。
 */
export function formatNumberCompact(value: number): string {
  return compactFormatter.format(value);
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

/** 紧凑时间格式（移动端表格列用）：Aug 28, 1:10 PM（去年份，保留月/日/时分）。 */
export function formatDateTimeShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("en-US", {
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
