import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { CreateProviderInput, ProviderResponse } from "../types";

/** POST /api/providers — 创建上游 Provider（admin）。 */
export function useCreateProvider() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateProviderInput) =>
      apiFetch<{ success: true; provider: ProviderResponse }>("/api/providers", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
