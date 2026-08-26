import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { UpdateKeyInput, UpdateKeyOutput } from "../types";

/** PATCH /api/keys/:id — 更新 Key 配置（名称/限流/缓存）。 */
export function useUpdateKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & UpdateKeyInput) =>
      apiFetch<UpdateKeyOutput>(`/api/keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });
}
