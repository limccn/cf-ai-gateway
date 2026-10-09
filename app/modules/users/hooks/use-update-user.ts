import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { UpdateUserInput, UserResponse } from "../types";

/** PATCH /api/users/:id — 修改角色 / 停用启用（admin）。 */
export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateUserInput) =>
      apiFetch<{ success: true; user: UserResponse }>(`/api/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["usage", "admin"] });
    },
  });
}
