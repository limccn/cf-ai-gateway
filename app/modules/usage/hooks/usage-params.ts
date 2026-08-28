// 用量查询共用参数与 URL 构造（/api/me/usage 与 /api/admin/usage 复用）。
import { buildQuery } from "@/lib/api";
import type { UsageGroupBy } from "../types";

export interface UsageParams {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  keyId?: number;
  model?: string;
  status?: "success" | "error" | "cached" | "rejected"; // 仅过滤 request_logs（明细 + hour/status 聚合）
  groupBy?: UsageGroupBy;
  limit?: number;
  offset?: number;
  /** 是否启用查询（默认 true；用于依赖其他数据的条件查询）。 */
  enabled?: boolean;
}

export function toUsageQuery(params: UsageParams): string {
  return buildQuery({
    from: params.from,
    to: params.to,
    keyId: params.keyId,
    model: params.model,
    status: params.status,
    groupBy: params.groupBy,
    limit: params.limit,
    offset: params.offset,
  });
}
