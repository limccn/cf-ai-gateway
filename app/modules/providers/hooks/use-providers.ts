import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ListProvidersOutput } from "../types";

/** GET /api/providers — 上游 Provider 列表（admin；密钥字段已 mask）。 */
export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => apiFetch<ListProvidersOutput>("/api/providers"),
    staleTime: 30_000,
  });
}
