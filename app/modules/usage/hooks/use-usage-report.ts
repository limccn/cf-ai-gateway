// Usage 页的查询编排（09-14 批次 A / design §2）：页面同时需要三种聚合 + 明细，
// 而 groupBy 是单值参数、一次请求只能给一种 —— 故「每种聚合各发一次请求」，共 4 路。
//
// 为什么不扩接口一次返回三种聚合：/api/me/usage 与 /api/admin/usage 共享
// usageOutputSchema，dashboard、本页、既有单测与 stg E2E 脚本都在消费它，
// 改形状 = 全链路契约迁移，收益只是省两次请求。
// 为什么不由前端从 details 自行聚合：details 是分页的（limit ≤ 100），
// 环形图必须基于全量聚合 —— 小数据量下看似正确、数据一多就静默错。
//
// 拆开还顺带修掉一处既存缺陷（D3）：status 只作用于明细一路。现状里 range 模式的
// 柱状图取自 request_logs（requestLogsWhere 含 status 条件），筛明细会连带改变图表，
// 而 custom 模式取自 usage_daily（无 status 列）不会 —— 两种模式行为不一致。
//
// 查询 1/2/3 一律 limit: 1：接口总会附带 details，这几路不需要明细，用最小 limit
// （schema 下限 1）收窄响应体；聚合在 fetchUsageAggregates 内独立于 limit，结果不受影响。
import { useAdminUsage } from "./use-admin-usage";
import { useUsage } from "./use-usage";
import type { UsageParams } from "./usage-params";
import type { UsageAggregate, UsageDetail, UsageRange } from "../types";

export interface UsageReportParams {
  /** 管理员走 /api/admin/usage（可带 userId），成员走 /api/me/usage。 */
  isAdmin: boolean;
  /** 快捷窗口（today/yesterday/last14/last30）或自定义区间（custom → 用 from/to）。 */
  range: UsageRange | "custom";
  /** custom 模式的区间端点（YYYY-MM-DD）；range 模式忽略（后端同样忽略）。 */
  from?: string;
  to?: string;
  /** range 模式必传：与前端桶窗口公式同源，缺省 0 = UTC 会让两端窗口错位。 */
  tzOffsetMin: number;
  keyId?: number;
  /** 仅 admin 可传（成员端 schema 无此字段）。 */
  userId?: number;
  /** 状态筛选：只给明细一路（D3 —— 图表不随明细筛选变化）。 */
  status?: "success" | "error" | "cached" | "rejected";
  limit: number;
  offset: number;
}

export interface UsageReport {
  /** 时间桶聚合：两行柱状图共用（range 模式 24/24/14/30 桶，custom 模式按天）。 */
  buckets: UsageAggregate[];
  /** 按模型聚合：成本环形图（Top5 + Other 在页面里构造）。 */
  byModel: UsageAggregate[];
  /** 按状态聚合：状态环形图（键为状态枚举，缺状态由页面补 0）。 */
  byStatus: UsageAggregate[];
  /** 明细（唯一带 status 过滤的一路）。 */
  details: UsageDetail[];
  total: number;
  /** 图表侧（1/2/3）加载中 —— 明细侧刻意不计入：否则翻页/筛状态会让整块图表闪加载态。 */
  isLoading: boolean;
  /** 图表侧任一失败（页面级错误态）。 */
  isError: boolean;
  error: Error | null;
  /** 明细侧加载中/失败单独暴露：混用会让「明细在加载」显示成「没有请求」。 */
  detailsLoading: boolean;
  detailsError: Error | null;
  /** 重取全部 4 路。 */
  refetch: () => void;
}

/** 稳定空数组：数据未就绪时返回它，避免每次渲染新建引用使页面的 useMemo 失效。 */
const EMPTY_AGGREGATES: UsageAggregate[] = [];
const EMPTY_DETAILS: UsageDetail[] = [];

/**
 * 按角色分发到 useUsage / useAdminUsage。
 * 两个 hook 必须都调用（Hooks 规则），只能靠 `enabled` 关掉不用的那一路。
 */
function useRoleUsageQuery(params: UsageParams, isAdmin: boolean, userId: number | undefined) {
  const meQuery = useUsage(isAdmin ? { ...params, enabled: false } : params);
  const adminQuery = useAdminUsage(isAdmin ? { ...params, userId } : { ...params, enabled: false });
  return isAdmin ? adminQuery : meQuery;
}

export function useUsageReport({
  isAdmin,
  range,
  from,
  to,
  tzOffsetMin,
  keyId,
  userId,
  status,
  limit,
  offset,
}: UsageReportParams): UsageReport {
  const isRangeMode = range !== "custom";
  // 窗口参数：range 模式传 range + tzOffsetMin（后端据此选窗口）；custom 模式传 from/to。
  // custom 模式的两路聚合显式 groupBy=date —— 与既有页面一致（聚合发生在 usage_daily 上）。
  const windowParams: UsageParams = isRangeMode
    ? { range, tzOffsetMin }
    : { from, to, groupBy: "date" };

  const bucketsQuery = useRoleUsageQuery({ ...windowParams, keyId, limit: 1 }, isAdmin, userId);
  const byModelQuery = useRoleUsageQuery(
    { ...windowParams, keyId, groupBy: "model", limit: 1 },
    isAdmin,
    userId,
  );
  const byStatusQuery = useRoleUsageQuery(
    { ...windowParams, keyId, groupBy: "status", limit: 1 },
    isAdmin,
    userId,
  );
  const detailsQuery = useRoleUsageQuery(
    { ...windowParams, keyId, status, limit, offset },
    isAdmin,
    userId,
  );

  return {
    buckets: bucketsQuery.data?.aggregates ?? EMPTY_AGGREGATES,
    byModel: byModelQuery.data?.aggregates ?? EMPTY_AGGREGATES,
    byStatus: byStatusQuery.data?.aggregates ?? EMPTY_AGGREGATES,
    details: detailsQuery.data?.details ?? EMPTY_DETAILS,
    total: detailsQuery.data?.total ?? 0,
    isLoading: bucketsQuery.isLoading || byModelQuery.isLoading || byStatusQuery.isLoading,
    isError: bucketsQuery.isError || byModelQuery.isError || byStatusQuery.isError,
    error: bucketsQuery.error ?? byModelQuery.error ?? byStatusQuery.error,
    detailsLoading: detailsQuery.isLoading,
    detailsError: detailsQuery.error,
    refetch: () => {
      void bucketsQuery.refetch();
      void byModelQuery.refetch();
      void byStatusQuery.refetch();
      void detailsQuery.refetch();
    },
  };
}
