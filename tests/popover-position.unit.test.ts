// Popover 面板锚定算术单元测试（09-14 批次 A）。
// 纯函数、无 DOM —— 面板 portal 到 body 后坐标必须自算（同 tests/menu-position.unit.test.ts）。
//
// 面板尺寸取 Usage 页的真实常量（usage.tsx 的 RANGE_POPOVER_PANEL）：宽 288px（w-72）、
// 高 158px（1440×900 实测值，与页面常量逐个相同 —— 三个数值里高度决定「翻转」与 maxHeight 的
// 边界覆盖率，脱钩了测试就锁不到真实边界）。这些数值只影响「翻转判据与 maxHeight」，
// 真实高度由 CSS 决定 —— 测试锁定的是**算术**，不是渲染结果。
import { describe, expect, it } from "vitest";
import {
  POPOVER_GAP,
  POPOVER_MARGIN,
  computePopoverPosition,
  type PopoverPosition,
} from "../app/components/ui/popover-position";

const PANEL = { width: 288, height: 158 };

/** 显式收窄而非 non-null assertion（quality.md Forbidden Pattern #6）。 */
function topOf(pos: PopoverPosition): number {
  if (pos.top === undefined) {
    throw new Error(`expected top 锚定，实际：${JSON.stringify(pos)}`);
  }
  return pos.top;
}

function bottomOf(pos: PopoverPosition): number {
  if (pos.bottom === undefined) {
    throw new Error(`expected bottom 锚定，实际：${JSON.stringify(pos)}`);
  }
  return pos.bottom;
}

describe("computePopoverPosition — 正常向下", () => {
  it("空间充足：top = 触发器下边缘 + gap，左边缘对齐触发器", () => {
    const pos = computePopoverPosition(
      { top: 120, bottom: 156, left: 300 },
      { width: 1440, height: 900 },
      PANEL,
    );
    expect(topOf(pos)).toBe(156 + POPOVER_GAP);
    expect(pos.left).toBe(300);
    expect(pos.bottom).toBeUndefined(); // top 与 bottom 互斥
    expect(pos.maxHeight).toBe(PANEL.height); // 放得下 → 不夹取
  });

  it("GAP/MARGIN 与设计一致（间距语义不许悄悄变）", () => {
    expect(POPOVER_GAP).toBe(8);
    expect(POPOVER_MARGIN).toBe(8);
  });
});

describe("computePopoverPosition — 贴底部翻上", () => {
  it("下方放不下、上方放得下 → 翻上（bottom 锚定，面板从触发器上方生长）", () => {
    // 600 高视口、触发器 top 500：下方 48px 装不下 158，上方 484px 装得下
    const pos = computePopoverPosition(
      { top: 500, bottom: 536, left: 300 },
      { width: 1440, height: 600 },
      PANEL,
    );
    expect(bottomOf(pos)).toBe(600 - 500 + POPOVER_GAP);
    expect(600 - bottomOf(pos)).toBe(500 - POPOVER_GAP); // 面板下边缘在触发器上边缘之上 gap
    expect(pos.top).toBeUndefined();
    expect(pos.maxHeight).toBe(PANEL.height);
  });

  it("触发器贴视口底（下方可用为负）也翻上，绝不产出负 maxHeight", () => {
    const pos = computePopoverPosition(
      { top: 560, bottom: 596, left: 300 },
      { width: 1440, height: 600 },
      PANEL,
    );
    expect(bottomOf(pos)).toBe(600 - 560 + POPOVER_GAP);
    expect(pos.maxHeight).toBeGreaterThan(0);
  });

  it("上下都放不下（矮视口）：不翻上，仍向下（起点固定，交给 maxHeight）", () => {
    // 300 高视口、触发器 top 150 / bottom 186：下方 98、上方 134，都装不下 158
    const pos = computePopoverPosition(
      { top: 150, bottom: 186, left: 300 },
      { width: 1440, height: 300 },
      PANEL,
    );
    expect(topOf(pos)).toBe(186 + POPOVER_GAP);
    expect(pos.bottom).toBeUndefined();
    expect(pos.maxHeight).toBe(300 - 194 - POPOVER_MARGIN);
    expect(pos.maxHeight).toBe(98);
  });
});

describe("computePopoverPosition — 水平夹取", () => {
  it("贴右边缘：左边界被夹到 视口宽 − 面板宽 − margin", () => {
    const pos = computePopoverPosition(
      { top: 120, bottom: 156, left: 340 },
      { width: 375, height: 700 },
      PANEL,
    );
    expect(pos.left).toBe(375 - 288 - POPOVER_MARGIN);
    expect(pos.left).toBe(79);
  });

  it("贴左边缘（触发器 left < margin）：左边界抬到 margin", () => {
    const pos = computePopoverPosition(
      { top: 120, bottom: 156, left: 2 },
      { width: 1440, height: 900 },
      PANEL,
    );
    expect(pos.left).toBe(POPOVER_MARGIN);
  });

  it("视口比面板还窄：夹取退化为 margin（不产出负 left）", () => {
    const pos = computePopoverPosition(
      { top: 120, bottom: 156, left: 40 },
      { width: 200, height: 700 },
      PANEL,
    );
    expect(pos.left).toBe(POPOVER_MARGIN);
    expect(pos.left).toBeGreaterThanOrEqual(0);
  });

  it("窄视口（375×700）+ 触发器居中：面板整体落在视口内", () => {
    const pos = computePopoverPosition(
      { top: 200, bottom: 236, left: 16 },
      { width: 375, height: 700 },
      PANEL,
    );
    expect(pos.left).toBe(16);
    expect(pos.left + PANEL.width).toBeLessThanOrEqual(375 - POPOVER_MARGIN);
  });
});

describe("computePopoverPosition — maxHeight 兜底", () => {
  it("上下都放不下：maxHeight = 下方可用空间（面板自身滚动）", () => {
    // 触发器 top 500 / bottom 536，面板预期高 500 > 下方 48 与上方 484
    const pos = computePopoverPosition(
      { top: 500, bottom: 536, left: 300 },
      { width: 1440, height: 600 },
      { width: 288, height: 500 },
    );
    expect(topOf(pos)).toBe(536 + POPOVER_GAP);
    expect(pos.maxHeight).toBe(600 - 544 - POPOVER_MARGIN);
    expect(pos.maxHeight).toBe(48);
  });

  it("下方可用为负：maxHeight 收缩为 0（不是负数）", () => {
    // 触发器已被滚出视口底部：下方与上方都装不下（视口仅 300 高）
    const pos = computePopoverPosition(
      { top: 250, bottom: 286, left: 300 },
      { width: 1440, height: 300 },
      { width: 288, height: 400 },
    );
    expect(pos.maxHeight).toBe(0);
    expect(topOf(pos)).toBe(286 + POPOVER_GAP);
  });

  it("放得下时 maxHeight = 面板预期高度（不引入多余滚动条）", () => {
    const pos = computePopoverPosition(
      { top: 10, bottom: 46, left: 300 },
      { width: 1440, height: 900 },
      PANEL,
    );
    expect(pos.maxHeight).toBe(PANEL.height);
  });
});
