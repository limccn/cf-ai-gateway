// format.ts 展示格式化工具函数单测（纯函数，不依赖环境）。
// 断言用本地时间构造输入（new Date(y,m-1,...) → toISOString），时区无关：格式化为本地时区时不变。
import { describe, expect, it } from "vitest";
import { formatDateTimeShort } from "../app/lib/format";

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
