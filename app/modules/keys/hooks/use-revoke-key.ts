import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { UpdateKeyOutput } from "../types";

/** POST /api/keys/:id/revoke — 吊销 Key（不可逆；状态置 revoked）。 */
export function useRevokeKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<UpdateKeyOutput>(`/api/keys/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });
}
