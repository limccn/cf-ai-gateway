// 轻量 Modal（无 Radix）：Esc 关闭、遮罩点击关闭、打开时聚焦面板。
// 语义与可访问性：role="dialog" + aria-modal + 标题关联（spec quality.md）。
//
// 为什么必须 portal 到 document.body：`position: sticky` 的祖先**自成层叠上下文**（z-index: auto
// 也一样）。弹窗若渲染在这种祖先内部（例：app-layout 的 sticky <aside> 里的头像菜单弹窗），
// `fixed inset-0 z-50` 只在该上下文内比较；而 <main> 在 DOM 中位于 <aside> 之后，其中任何
// positioned 元素（table.tsx 的 relative 包裹层、Search 图标包裹层）都会绘制在**整个弹窗之上**
// —— 表现为页面内容盖住弹窗、点击被截走。挂到 body 后 z-50 在根层叠上下文参与比较，
// 覆盖一切 z-index < 50 的内容，与弹窗挂在哪个容器里无关。
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // 回调经 ref 转发：调用方常见 inline lambda（每次渲染新引用）。若直接进 useEffect
  // 依赖，任意渲染都触发 effect 重建 → panelRef.focus() 反复抢焦点，用户输入被断（丢输入）。
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChangeRef.current(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // 早退必须在 portal 之前：open=false 时不往 body 里塞任何节点。
  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      {/* 遮罩 = 80% 黑 + backdrop-blur。
          为什么光靠加深不够：alpha 合成只能把底色按比例压暗，压不掉。最亮的前景
          （text-foreground 级 Copy 按钮，rgb(225,231,239)）在 60% 下对比度约 3.15:1
          —— 恰在 WCAG 非文本阈值 3:1 上，明显可读；加到 80% 只降到约 1.55:1，
          数字虽低于一切阈值，**肉眼看仍然读得出来**（09-17 实测截图证据：
          evidence/ac12-users-invite-copy-under-mask.png）。要让亮内容真正"消失"，
          得靠模糊把它从"文字"变成"色块"，而不是继续加黑。
          blur 只作用于遮罩自身所采样的背景；弹窗面板是它的**兄弟节点**（z-10，后绘制），
          不受影响。 */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg outline-none",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 id="dialog-title" className="text-lg font-semibold leading-none">
              {title}
            </h2>
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            aria-label="Close dialog"
          >
            <X />
          </Button>
        </div>
        <div className="mt-4">{children}</div>
        {footer ? <div className="mt-6 flex items-center justify-end gap-2">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
