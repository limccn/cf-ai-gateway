// 原生 checkbox 的 shadcn 风格样式（轻量方案）。
import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type CheckboxProps = InputHTMLAttributes<HTMLInputElement>;

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 shrink-0 appearance-none rounded border border-input bg-transparent accent-primary checked:bg-primary checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
