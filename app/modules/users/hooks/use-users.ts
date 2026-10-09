import { useQuery } from "@tanstack/react-query";
import { apiFetch, buildQuery } from "@/lib/api";
import type { ListUsersOutput } from "../types";

export interface UsersParams {
  search?: string;
  role?: "admin" | "member";
  status?: "active" | "disabled";
  limit?: number;
  offset?: number;
  /** 置 false 时不请求（如 member 视角）。 */
  enabled?: boolean;
}

/** GET /api/users — 用户列表（admin；支持搜索/角色/状态过滤）。 */
export function useUsers(params: UsersParams = {}) {
  return useQuery({
    queryKey: ["users", params],
    queryFn: () =>
      apiFetch<ListUsersOutput>(
        `/api/users${buildQuery({
          search: params.search,
          role: params.role,
          status: params.status,
          limit: params.limit,
          offset: params.offset,
        })}`,
      ),
    enabled: params.enabled !== false,
    staleTime: 30_000,
  });
}
