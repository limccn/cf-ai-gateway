// 下拉菜单面板的锚定算术（dropdown-menu.tsx 专用）。
//
// 为什么单独成文件：面板 portal 到 document.body 后必须自己算坐标，这段算术是本改动里
// 唯一有回归风险的部分；抽成纯函数即可用无 DOM 的单测锁死（见 tests/menu-position.unit.test.ts）。
//
// 关键设计：用 `bottom`/`right` 而非 `top`/`left` 锚定**远边** —— 面板高度/宽度因此
// 自动参与定位，无需测量、无需两帧渲染、无首帧闪烁，且面板内容高度变化时自动正确。

/** 面板下边缘与触发器上边缘的间距（px）。等价于原先 Tailwind 的 `mb-2`（0.5rem）。 */
export const MENU_GAP = 8;

/** 触发器的视口矩形（只取定位用得到的三个边）。 */
export interface TriggerRect {
  top: number;
  left: number;
  right: number;
}

/** 视口尺寸。 */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * 面板的 `position: fixed` 内联样式。
 * `left` 与 `right` 互斥：start 对齐给 `left`，end 对齐给 `right`。
 */
export interface MenuPosition {
  left?: number;
  right?: number;
  bottom: number;
}

/**
 * 由触发器矩形算出面板位置。面板恒向上弹出（bottom-full 语义）。
 *
 * @param trigger 触发器视口矩形（`getBoundingClientRect()`）
 * @param align `start` = 面板左边缘对齐触发器左边缘；`end` = 右边缘对齐右边缘
 * @param viewport 视口尺寸（`window.innerWidth` / `innerHeight`）
 */
export function computeMenuPosition(
  trigger: TriggerRect,
  align: "start" | "end",
  viewport: Viewport,
): MenuPosition {
  // bottom 是「面板下边缘距视口底」的距离：触发器上边缘距底 = height - top，
  // 再加 MENU_GAP 把面板整体上移一个间距。面板多高都向上生长，故无需知道高度。
  const bottom = viewport.height - trigger.top + MENU_GAP;
  return align === "end"
    ? { right: viewport.width - trigger.right, bottom }
    : { left: trigger.left, bottom };
}
