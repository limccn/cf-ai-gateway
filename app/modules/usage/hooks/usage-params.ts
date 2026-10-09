// 用量查询共用参数与 URL 构造（/api/me/usage 与 /api/admin/usage 复用）。
import { buildQuery } from "@/lib/api";
import type { UsageGroupBy, UsageRange } from "../types";

export interface UsageParams {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  /** 预设快捷窗口（今日/昨日/最近14/最近30），优先于 from/to（后端宽松忽略）。 */
  range?: UsageRange;
  /** 浏览器时区偏移分钟（UTC+8 → 480；与 range 同用；缺省 0 = UTC）。 */
  tzOffsetMin?: number;
  keyId?: number;
  /**
   * 模型过滤：**前端筛选入口已移除**（09-14 批次 A / A1.5，model 只作聚合维度），
   * 字段保留是因后端 /api/me/usage、/api/admin/usage 仍支持该参数（契约面），
   * 删掉会让「契约里有的能力在类型上没有名字」。
   */
  model?: string;
  /**
   * 状态过滤。服务端语义：作用于 request_logs 查询（明细 + hour/status 聚合）。
   * Usage 页只把它交给**明细查询**（D3 裁决：状态筛选不作用于图表）。
   */
  status?: "success" | "error" | "cached" | "rejected";
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
