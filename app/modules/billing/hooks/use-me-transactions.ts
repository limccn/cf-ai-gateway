import { useQuery } from "@tanstack/react-query";
import { apiFetch, buildQuery } from "@/lib/api";
import type { TransactionsOutput } from "../types";

export interface MeTransactionsParams {
  type?: "recharge" | "usage" | "adjust";
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** GET /api/me/transactions — 当前用户自己的余额流水（分页 + type/时间过滤）。 */
export function useMeTransactions(params: MeTransactionsParams = {}) {
  return useQuery({
    queryKey: ["transactions", "me", params],
    queryFn: () =>
      apiFetch<TransactionsOutput>(
        `/api/me/transactions${buildQuery({
          type: params.type,
          from: params.from,
          to: params.to,
          limit: params.limit,
          offset: params.offset,
        })}`,
      ),
    staleTime: 30_000,
  });
}
