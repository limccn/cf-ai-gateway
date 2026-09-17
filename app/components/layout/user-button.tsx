// 认证感知的用户菜单（spec authentication.md UserButton 模式：isMounted + 未登录回退）。
//
// 09-16-account-menu：头像升级为下拉菜单触发器 —— 登出收进菜单（行为与旧实现一字不差：
// await authClient.signOut() + queryClient.clear()），并新增 Profile 弹窗入口。
// 09-17-password-menu-and-dialog-overflow：改密从 Profile 弹窗的内嵌区块升为**并列菜单项**
// （顺序 Profile → Change password → 分隔线 → Sign out），点开自己的弹窗。
// compact（窄屏图标栏）与常规态**共用同一份菜单逻辑**，仅触发器可见内容不同（不复制两份）。
import { useState } from "react";
import { KeyRound, LogOut, User } from "lucide-react";
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
import { useProfile } from "@/modules/profile/hooks/use-profile";
import { ChangePasswordDialog } from "./change-password-dialog";
import { ProfileDialog } from "./profile-dialog";

export function UserButton({ compact = false }: { compact?: boolean }) {
  const { isMounted, isPending, user } = useSession();
  const [profileOpen, setProfileOpen] = useState(false);
  // 两个弹窗各持一份状态：开哪个由点的是哪个菜单项决定。共用一份会互相踩
  // （从 Profile 切到 Change password 时，前者 close 会顺手把后者也关掉）。
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

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
        {/* 顺序（R1）：Profile → Change password → 分隔线 → Sign out。
            改密是条件项（无凭据账号不渲染），见 ChangePasswordMenuItem。 */}
        <ChangePasswordMenuItem onSelect={() => setChangePasswordOpen(true)} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleSignOut()}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenu>
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
    </>
  );
}

/**
 * 账户菜单里的改密入口（09-17-password-menu-and-dialog-overflow，design §3.1/§3.3）。
 *
 * **挂载时机 = 菜单打开时机**（隐含契约，来自 dropdown-menu.tsx 的面板渲染式
 * `{open && pos ? createPortal(…{children}…) : null}` —— children 只在打开时挂载）。
 * 故这里的 useProfile() 语义天然就是「用户真的动了这个菜单」才发一次 GET /api/me/profile：
 * 60s staleTime 内重开菜单命中缓存，页面加载时零请求（AC5）。
 * **若将来把面板改成常驻挂载，本入口会静默退化成「页面加载即发请求」** —— 改那里必须同步重审本条。
 *
 * 判据唯一真源是服务端下发的 hasPassword（design §4）：前端不得从 provider / 登录方式推导。
 * 解析为 false 与请求失败一律**不渲染入口**（fail-closed），延续既有决策 D5 ——
 * 不做置灰，置灰会引入一个永远不可用的控件。
 */
function ChangePasswordMenuItem({ onSelect }: { onSelect: () => void }) {
  const { data, isPending } = useProfile();

  // 图标 + 文案在占位盒与真实项之间**共用同一份 JSX**：各写一遍必然漂移
  // （图标尺寸 / 文案改一处漏一处），而 AC4 是拿「逐像素同高」取证的，漂移会直接击穿它。
  const label = (
    <>
      <KeyRound aria-hidden="true" />
      Change password
    </>
  );

  if (isPending) {
    // 占位槽：判据未就绪时先占住与真实菜单项**逐像素相同**的一格，就绪后原地替换，
    // 其下方各项的 y 坐标不动。这里的位移是**正确性问题**而非观感问题 ——
    // 用户此刻可能正朝 Sign out 移动指针，项一旦下移就是点错项。
    //
    // 为什么不能用 <DropdownMenuItem className="invisible">：它带 role="menuitem"，会被
    // dropdown-menu.tsx 的 moveFocus() 与首焦点 effect 的 querySelectorAll('[role="menuitem"]')
    // 选中；而 visibility:hidden 的元素上 focus() 是**静默 no-op** —— 方向键落到它上面
    // 表现为「按了没反应」（焦点没动），用户以为键盘坏了。故占位盒是**无 role 的普通 <div>**，
    // aria-hidden 亦保证它不进可访问性树。
    //
    // 盒类与 DropdownMenuItem 的盒类同源（dropdown-menu.tsx 的 item 类）：**改一处必须改两处**，
    // 漂移由 AC4 的逐像素高度断言兜底。
    return (
      <div
        aria-hidden="true"
        className="invisible flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm [&_svg]:size-4"
      >
        {label}
      </div>
    );
  }

  // isPending 为假后：hasPassword 非 true（OAuth 形态用户）、或查询失败（data 为 undefined）
  if (data?.profile.hasPassword !== true) {
    return null;
  }

  return <DropdownMenuItem onSelect={onSelect}>{label}</DropdownMenuItem>;
}
