// 通用加载 / 错误 / 空态组件（spec hooks.md：错误态与加载态可见）。
import { AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "./skeleton";

export function PageLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = "Failed to load data",
  message,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-8 text-center",
        className,
      )}
    >
      <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent"
        >
          Try Again
        </button>
      ) : null}
    </div>
  );
}

export interface EmptyStateProps {
  title?: string;
  description?: string;
  className?: string;
}

export function EmptyState({
  title = "Nothing here yet",
  description,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-muted-foreground",
        className,
      )}
    >
      <Inbox className="size-6" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="text-sm">{description}</p> : null}
    </div>
  );
}
