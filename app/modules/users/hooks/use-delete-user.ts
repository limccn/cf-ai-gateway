import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { DeleteUserOutput } from "../types";

/** DELETE /api/users/:id — 硬删除用户 + 级联清理关联数据（admin，member 恒 403）。 */
export function useDeleteUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DeleteUserOutput>(`/api/users/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["usage", "admin"] });
    },
  });
}
