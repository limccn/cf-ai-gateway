// 轻量 Modal（无 Radix）：Esc 关闭、遮罩点击关闭、打开时聚焦面板。
// 语义与可访问性：role="dialog" + aria-modal + 标题关联（spec quality.md）。
import { useEffect, useRef, type ReactNode } from "react";
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

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/60"
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
    </div>
  );
}
