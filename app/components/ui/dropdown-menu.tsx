// 最小下拉菜单基础组件（09-16-account-menu，design §3）。
//
// 为什么手写：仓库至今零 Radix 依赖（dialog.tsx 亦自绘），为一个菜单引入依赖不划算。
// 代价是可访问性要自己保证 —— 本文件显式落实（AC12）：
//   - 触发器：aria-haspopup="menu" + aria-expanded；面板：role="menu"；项：role="menuitem"（可聚焦）
//   - 打开时焦点移入第一个 item（无 item 时聚焦面板本身，保证 Esc 仍可用）
//   - 关闭路径：Esc / 面板外 mousedown / 选中项；Esc 与选中项关闭后焦点回到触发器
//   - ↑/↓/Home/End 在项间移动焦点；打开期间才挂 document 监听，关闭即移除（无泄漏）
//
// 定位：面板 bottom-full（向上弹出）—— 侧栏在窄屏是 w-16 图标栏，向下/向右弹出会被视口裁切。
// z-index 取 50：面板只需在**本层叠上下文内**胜出（侧栏自身是 sticky，自成层叠上下文；
// 面板在这个上下文里跟侧栏内容比层级，因而不受 overflow 裁切）。
// 注意这与 dialog 不是同一场比赛：dialog.tsx 已 portal 到 document.body，落在**根**层叠上下文，
// 恒在菜单之上 —— 无需再靠 DOM 顺序决定谁盖住谁。
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }
      // 面板外点击：不抢焦点（平台惯例——焦点随点击走），只关闭
      setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // 打开后焦点移入第一个 item：面板在本次提交后已挂载，effect 里可直接查询
  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const first = panel.querySelector<HTMLElement>('[role="menuitem"]');
    (first ?? panel).focus();
  }, [open]);

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
      {open ? (
        <DropdownMenuContext.Provider value={{ close }}>
          <div
            ref={panelRef}
            role="menu"
            tabIndex={-1}
            aria-orientation="vertical"
            onKeyDown={handlePanelKeyDown}
            className={cn(
              "absolute bottom-full z-50 mb-2 w-56 rounded-md border bg-card p-1 shadow-lg outline-none",
              align === "end" ? "right-0" : "left-0",
              className,
            )}
          >
            {children}
          </div>
        </DropdownMenuContext.Provider>
      ) : null}
    </div>
  );
}

export interface DropdownMenuItemProps {
  /** 选中回调；菜单先关闭并交还焦点，再执行本回调（回调里打开 Dialog 时焦点随之转移）。 */
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}

export function DropdownMenuItem({ onSelect, className, children }: DropdownMenuItemProps) {
  const menu = useContext(DropdownMenuContext);
  if (!menu) {
    throw new Error("DropdownMenuItem must be rendered inside <DropdownMenu>");
  }
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      onClick={() => {
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
