// /usage — 用量报表页（M6 6.3）：时间/Key/模型/用户（admin）筛选，
// 按日期柱状图 / 按模型环形图，明细分页表格。
import { useMemo, useState } from "react";
import { Filter, RefreshCw } from "lucide-react";
import type { UsageGroupBy, UsageRange } from "@/modules/usage/types";
import { useUsage } from "@/modules/usage/hooks/use-usage";
import { useAdminUsage } from "@/modules/usage/hooks/use-admin-usage";
import { buildRangeSeries, getTzOffsetMin, RANGE_OPTIONS } from "@/modules/usage/range";
import type { UsageParams } from "@/modules/usage/hooks/usage-params";
import { useKeys } from "@/modules/keys/hooks/use-keys";
import { useUsers } from "@/modules/users/hooks/use-users";
import { useSession } from "@/hooks/use-session";
import { useIsMobile } from "@/hooks/use-media-query";
import { formatDateOnly, formatDateTime, formatDateTimeShort, formatNumber, formatShortDate, formatUsd } from "@/lib/format";
import { daysAgoParam, toDateParam } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { BarChart } from "@/components/charts/bar-chart";
import { DonutChart, CHART_COLORS } from "@/components/charts/donut-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ErrorState, EmptyState } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const LIMIT = 20;

// 状态语义色（与明细 Badge 配色一致）：success 绿 / cached 黄 / error 红 / rejected 灰
const STATUS_COLORS: Record<string, string> = {
  success: "hsl(142 71% 45%)",
  cached: "hsl(38 92% 50%)",
  error: "hsl(0 84% 60%)",
  rejected: "hsl(var(--muted-foreground))",
};

// 快捷维度 chips（RANGE_OPTIONS + 自定义）：label/title/desc 复用 RANGE_OPTIONS
const RANGE_CHOICES: Array<{ value: UsageRange | "custom"; label: string }> = [
  ...RANGE_OPTIONS.map(({ value, label }) => ({ value, label })),
  { value: "custom", label: "Custom" },
];

export default function UsagePage() {
  const { user } = useSession();
  const isAdmin = user?.role === "admin";
  const isMobile = useIsMobile();

  // ===== 筛选状态（点击 Apply 后才写入查询） =====
  const [fromDraft, setFromDraft] = useState(daysAgoParam(30));
  const [toDraft, setToDraft] = useState(toDateParam(new Date()));
  const [keyIdDraft, setKeyIdDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [userIdDraft, setUserIdDraft] = useState("");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("date");
  // 快捷维度：today/yesterday/last14/last30 与自定义（custom=from/to+groupBy）互斥
  const [range, setRange] = useState<UsageRange | "custom">("last30");
  // 时区快照与查询参数同源（模块加载时计算一次；窗口边界与桶构建共用）
  const tzOffsetMin = useMemo(() => getTzOffsetMin(), []);
  // 明细状态筛选：仅过滤 request_logs（明细 + hour/status 聚合）；date/model 聚合不受影响
  const [status, setStatus] = useState<"all" | "success" | "error" | "cached" | "rejected">("all");

  const [filters, setFilters] = useState<{
    from: string | undefined;
    to: string | undefined;
    keyId: number | undefined;
    model: string | undefined;
    userId: number | undefined;
  }>({ from: daysAgoParam(30), to: toDateParam(new Date()), keyId: undefined, model: undefined, userId: undefined });

  const [offset, setOffset] = useState(0);

  const keysQuery = useKeys();
  const usersQuery = useUsers(isAdmin ? { limit: 100 } : { limit: 1, enabled: false });

  const isRangeMode = range !== "custom";
  const queryParams: UsageParams = {
    // 快捷维度模式：range+tzOffsetMin 优先（后端忽略 from/to/groupBy）；自定义模式照常
    ...(isRangeMode ? { range, tzOffsetMin } : { from: filters.from, to: filters.to, groupBy }),
    keyId: filters.keyId,
    model: filters.model,
    status: status === "all" ? undefined : status,
    limit: LIMIT,
    offset,
  };

  // 两个 hook 始终调用（React Hooks 规则），仅启用其一
  const meQuery = useUsage(isAdmin ? { ...queryParams, enabled: false } : queryParams);
  const adminQuery = useAdminUsage(
    isAdmin ? { ...queryParams, userId: filters.userId } : { ...queryParams, enabled: false },
  );
  const usageQuery = isAdmin ? adminQuery : meQuery;

  const { aggregates, details, total } = useMemo(() => {
    const data = usageQuery.data;
    return {
      aggregates: data?.aggregates ?? [],
      details: data?.details ?? [],
      total: data?.total ?? 0,
    };
  }, [usageQuery.data]);

  const applyFilters = () => {
    setFilters({
      from: fromDraft || undefined,
      to: toDraft || undefined,
      keyId: keyIdDraft ? Number(keyIdDraft) : undefined,
      model: modelDraft || undefined,
      userId: userIdDraft ? Number(userIdDraft) : undefined,
    });
    setOffset(0);
  };

  const resetFilters = () => {
    setFromDraft(daysAgoParam(30));
    setToDraft(toDateParam(new Date()));
    setKeyIdDraft("");
    setModelDraft("");
    setUserIdDraft("");
    setGroupBy("date");
    setRange("last30");
    setStatus("all");
    setFilters({ from: daysAgoParam(30), to: toDateParam(new Date()), keyId: undefined, model: undefined, userId: undefined });
    setOffset(0);
  };

  const switchGroupBy = (next: UsageGroupBy) => {
    setGroupBy(next);
    setOffset(0);
  };

  const switchRange = (next: UsageRange | "custom") => {
    setRange(next);
    setOffset(0);
  };

  const keys = keysQuery.data?.items ?? [];
  const users = usersQuery.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const currentPage = Math.floor(offset / LIMIT) + 1;

  const chartData = useMemo(() => {
    if (isRangeMode) {
      // 快捷维度：固定桶（24/24/14/30），缺数据补 0；color 供 BarChart/DonutChart 统一类型
      return buildRangeSeries(aggregates, range, tzOffsetMin).map((point, index) => ({
        ...point,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? "hsl(var(--primary))",
      }));
    }
    if (groupBy === "model") {
      return aggregates
        .filter((agg) => agg.group !== null)
        .map((agg, index) => ({
          label: agg.group ?? "unknown",
          value: agg.cost,
          color: CHART_COLORS[index % CHART_COLORS.length] ?? "hsl(var(--primary))",
        }));
    }
    if (groupBy === "status") {
      // 后端只返回有数据的桶；补 0 段，donut 颜色语义稳定
      return (["success", "cached", "error", "rejected"] as const)
        .map((s) => ({
          label: s,
          value: aggregates.find((agg) => agg.group === s)?.requests ?? 0,
          color: STATUS_COLORS[s] ?? "hsl(var(--primary))",
        }));
    }
    return aggregates
      .filter((agg) => agg.group !== null)
      .map((agg, index) => ({
        label: formatShortDate(agg.group ?? ""),
        value: agg.requests,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? "hsl(var(--primary))",
      }));
  }, [aggregates, groupBy, isRangeMode, range, tzOffsetMin]);

  const rangeMeta = isRangeMode ? RANGE_OPTIONS.find((o) => o.value === range) : undefined;
  const chartTitle = isRangeMode
    ? (rangeMeta?.title ?? "Requests")
    : groupBy === "date"
      ? "Requests per day"
      : groupBy === "model"
        ? "Cost by model"
        : "Requests by status";
  const chartDesc = isRangeMode
    ? (rangeMeta?.desc ?? "")
    : `${formatDateOnly(filters.from ?? "")} – ${formatDateOnly(filters.to ?? "")}`;

  return (
    <PageContainer>
      <PageHeader title="Usage" description="Request volumes, costs and request details" />

      {/* 筛选栏 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="size-4 text-primary" aria-hidden="true" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {RANGE_CHOICES.map((option) => (
              <Button
                key={option.value}
                variant={range === option.value ? "default" : "outline"}
                size="sm"
                onClick={() => switchRange(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="usage-from">From</Label>
              <Input
                id="usage-from"
                type="date"
                value={fromDraft}
                disabled={isRangeMode}
                onChange={(e) => setFromDraft(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="usage-to">To</Label>
              <Input
                id="usage-to"
                type="date"
                value={toDraft}
                disabled={isRangeMode}
                onChange={(e) => setToDraft(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="usage-key">API key</Label>
              <Select
                id="usage-key"
                value={keyIdDraft}
                onChange={(e) => setKeyIdDraft(e.target.value)}
              >
                <option value="">All keys</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.prefix})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="usage-model">Model</Label>
              <Input
                id="usage-model"
                placeholder="e.g. gpt-4o"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
              />
            </div>
            {isAdmin ? (
              <div className="space-y-2 sm:col-span-2 lg:col-span-4">
                <Label htmlFor="usage-user">User (admin)</Label>
                <Select
                  id="usage-user"
                  value={userIdDraft}
                  onChange={(e) => setUserIdDraft(e.target.value)}
                >
                  <option value="">All users</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Button onClick={applyFilters}>Apply</Button>
            <Button variant="outline" onClick={resetFilters}>
              <RefreshCw aria-hidden="true" />
              Reset
            </Button>
            {isAdmin ? null : (
              <span className="text-xs text-muted-foreground">
                Showing usage for your account only.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 图表 */}
      <div className="mb-6 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Group by</span>
        <Button
          variant={groupBy === "date" ? "default" : "outline"}
          size="sm"
          disabled={isRangeMode}
          onClick={() => switchGroupBy("date")}
        >
          Date
        </Button>
        <Button
          variant={groupBy === "model" ? "default" : "outline"}
          size="sm"
          disabled={isRangeMode}
          onClick={() => switchGroupBy("model")}
        >
          Model
        </Button>
        <Button
          variant={groupBy === "status" ? "default" : "outline"}
          size="sm"
          disabled={isRangeMode}
          onClick={() => switchGroupBy("status")}
        >
          Status
        </Button>
        {isRangeMode ? (
          <span className="text-xs text-muted-foreground">Quick ranges use fixed date buckets</span>
        ) : null}
      </div>

      {usageQuery.isLoading ? (
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : usageQuery.isError ? (
        <ErrorState message={usageQuery.error.message} onRetry={() => usageQuery.refetch()} />
      ) : (
        <Card className="mb-6">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>{chartTitle}</CardTitle>
              <CardDescription>{chartDesc}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {aggregates.length === 0 ? (
              <EmptyState title="No usage in this period" description="Try widening the date range or clearing filters." />
            ) : isRangeMode || groupBy === "date" ? (
              <BarChart data={chartData} height={240} formatValue={formatNumber} />
            ) : groupBy === "status" ? (
              <DonutChart data={chartData} formatValue={formatNumber} />
            ) : (
              <DonutChart data={chartData} formatValue={formatUsd} />
            )}
          </CardContent>
        </Card>
      )}

      {/* 明细 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Request details</CardTitle>
            <CardDescription>
              {formatNumber(total)} total — page {currentPage} of {totalPages}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select
              id="usage-status"
              aria-label="Status filter"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                setOffset(0);
              }}
              className="w-36"
            >
              <option value="all">All statuses</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
              <option value="cached">Cached</option>
              <option value="rejected">Rejected</option>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + LIMIT >= total}
              onClick={() => setOffset(offset + LIMIT)}
            >
              Next
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {details.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState title="No requests found" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead className="hidden sm:table-cell">Key</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {details.map((detail) => (
                    <TableRow key={detail.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {isMobile
                          ? formatDateTimeShort(detail.createdAt)
                          : formatDateTime(detail.createdAt)}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                        {detail.keyId ?? "—"}
                      </TableCell>
                      <TableCell className="font-medium">{detail.model ?? "—"}</TableCell>
                      <TableCell>
                        {formatNumber(detail.promptTokens)} / {formatNumber(detail.completionTokens)}
                      </TableCell>
                      <TableCell>{formatUsd(detail.cost)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            detail.status === "success"
                              ? "success"
                              : detail.status === "cached"
                                ? "secondary"
                                : detail.status === "rejected"
                                  ? "outline"
                                  : "destructive"
                          }
                        >
                          {detail.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {detail.latencyMs === null ? "—" : `${formatNumber(detail.latencyMs)}ms`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
