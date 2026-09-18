// Popover 面板的锚定算术（popover.tsx 专用；09-14 批次 A）。
//
// 为什么单独成文件：与 menu-position.ts 同因 —— 面板 portal 到 document.body 后坐标必须自算，
// 这段算术是本改动里唯一有回归风险的部分；抽成纯函数即可用无 DOM 单测锁死
// （见 tests/popover-position.unit.test.ts）。
//
// 与 menu-position.ts 的分工（两者刻意不合并）：
//   - menu-position 服务于「恒向上弹出的下拉菜单」：面板多高都不关心，用 bottom 锚定**远边**，
//     连宽度都可以不测（end 对齐时用 right）；
//   - 本原语是「触发器附近的浮层」：需要**左右夹取**（面板宽固定，才夹得住）与
//     **上下翻转**（下方放不下且上方放得下时翻上），故必然要知道面板尺寸。
//   两者都刻意不做运行期测量 —— 面板在坐标算出前不渲染，测量会要求两帧渲染、首帧闪烁。
//   本原语的「面板高度」是调用方给定的**预期值**：只参与翻转判据与 maxHeight 兜底，
//   真实高度仍由 CSS 决定；估小了也只是提前 maxHeight 截断（面板自身滚动），不会溢出视口。

/** 面板与触发器之间的间距（px，= Tailwind 的 mt-2，0.5rem）。 */
export const POPOVER_GAP = 8;

/** 面板与视口边缘的最小间距（px）：水平夹取与翻转判据共用，避免贴边。 */
export const POPOVER_MARGIN = 8;

/** 触发器的视口矩形（只取定位用得到的三个边）。 */
export interface PopoverTriggerRect {
  top: number;
  bottom: number;
  left: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

/** 面板尺寸（调用方给定的常量：本原语不做运行期测量）。 */
export interface PopoverPanel {
  width: number;
  height: number;
}

/** 面板的 `position: fixed` 内联样式。`top` 与 `bottom` **互斥** —— 同时给会把高度挤扁。 */
export interface PopoverPosition {
  left: number;
  top?: number;
  bottom?: number;
  /** 高度上界：可用空间不足时面板自身滚动，避免「看得见、够不着」。 */
  maxHeight: number;
}

/**
 * 由触发器矩形算出面板位置。
 *
 * - 水平：面板左边缘对齐触发器左边缘，再夹进 `[margin, 视口宽 − 面板宽 − margin]`。
 * - 垂直：**优先向下**（`top = 触发器下边缘 + gap`）；下方放不下且上方放得下时翻上
 *   （改用 `bottom` 锚定，面板从触发器上方生长）。上下都放不下时仍向下 —— 与「翻上」
 *   相比，向下至少起点固定，溢出交给 `maxHeight` 处理。
 * - `maxHeight` 恒 ≥ 0（CSS 不接受负 max-height）：负可用空间（触发器已被滚出视口底部）
 *   收缩为 0，面板不可见但也不会撑破布局。
 */
export function computePopoverPosition(
  trigger: PopoverTriggerRect,
  viewport: PopoverViewport,
  panel: PopoverPanel,
  gap: number = POPOVER_GAP,
  margin: number = POPOVER_MARGIN,
): PopoverPosition {
  // 视口比面板还窄时 maxLeft < margin：取 margin 保住左边界（宁可右溢，也不让面板左边缘
  // 移出视口 —— 那种视口下横向滚动属页面级问题，与本原语无关）。
  const maxLeft = viewport.width - panel.width - margin;
  const left = Math.min(Math.max(trigger.left, margin), Math.max(maxLeft, margin));

  const spaceBelow = viewport.height - (trigger.bottom + gap) - margin;
  const spaceAbove = trigger.top - gap - margin;

  if (panel.height > spaceBelow && panel.height <= spaceAbove) {
    // 翻上：spaceAbove ≥ panel.height 是上面的判据，故无需再夹取 maxHeight。
    return {
      left,
      bottom: viewport.height - trigger.top + gap,
      maxHeight: panel.height,
    };
  }
  return {
    left,
    top: trigger.bottom + gap,
    maxHeight: Math.min(panel.height, Math.max(spaceBelow, 0)),
  };
}
