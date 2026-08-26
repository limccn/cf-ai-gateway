import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { CreateKeyInput, CreateKeyOutput } from "../types";

/** POST /api/keys — 创建 Key（响应含一次性明文）。 */
export function useCreateKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateKeyInput) =>
      apiFetch<CreateKeyOutput>("/api/keys", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });
}
