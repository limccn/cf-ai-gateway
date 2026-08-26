import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ListInvitesOutput } from "../types";

/** GET /api/users/invites — 邀请码列表（admin）。 */
export function useInvites() {
  return useQuery({
    queryKey: ["users", "invites"],
    queryFn: () => apiFetch<ListInvitesOutput>("/api/users/invites"),
    staleTime: 30_000,
  });
}
