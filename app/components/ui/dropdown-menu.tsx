// 最小下拉菜单基础组件（09-16-account-menu，design §3）。
//
// 为什么手写：仓库至今零 Radix 依赖（dialog.tsx 亦自绘），为一个菜单引入依赖不划算。
// 代价是可访问性要自己保证 —— 本文件显式落实（AC12）：
//   - 触发器：aria-haspopup="menu" + aria-expanded；面板：role="menu"；项：role="menuitem"（可聚焦）
//   - 打开时焦点移入第一个 item（无 item 时聚焦面板本身，保证 Esc 仍可用）
//   - 关闭路径：Esc / 面板外 mousedown / 选中项；Esc 与选中项关闭后焦点回到触发器
//   - ↑/↓/Home/End 在项间移动焦点；打开期间才挂 document 监听，关闭即移除（无泄漏）
//
// 定位：面板恒向上弹出（bottom-full 语义）—— 侧栏在窄屏是 w-16 图标栏，
// 向下/向右弹出会被视口裁切。坐标由 menu-position.ts 算，样式走 `position: fixed`。
//
// 为什么必须 portal 到 document.body（2026-09-17-ui-paint-order-audit 实测）：
// 本组件挂在 app-layout 的 `sticky <aside>` 内，而 `position: sticky` 的祖先**自成层叠上下文**
// （z-index: auto 也一样）。面板若留在那棵树里，它的 `z-50` 只在 aside 内比较；而 <main> 在 DOM
// 中位于 aside 之后，其中任何 positioned 元素（table.tsx 的 relative 包裹层、Search 图标包裹层）
// 都绘制在**整个 aside 子树之上** —— 面板被盖住，点击被这些元素截获，菜单项点了没反应。
//
// 判据是「DOM 祖先里有没有 sticky」，**不是「是不是弹窗」**：早先只把 Dialog portal 出去
// （a7fc9c3），本面板因为「不是弹窗」被漏掉，实测 375 档 38.5% / 768 档 47.8% 面积不可命中。
// 修法不能靠给 <aside> 加 z-index —— 那只是把层级竞态全局化（详见本任务 design.md §2）。
// 挂到 body 后 z-50 在**根**层叠上下文里参与比较，与 dialog.tsx 同一套机制。
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { computeMenuPosition, type MenuPosition } from "./menu-position";

interface DropdownMenuContextValue {
  /** 关闭菜单；restoreFocus=true 时把焦点交还触发器。 */
  close: (restoreFocus: boolean) => void;
}

const DropdownMenuContext = createContext<DropdownMenuContextValue | null>(null);

export interface DropdownMenuProps {
  /** 触发器内容（渲染进组件内部的 <button>）。 */
  trigger: ReactNode;
  /** 触发器的可访问名称（图标态无可见文本时必需）。 */
  triggerLabel: string;
  /** 触发器原生 tooltip（可选，如窄屏图标栏里提示姓名）。 */
  triggerTitle?: string;
  /** 触发器按钮附加类名（布局 / 悬停态）。 */
  triggerClassName?: string;
  /** 面板对齐：start = 与触发器左对齐（默认，窄侧栏里向右展开）；end = 与触发器右对齐。 */
  align?: "start" | "end";
  /** 面板附加类名（宽度等）。 */
  className?: string;
  children: ReactNode;
}

export function DropdownMenu({
  trigger,
  triggerLabel,
  triggerTitle,
  triggerClassName,
  align = "start",
  className,
  children,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  // 面板坐标（fixed）。null = 尚未算出 —— 面板在算出前不渲染，故不会闪现在错误位置。
  const [pos, setPos] = useState<MenuPosition | null>(null);
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
  // 依赖 [open, align] 而非 [pos] —— 滚动重算不能反过来再触发自身。
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
        computeMenuPosition(
          { top: rect.top, left: rect.left, right: rect.right },
          align,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    update();
    // scroll 用捕获阶段：滚动事件不冒泡到 window，只有捕获才收得到嵌套滚动容器
    // （app-layout 的 nav 就有 overflow-y-auto）。菜单跟着触发器走是硬契约 ——
    // 本用例里触发器在 sticky h-screen 侧栏内、nav 之外，实际不会动，这里是防御性的：
    // 一旦布局改成侧栏可折叠 / 触发器移入可滚动区，没有它就会静默脱锚。
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        // 面板已 portal 到 body，**不再是 rootRef 的后代** —— 少了这半边判据，
        // 在菜单项上 mousedown 会被判成「点了外面」：先关菜单、面板卸载，
        // 后续 click 永不派发，onSelect 不执行（表现为菜单项点了没反应）。
        (rootRef.current?.contains(target) || panelRef.current?.contains(target))
      ) {
        return;
      }
      // 面板外点击：不抢焦点（平台惯例——焦点随点击走），只关闭
      setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // 打开后焦点移入第一个 item（无 item 时聚焦面板本身，保证 Esc 仍可用）。
  //
  // 依赖里带 panelReady 而不是只依赖 open：面板要等坐标算出才渲染，所以「open 翻 true」
  // 那一帧 panelRef 还是空的，只看 open 会静默跳过聚焦。panelReady 是布尔量 ——
  // 滚动重算让 pos 反复变化时它恒为 true，**不会**把焦点从用户正在操作的项上抢走。
  const panelReady = pos !== null;
  useEffect(() => {
    if (!open || !panelReady) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const first = panel.querySelector<HTMLElement>('[role="menuitem"]');
    (first ?? panel).focus();
  }, [open, panelReady]);

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      moveFocus(panelRef.current, event.key);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerTitle}
        className={cn(
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          triggerClassName,
        )}
        onClick={() => setOpen((prev) => !prev)}
      >
        {trigger}
      </button>
      {/* 面板 portal 到 body：脱离 sticky aside 的层叠上下文，z-50 在根上下文参与比较。
          定位用 inline style（fixed + 远边锚定）而非 Tailwind 类 ——
          `bottom-full` / `mb-2` / `left-0` 都相对**最近的定位祖先**，portal 后语义已变，
          且滚动重算需逐帧写入坐标（style 是 React 状态，不是命令式改 DOM，见 design §3.6）。
          `pos` 就绪前不渲染：宁可晚一帧（实际在绘制前，用户看不到）也不闪现在 (0,0)。 */}
      {open && pos
        ? createPortal(
            <DropdownMenuContext.Provider value={{ close }}>
              <div
                ref={panelRef}
                role="menu"
                tabIndex={-1}
                aria-orientation="vertical"
                onKeyDown={handlePanelKeyDown}
                style={pos}
                className={cn(
                  "fixed z-50 w-56 rounded-md border bg-card p-1 shadow-lg outline-none",
                  className,
                )}
              >
                {children}
              </div>
            </DropdownMenuContext.Provider>,
            document.body,
          )
        : null}
    </div>
  );
}

export interface DropdownMenuItemProps {
  /** 选中回调；菜单先关闭并交还焦点，再执行本回调（回调里打开 Dialog 时焦点随之转移）。 */
  onSelect: () => void;
  /**
   * 不可用态（2026-09-21）：视觉置灰、点击与 Enter/Space 一律 no-op，**但键仍留在焦点序列里**。
   *
   * 刻意**不用原生 `disabled` 属性**：原生 disabled 的元素不可聚焦，而本文件的 `moveFocus()` 与
   * 首焦点 effect 都是按 `[role="menuitem"]` 选人的 —— `focus()` 在不可聚焦的元素上是**静默
   * no-op**，于是 ↑/↓ 落到它上面表现为「按了没反应」（焦点没动）。这与本文件顶部记的
   * `visibility: hidden` 占位盒是**同一个坑**，只是触发条件从「不可见」换成了「不可聚焦」。
   * `aria-disabled` 则如实告诉辅助技术「这一项不可用」，同时元素仍可获得焦点。
   */
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function DropdownMenuItem({
  onSelect,
  disabled = false,
  className,
  children,
}: DropdownMenuItemProps) {
  const menu = useContext(DropdownMenuContext);
  if (!menu) {
    throw new Error("DropdownMenuItem must be rendered inside <DropdownMenu>");
  }
  return (
    <button
      type="button"
      role="menuitem"
      // 可用时整个属性不输出（`false || undefined`），而不是输出 aria-disabled="false" ——
      // 前者让「按 aria-disabled 普查菜单」的断言能干净地数出不可用项。
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        // 可用态：hover 与 focus 都给强调背景（既有行为，一字未改）。
        // 不可用态：**不给 hover 反馈**（免得看着像能点），但保留半强度的 focus 背景 ——
        // 键仍可聚焦，若连焦点指示都没有，用户就分不清「焦点不在菜单里」与「焦点停在这一项上」，
        // 那还是「按了没反应」的观感。
        disabled
          ? "cursor-default text-muted-foreground/50 focus:bg-accent/50"
          : "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
        className,
      )}
      onClick={() => {
        // aria-disabled 只是语义，**不拦原生 click** —— 拦截必须在这里做。
        // 不可用时既不关菜单也不执行回调：菜单开着让用户接着选别的项，比关掉更像个「死键」。
        if (disabled) {
          return;
        }
        menu.close(true);
        onSelect();
      }}
    >
      {children}
    </button>
  );
}

/** 非交互区（如账户头部 name + email）：不参与 ↑/↓ 焦点移动（无 role="menuitem"）。 */
export function DropdownMenuLabel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("px-2 py-1.5", className)}>{children}</div>;
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

/** ↑/↓/Home/End 在面板内的 menuitem 之间移动焦点（循环）。 */
function moveFocus(panel: HTMLElement | null, key: string): void {
  if (!panel) {
    return;
  }
  const items = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  if (items.length === 0) {
    return;
  }
  const current = items.findIndex((item) => item === document.activeElement);
  let next = current;
  if (key === "ArrowDown") {
    next = current < 0 ? 0 : (current + 1) % items.length;
  } else if (key === "ArrowUp") {
    next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
  } else if (key === "Home") {
    next = 0;
  } else if (key === "End") {
    next = items.length - 1;
  }
  items[next]?.focus();
}
