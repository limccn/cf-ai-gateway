// 用量查询共用参数与 URL 构造（/api/me/usage 与 /api/admin/usage 复用）。
import { buildQuery } from "@/lib/api";
import type { UsageGroupBy, UsageRange } from "../types";

export interface UsageParams {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  /** 预设快捷窗口（今日/昨日/最近14/最近30），优先于 from/to/groupBy（后端宽松忽略）。 */
  range?: UsageRange;
  /** 浏览器时区偏移分钟（UTC+8 → 480；与 range 同用；缺省 0 = UTC）。 */
  tzOffsetMin?: number;
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
    range: params.range,
    tzOffsetMin: params.tzOffsetMin,
    keyId: params.keyId,
    model: params.model,
    status: params.status,
    groupBy: params.groupBy,
    limit: params.limit,
    offset: params.offset,
  });
}
