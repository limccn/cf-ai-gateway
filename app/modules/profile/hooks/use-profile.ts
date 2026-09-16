import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ProfileOutput } from "../types";

/**
 * GET /api/me/profile — Dialog 渲染所需的账号资料（name/email/emailVerified/验证开关）。
 *
 * staleTime 取「少变配置」档（同 use-settings / use-onboarding）：name 改成后由
 * profile-dialog 显式 invalidate 保证立即刷新；emailVerified 只会单向翻转一次。
 * 本 hook 只由「已打开」的 ProfileDialog 挂载（关闭时不渲染内容），因此不会在
 * 每次页面加载时白发一次请求。
 */
export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => apiFetch<ProfileOutput>("/api/me/profile"),
    staleTime: 60_000,
  });
}
