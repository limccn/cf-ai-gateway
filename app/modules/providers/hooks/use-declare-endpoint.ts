import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { DeclareEndpointInput, ProviderResponse } from "../types";

/**
 * POST /api/providers/:id/declare-endpoint — 「声明此端点」人工回写（批次 6 G2）。
 *
 * 与 `useTestProvider` 的「刻意不 invalidate」**刻意相反**：探测无副作用（列表没有任何
 * 需要刷新的东西），而声明**真的改了 provider 状态**（protocols 子对象）——不 invalidate
 * 的话，列表与编辑弹窗会继续显示旧的面表，用户会以为声明没生效。
 *
 * 解析语义（UI 有转述义务，见 provider-test-state.ts 的 DECLARE_* 文案）：声明面完全取代
 * 隐式面表——对 legacy 记录声明一个面，其余隐式面会失去路由偏好承载。
 */
export function useDeclareEndpoint() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & DeclareEndpointInput) =>
      apiFetch<{ success: true; provider: ProviderResponse }>(
        `/api/providers/${id}/declare-endpoint`,
        { method: "POST", body: JSON.stringify(data) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
