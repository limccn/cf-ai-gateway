import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { MarkWelcomeSeenOutput } from "../types";

/**
 * POST /api/me/onboarding/welcome-seen — 标记首登欢迎弹窗已读（服务端幂等、无参数）。
 *
 * 刻意不在本 hook 里做错误提示（无 toast）：调用方（WelcomeDialog）是乐观关闭语义 ——
 * 标记写入失败不回滚 UI、不打扰用户，最坏结果是下次登录再弹一次（R6）。
 * 失败重试无意义（重复调用幂等），交给默认重试即可。
 */
export function useMarkWelcomeSeen() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch<MarkWelcomeSeenOutput>("/api/me/onboarding/welcome-seen", {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["onboarding"] });
    },
  });
}
