import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { PingProviderOutput } from "../types";

/**
 * POST /api/providers/:id/ping — 上游联通性检查（admin；批次 O）。
 *
 * **刻意不 invalidate `["providers"]`**（同 use-test-provider）：该路由无副作用
 * （不写断路器、不计费、不落 request_logs、不解密密钥），失败也不会改变任何 provider 状态。
 * invalidate 会让列表闪一下 —— 那正是「这个 provider 被踢下线了」的错觉。
 */
export function usePingProvider() {
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<PingProviderOutput>(`/api/providers/${id}/ping`, { method: "POST" }),
  });
}
