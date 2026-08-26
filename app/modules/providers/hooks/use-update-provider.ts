import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ProviderResponse, UpdateProviderInput } from "../types";

/** PATCH /api/providers/:id — 更新 Provider（admin；apiKey 省略则保持原密文）。 */
export function useUpdateProvider() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & UpdateProviderInput) =>
      apiFetch<{ success: true; provider: ProviderResponse }>(`/api/providers/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
