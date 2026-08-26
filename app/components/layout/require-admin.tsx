// admin 路由守卫（M6 审查门：member 访问 admin 路由 → 拒绝界面，而非仅隐藏入口）。
import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { Link } from "react-router";
import { useSession } from "@/hooks/use-session";
import { PageLoading } from "@/components/ui/states";
import { buttonVariants } from "@/components/ui/button";

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isMounted, isPending, user } = useSession();

  if (!isMounted || isPending) {
    return <PageLoading />;
  }

  // AppLayout 负责未登录重定向；这里仅在已登录但非 admin 时拒绝
  if (user === null || user.role !== "admin") {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8 text-center">
        <ShieldAlert className="size-8 text-destructive" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">403 — Admin access required</h1>
          <p className="text-sm text-muted-foreground">
            This page is only available to administrator accounts.
          </p>
        </div>
        <Link to="/dashboard" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
