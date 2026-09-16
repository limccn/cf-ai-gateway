// 认证感知的用户菜单（spec authentication.md UserButton 模式：isMounted + 未登录回退）。
//
// 09-16-account-menu：头像升级为下拉菜单触发器 —— 登出收进菜单（行为与旧实现一字不差：
// await authClient.signOut() + queryClient.clear()），并新增 Profile 弹窗入口。
// compact（窄屏图标栏）与常规态**共用同一份菜单逻辑**，仅触发器可见内容不同（不复制两份）。
import { useState } from "react";
import { LogOut, User } from "lucide-react";
import { Link } from "react-router";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";
import { useSession } from "@/hooks/use-session";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ProfileDialog } from "./profile-dialog";

export function UserButton({ compact = false }: { compact?: boolean }) {
  const { isMounted, isPending, user } = useSession();
  const [profileOpen, setProfileOpen] = useState(false);

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

  const avatar = (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary"
      aria-hidden="true"
    >
      {user.name.slice(0, 1).toUpperCase()}
    </span>
  );

  return (
    <>
      <DropdownMenu
        triggerLabel="Account menu"
        triggerTitle={compact ? user.name : undefined}
        triggerClassName={
          compact
            ? "rounded-full"
            : "flex w-full items-center gap-3 rounded-md p-1 text-left transition-colors hover:bg-muted"
        }
        trigger={
          compact ? (
            avatar
          ) : (
            <>
              {avatar}
              <span className="hidden min-w-0 flex-1 sm:block">
                <span className="block truncate text-sm font-medium leading-tight">{user.name}</span>
                <span className="block truncate text-xs leading-tight text-muted-foreground">
                  {user.email}
                </span>
              </span>
            </>
          )
        }
      >
        {/* 账户区：非交互（不参与 ↑/↓ 焦点移动），name + email 单行截断 */}
        <DropdownMenuLabel>
          <p className="truncate text-sm font-medium leading-tight">{user.name}</p>
          <p className="truncate text-xs leading-tight text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
          <User aria-hidden="true" />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleSignOut()}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenu>
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
    </>
  );
}
