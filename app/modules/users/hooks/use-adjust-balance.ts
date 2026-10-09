import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { AdjustBalanceInput, AdjustBalanceOutput } from "../types";

/** POST /api/users/:id/balance — 管理员代充/扣减余额（admin；amount 带符号，± 均可）。 */
export function useAdjustBalance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & AdjustBalanceInput) =>
      apiFetch<AdjustBalanceOutput>(`/api/users/${id}/balance`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      // 用户列表（余额）+ 流水列表都需刷新（调整后 admin 页交易表应立刻可见新记录）
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
}
