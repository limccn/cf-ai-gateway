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
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
