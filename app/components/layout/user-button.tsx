// 认证感知的用户菜单（spec authentication.md UserButton 模式：isMounted + 未登录回退）。
import { LogOut } from "lucide-react";
import { Link } from "react-router";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";
import { useSession } from "@/hooks/use-session";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, buttonVariants } from "@/components/ui/button";

export function UserButton() {
  const { isMounted, isPending, user } = useSession();

  if (!isMounted || isPending) {
    return <Skeleton className="h-9 w-9 rounded-full" aria-label="Loading user" />;
  }

  if (!user) {
    return (
      <Link to="/login" className={buttonVariants({ variant: "outline", size: "sm", className: "h-8" })}>
        Sign In
      </Link>
    );
  }

  const handleSignOut = async () => {
    await authClient.signOut();
    queryClient.clear();
  };

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex size-9 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary"
        aria-hidden="true"
      >
        {user.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="hidden min-w-0 sm:block">
        <p className="truncate text-sm font-medium leading-tight">{user.name}</p>
        <p className="truncate text-xs text-muted-foreground leading-tight">{user.email}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={handleSignOut} title="Sign out">
        <LogOut aria-hidden="true" />
        <span className="sr-only">Sign out</span>
      </Button>
    </div>
  );
}
