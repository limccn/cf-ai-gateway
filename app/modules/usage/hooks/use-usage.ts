import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { UsageOutput } from "../types";
import { toUsageQuery, type UsageParams } from "./usage-params";

/** GET /api/me/usage — 当前用户（member）自己的用量报表（聚合 + 明细分页）。 */
export function useUsage(params: UsageParams) {
  const { enabled = true, ...rest } = params;
  return useQuery({
    queryKey: ["usage", "me", params],
    queryFn: () => apiFetch<UsageOutput>(`/api/me/usage${toUsageQuery(rest)}`),
    enabled,
    staleTime: 30_000,
  });
}
