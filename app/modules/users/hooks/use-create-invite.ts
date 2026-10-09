import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { CreateInviteInput, CreateInviteOutput } from "../types";

/** POST /api/users/invites — 生成邀请码（admin；过期天数 1–90）。 */
export function useCreateInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateInviteInput) =>
      apiFetch<CreateInviteOutput>("/api/users/invites", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users", "invites"] });
    },
  });
}
