// 全局会话 hook（spec hooks.md：auth-aware hooks）。
// 读取 Better Auth 会话并窄化为 SessionUser；isMounted 保证 SSR-safe。
import { useMounted } from "@/hooks/use-mounted";
import { authClient } from "@/lib/auth-client";
import { toSessionUser, type SessionUser } from "@/lib/session";

export interface SessionResult {
  /** 是否已完成客户端挂载（SSR-safe 前置条件）。 */
  isMounted: boolean;
  isPending: boolean;
  isRefetching: boolean;
  /** 已窄化的会话用户；未登录为 null。 */
  user: SessionUser | null;
  error: Error | null;
}

export function useSession(): SessionResult {
  const isMounted = useMounted();
  const { data, isPending, isRefetching, error } = authClient.useSession();

  return {
    isMounted,
    isPending,
    isRefetching,
    user: data?.user ? toSessionUser(data.user) : null,
    error: error as Error | null,
  };
}
