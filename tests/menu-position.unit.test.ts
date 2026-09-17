// 下拉菜单面板锚定算术单元测试（09-17-fix-dropdown-menu-stacking-escape）。
// 纯函数、无 DOM —— 面板 portal 到 body 后坐标必须自算，这段算术是本改动里唯一有回归
// 风险的部分。设计见该任务 design.md §3.3。
//
// 面板矩形取自审计 09-17-ui-paint-order-audit 的实测值（Chromium）：
//   - w-56 = 224px 宽
//   - 1440 档（lg，侧栏 w-60=240px，非 compact 触发器 p-3）→ 面板 [12, 236]
//   - 375/768 档（compact 图标栏 w-16=64px，触发器居中 36px）→ 面板 [14, 238]
import { describe, expect, it } from "vitest";
import {
  MENU_GAP,
  computeMenuPosition,
  type MenuPosition,
} from "../app/components/ui/menu-position";

/** 面板宽度：Tailwind w-56 = 14rem = 224px。 */
const PANEL_W = 224;

// 显式收窄而非 non-null assertion（quality.md Forbidden Pattern #6）。
// 附带好处：缺失时给出实际对象，比 "expected undefined to be 12" 好定位。
function leftOf(pos: MenuPosition): number {
  if (pos.left === undefined) {
    throw new Error(`expected start 对齐的 left，实际：${JSON.stringify(pos)}`);
  }
  return pos.left;
}

function rightOf(pos: MenuPosition): number {
  if (pos.right === undefined) {
    throw new Error(`expected end 对齐的 right，实际：${JSON.stringify(pos)}`);
  }
  return pos.right;
}

describe("computeMenuPosition — start 对齐（默认，面板左边缘贴触发器左边缘）", () => {
  it("1440 档：面板落在 [12, 236]，与审计实测一致（AC5 回归锁）", () => {
    const pos = computeMenuPosition(
      { top: 540, left: 12, right: 228 },
      "start",
      { width: 1440, height: 600 },
    );
    expect(pos.left).toBe(12);
    expect(leftOf(pos) + PANEL_W).toBe(236);
    // start 对齐不给 right —— 给了会与 left 同时生效，宽度被挤压
    expect(pos.right).toBeUndefined();
  });

  it("375 档（窄屏侧栏 64px）：面板右溢到 238，正是逃逸发生的几何", () => {
    const pos = computeMenuPosition(
      { top: 583, left: 14, right: 50 },
      "start",
      { width: 375, height: 700 },
    );
    expect(pos.left).toBe(14);
    expect(leftOf(pos) + PANEL_W).toBe(238);
    // 面板右边缘 238 > 侧栏右边界 64 —— 这就是窄屏必然与 <main> 相交的原因
    expect(leftOf(pos) + PANEL_W).toBeGreaterThan(64);
  });

  it("768 档（窄屏侧栏 64px）：与 375 同为 compact，左边界一致", () => {
    const pos = computeMenuPosition(
      { top: 483, left: 14, right: 50 },
      "start",
      { width: 768, height: 600 },
    );
    expect(pos.left).toBe(14);
  });
});

describe("computeMenuPosition — end 对齐（面板右边缘贴触发器右边缘）", () => {
  it("用 right 而非 left 表达，且不需要知道面板宽度", () => {
    const pos = computeMenuPosition(
      { top: 540, left: 1152, right: 1368 },
      "end",
      { width: 1440, height: 600 },
    );
    expect(rightOf(pos)).toBe(1440 - 1368);
    expect(rightOf(pos)).toBe(72);
    expect(pos.left).toBeUndefined();
  });

  it("触发器贴视口右缘时 right 为 0（不是负数）", () => {
    const pos = computeMenuPosition(
      { top: 100, left: 1300, right: 1440 },
      "end",
      { width: 1440, height: 600 },
    );
    expect(rightOf(pos)).toBe(0);
  });
});

describe("computeMenuPosition — bottom 锚定（面板下边缘在触发器上边缘之上 MENU_GAP）", () => {
  it("bottom = 视口高 − 触发器 top + GAP", () => {
    const pos = computeMenuPosition(
      { top: 540, left: 12, right: 228 },
      "start",
      { width: 1440, height: 600 },
    );
    expect(pos.bottom).toBe(600 - 540 + MENU_GAP);
    expect(pos.bottom).toBe(68);
  });

  it("GAP 与旧 mb-2（0.5rem = 8px）等值 —— 间距语义不许悄悄变", () => {
    expect(MENU_GAP).toBe(8);
  });

  it("边界：触发器上边缘在视口顶部 → 面板整体落在视口上方（bottom-full 的必然结果）", () => {
    const pos = computeMenuPosition(
      { top: 0, left: 12, right: 228 },
      "start",
      { width: 1440, height: 600 },
    );
    expect(pos.bottom).toBe(600 + MENU_GAP);
    // 下边缘距视口顶 = height − bottom = −8 ⇒ 面板底边恰在视口上方 GAP 处。
    // 面板只向上生长，所以触发器越靠上、面板越出屏 —— 本用例的触发器固定在侧栏底部，
    // 不触发该边界（design §5）。
    expect(600 - pos.bottom).toBe(-MENU_GAP);
  });

  it("触发器上边缘越出视口顶部 → 不夹取，面板整体被顶出视口上方", () => {
    const pos = computeMenuPosition(
      { top: -40, left: 12, right: 228 },
      "start",
      { width: 1440, height: 600 },
    );
    // bottom 是「下边缘距视口底」：触发器在视口上方 ⇒ bottom 变大（不是负数）
    expect(pos.bottom).toBe(648);
    // 换算回「下边缘距视口顶」= height − bottom = −48 ⇒ 已在视口上方。
    // 本次刻意不做翻转/夹取 —— 那是新行为，需要自己的验收（design §5）。
    expect(600 - pos.bottom).toBeLessThan(0);
  });
});

describe("computeMenuPosition — 三档视口 × 两对齐的完整矩阵", () => {
  const VIEWPORTS = [
    { name: "375", width: 375, height: 700 },
    { name: "768", width: 768, height: 600 },
    { name: "1440", width: 1440, height: 600 },
  ] as const;

  for (const vp of VIEWPORTS) {
    for (const align of ["start", "end"] as const) {
      it(`${vp.name} × ${align}：只产出该对齐方向的那一个水平边`, () => {
        const pos = computeMenuPosition(
          { top: vp.height - 60, left: 12, right: 228 },
          align,
          { width: vp.width, height: vp.height },
        );
        if (align === "start") {
          expect(pos.left).toBe(12);
          expect(pos.right).toBeUndefined();
        } else {
          expect(pos.right).toBe(vp.width - 228);
          expect(pos.left).toBeUndefined();
        }
        // 两个对齐方向的 bottom 语义相同
        expect(pos.bottom).toBe(60 + MENU_GAP);
      });
    }
  }
});
