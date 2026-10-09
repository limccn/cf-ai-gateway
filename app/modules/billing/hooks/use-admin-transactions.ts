import { useQuery } from "@tanstack/react-query";
import { apiFetch, buildQuery } from "@/lib/api";
// type 用后端 schema 推导的 BalanceTxType（唯一真源，勿在此手写字符串联合）
import type { BalanceTxType, TransactionsOutput } from "../types";

export interface AdminTransactionsParams {
  userId?: number;
  type?: BalanceTxType;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** GET /api/admin/transactions — 全局余额流水（admin；可选 userId 过滤）。 */
export function useAdminTransactions(params: AdminTransactionsParams = {}) {
  return useQuery({
    queryKey: ["transactions", "admin", params],
    queryFn: () =>
      apiFetch<TransactionsOutput>(
        `/api/admin/transactions${buildQuery({
          userId: params.userId,
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
