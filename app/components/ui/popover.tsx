// 轻量 Popover 原语（09-14 批次 A / design §5）：触发器 + 锚定在下方（放不下则翻上）的
// **非模态**浮层，内容由调用方持有。
//
// 为什么是新原语而不是复用既有件：
//   - dropdown-menu.tsx 的语义是 role="menu" + 菜单项，把两个日期输入塞进去是错误语义
//     （内容会被 moveFocus()/方向键逻辑当成菜单项）；
//   - dialog.tsx 是**模态**：遮罩、抢焦点、锁 body 滚动 —— 一个筛选条件的日期选择不需要这些；
//   - collapsible.tsx 是文档流内展开，不是浮层（不满足「关闭时筛选区只留文本触发器」的形态）。
//
// 为什么 portal 到 document.body：与 dialog / dropdown-menu 同规。逃逸的判据是
// 「DOM 祖先里有没有 sticky」（sticky 自成层叠上下文，z-index:auto 也一样），**不是**
// 「是不是弹窗」—— 本原语的调用方位置不受控，把「必须不在 sticky 子树内」变成隐含契约
// 正是 09-17 层叠逃逸事故的成因（详见 frontend/components.md 的 dialog-portal 一节）。
//
// 定位：坐标由 popover-position.ts 的纯函数算出（无 DOM 单测锁死），面板宽度与**预期高度**
// 都由调用方给定常量 —— 面板在坐标算出前不渲染，故无法测量自身；用常量即无需两帧渲染、
// 无首帧闪烁。预期高度只参与「上下翻转」与 maxHeight 的判定，真实高度仍由 CSS 决定。
//
// 交互契约（三条关闭路径）：
//   - 面板外 mousedown（判据必须**同时**含 rootRef 与 panelRef —— portal 后面板不再是触发器
//     的后代，少了 panelRef 会把面板内的 mousedown 判成「点了外面」：先卸载面板 → 输入框点不动）；
//   - Esc（document 级监听：焦点通常在面板里的输入框上，但面板外的焦点也该能关）；
//   - 触发器再次点击。
// Esc 与触发器点击关闭后焦点回到触发器；面板外点击**不抢焦点**（平台惯例：焦点随点击走）。
// 内容变更（如选日期）不自动关闭 —— 选时间区间通常要连改 From 与 To 两个输入。
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  computePopoverPosition,
  type PopoverPanel,
  type PopoverPosition,
} from "./popover-position";

export interface PopoverProps {
  /** 触发器内容（渲染进组件内部的 <button>）。 */
  trigger: ReactNode;
  /** 触发器的可访问名称（图标态无可见文本时必需）。 */
  triggerLabel?: string;
  /** 触发器按钮附加类名（布局 / 按钮外观）。 */
  triggerClassName?: string;
  /** 面板尺寸常量：定位算术的输入，同时写入面板 inline style（同一来源，两处不会失配）。 */
  panel: PopoverPanel;
  /** 面板的可访问名称（role="dialog" 需要名称，否则读屏只报「对话框」）。 */
  panelLabel: string;
  /** 面板附加类名。 */
  className?: string;
  children: ReactNode;
}

export function Popover({
  trigger,
  triggerLabel,
  triggerClassName,
  panel,
  panelLabel,
  className,
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  // 面板坐标（fixed）。null = 尚未算出 —— 面板在算出前不渲染，故不会闪现在 (0,0)。
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  };

  // 面板坐标：useLayoutEffect 在 DOM 提交后、**绘制前**同步算出，用户看不到未定位的一帧。
  // 依赖用 [open, panel.width, panel.height] 而非 panel 对象本身 —— 调用方常写字面量
  // （每次渲染新引用），依赖对象会让 effect 每次渲染都重跑，而它内部 setPos 又产出新对象
  // → 无限渲染循环；依赖两个数字则天然稳定。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      setPos(
        computePopoverPosition(
          { top: rect.top, bottom: rect.bottom, left: rect.left },
          { width: window.innerWidth, height: window.innerHeight },
          panel,
        ),
      );
    };
    update();
    // scroll 用捕获阶段：滚动事件不冒泡到 window，只有捕获才收得到嵌套滚动容器
    // （app-layout 的 nav 就带 overflow-y-auto）。漏了它，页面一滚面板就静默脱锚。
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, panel.width, panel.height]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // 依赖只看 open：回调里用到的 close / setOpen / 各 ref 都是稳定引用，
    // 面板开合期间无需重挂监听（重挂会短暂失去 mousedown 的拦截窗口）。
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        // 两半边都要：面板已 portal 到 body，不再是 rootRef 的后代。见文件头。
        (rootRef.current?.contains(target) || panelRef.current?.contains(target))
      ) {
        return;
      }
      // 面板外点击：不抢焦点（平台惯例——焦点随点击走），只关闭
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close(true);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // 打开后焦点移入面板：键盘用户不必先 Tab 过整个触发器区；面板本身可聚焦（tabIndex=-1）。
  // 依赖里带 panelReady（布尔）而不是只依赖 open：面板要等坐标算出才渲染，「open 翻 true」
  // 那一帧 panelRef 还是空的，只看 open 会静默跳过聚焦；而依赖 pos 又会在滚动重算时
  // 反复触发、把焦点从用户正在操作的输入框上抢走。
  const panelReady = pos !== null;
  useEffect(() => {
    if (!open || !panelReady) {
      return;
    }
    panelRef.current?.focus();
  }, [open, panelReady]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        className={cn(
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          triggerClassName,
        )}
        onClick={() => setOpen((prev) => !prev)}
      >
        {trigger}
      </button>
      {/* 面板 portal 到 body：脱离 sticky 祖先的层叠上下文，z-50 在根上下文参与比较。
          定位与尺寸都走 inline style：`pos` 是运行时算出的坐标，宽度与 panel 常量同源，
          maxHeight 是可用空间的兜底（内容超出时面板自身滚动）。
          `overflow-y-auto` 会把 overflow-x 一并计算为 auto（CSS 规范）——
          故面板内不得安放依赖「溢出可见」的绝对定位浮层（下拉菜单等应 portal 到 body）。 */}
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={panelLabel}
              tabIndex={-1}
              style={{
                left: pos.left,
                top: pos.top,
                bottom: pos.bottom,
                width: panel.width,
                maxHeight: pos.maxHeight,
              }}
              className={cn(
                "fixed z-50 overflow-y-auto rounded-md border bg-card p-3 shadow-lg outline-none",
                className,
              )}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
