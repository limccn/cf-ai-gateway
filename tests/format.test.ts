// format.ts 展示格式化工具函数单测（纯函数，不依赖环境）。
// 断言用本地时间构造输入（new Date(y,m-1,...) → toISOString），时区无关：格式化为本地时区时不变。
import { describe, expect, it } from "vitest";
import {
  formatDateTimeShort,
  formatNumberCompact,
  formatUsd,
  formatUsdShort,
} from "../app/lib/format";

/** 本地时间 (y, m, d, h, min) 的 ISO 串：任一时区下格式化回本地时区结果一致。 */
const local = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe("formatDateTimeShort", () => {
  it("renders month/day and time without year", () => {
    expect(formatDateTimeShort(local(2026, 8, 28, 13, 10))).toBe("Aug 28, 01:10 PM");
  });

  it("handles midnight and morning hours", () => {
    expect(formatDateTimeShort(local(2026, 1, 2, 0, 5))).toBe("Jan 2, 12:05 AM");
    expect(formatDateTimeShort(local(2026, 1, 2, 9, 45))).toBe("Jan 2, 09:45 AM");
  });

  it("returns the input unchanged for invalid dates", () => {
    expect(formatDateTimeShort("not-a-date")).toBe("not-a-date");
  });
});

// 09-14 批次 B / D8：图表标签用的收窄格式。与 formatUsd 分开是刻意的 ——
// 全局收窄会让 models 页的缓存单价（$0.000150）静默丢精度。
describe("formatUsdShort", () => {
  it("caps at 3 fraction digits, floors at 2", () => {
    expect(formatUsdShort(0.05)).toBe("$0.05");
    expect(formatUsdShort(12.5)).toBe("$12.50");
    expect(formatUsdShort(0.0512)).toBe("$0.051");
  });

  it("rounds (not truncates) at the 3rd decimal", () => {
    expect(formatUsdShort(0.05167)).toBe("$0.052");
  });

  it("sub-cent values collapse to the 2-digit floor — the accepted cost of D8", () => {
    // 实测：Intl 四舍五入后去掉尾随零，故 0.0001 → "$0.00"（不是 "$0.000"）——
    // 落到 minimumFractionDigits 下限，比补零的 "$0.000" 更清楚地表达「接近于零」。
    expect(formatUsdShort(0.0001)).toBe("$0.00");
    expect(formatUsdShort(0)).toBe("$0.00");
  });

  it("formatUsd is untouched: 6-digit precision survives for other pages", () => {
    // AC16 后半的锁：本批次只新增函数，既不收窄也不改写既有导出
    expect(formatUsd(0.00015)).toBe("$0.00015");
    expect(formatUsd(0.05)).toBe("$0.05");
  });
});

describe("formatNumberCompact", () => {
  it("compacts thousands and millions for bar-top labels", () => {
    expect(formatNumberCompact(999)).toBe("999");
    expect(formatNumberCompact(1234)).toBe("1.2K");
    expect(formatNumberCompact(12345)).toBe("12.3K");
    expect(formatNumberCompact(1234567)).toBe("1.2M");
  });

  it("handles zero and small values unchanged", () => {
    expect(formatNumberCompact(0)).toBe("0");
    expect(formatNumberCompact(42)).toBe("42");
  });
});
