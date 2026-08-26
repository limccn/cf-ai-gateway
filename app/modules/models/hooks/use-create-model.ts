import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { CreateModelInput, ModelResponse } from "../types";

/** POST /api/models — 新增价格条目（admin）。 */
export function useCreateModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateModelInput) =>
      apiFetch<{ success: true; model: ModelResponse }>("/api/models", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}
