import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { TestProviderOutput } from "../types";

/**
 * POST /api/providers/:id/test — 上游协议探测（admin；批次 N）。
 *
 * **刻意不 invalidate `["providers"]`**：该路由无副作用（不写断路器、不计费、不落 request_logs），
 * 探测失败不会改变任何 provider 状态，列表没有任何需要刷新的东西。
 * 反过来，若这里 invalidate，用户会看到列表闪一下 —— 那是「探测把 provider 踢下线了」的错觉，
 * 而事实恰恰相反。
 */
export function useTestProvider() {
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<TestProviderOutput>(`/api/providers/${id}/test`, { method: "POST" }),
  });
}
