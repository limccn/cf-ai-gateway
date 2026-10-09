// 无 Radix 的轻量折叠区块（ghost 按钮触发 + ChevronDown 旋转 + aria-expanded）。
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CollapsibleProps {
  title: string;
  /** 受控 open；未传则内部自管理默认关闭。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

export function Collapsible({ title, open, onOpenChange, children }: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;

  return (
    <div>
      <button
        type="button"
        onClick={() => (onOpenChange ? onOpenChange(!isOpen) : setInternalOpen(!isOpen))}
        aria-expanded={isOpen}
        className={cn(
          "flex w-full items-center justify-between rounded-md px-1 py-1.5 text-sm font-medium",
          "text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span>{title}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-180")}
        />
      </button>
      {isOpen ? <div className="space-y-4 pt-2">{children}</div> : null}
    </div>
  );
}
