import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ListKeysOutput } from "../types";

/** GET /api/keys — 当前用户的网关 Key 列表（admin 可看全部）。 */
export function useKeys() {
  return useQuery({
    queryKey: ["keys"],
    queryFn: () => apiFetch<ListKeysOutput>("/api/keys"),
    staleTime: 30_000,
  });
}
