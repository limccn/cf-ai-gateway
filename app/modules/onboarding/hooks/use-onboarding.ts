import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { OnboardingOutput } from "../types";

/**
 * GET /api/me/onboarding — 首登欢迎状态（是否弹「赠金已到账」+ 展示金额）。
 *
 * staleTime 取「少变配置」档（同 use-settings）：该状态每个账号至多变一次（未读 → 已读），
 * 标记已读后由 useMarkWelcomeSeen 显式 invalidate 保证立即刷新，无需高频重查。
 */
export function useOnboarding() {
  return useQuery({
    queryKey: ["onboarding"],
    queryFn: () => apiFetch<OnboardingOutput>("/api/me/onboarding"),
    staleTime: 60_000,
  });
}
