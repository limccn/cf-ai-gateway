// /usage — 用量报表页（M6 6.3）：时间/Key/模型/用户（admin）筛选，
// 按日期柱状图 / 按模型环形图，明细分页表格。
import { useMemo, useState } from "react";
import { Filter, RefreshCw } from "lucide-react";
import type { UsageGroupBy } from "@/modules/usage/types";
import { useUsage } from "@/modules/usage/hooks/use-usage";
import { useAdminUsage } from "@/modules/usage/hooks/use-admin-usage";
import type { UsageParams } from "@/modules/usage/hooks/usage-params";
import { useKeys } from "@/modules/keys/hooks/use-keys";
import { useUsers } from "@/modules/users/hooks/use-users";
import { useSession } from "@/hooks/use-session";
import { formatDateOnly, formatDateTime, formatNumber, formatShortDate, formatUsd } from "@/lib/format";
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

export default function UsagePage() {
  const { user } = useSession();
  const isAdmin = user?.role === "admin";

  // ===== 筛选状态（点击 Apply 后才写入查询） =====
  const [fromDraft, setFromDraft] = useState(daysAgoParam(30));
  const [toDraft, setToDraft] = useState(toDateParam(new Date()));
  const [keyIdDraft, setKeyIdDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [userIdDraft, setUserIdDraft] = useState("");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("date");

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

  const queryParams: UsageParams = {
    from: filters.from,
    to: filters.to,
    keyId: filters.keyId,
    model: filters.model,
    groupBy,
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
    setFilters({ from: daysAgoParam(30), to: toDateParam(new Date()), keyId: undefined, model: undefined, userId: undefined });
    setOffset(0);
  };

  const switchGroupBy = (next: UsageGroupBy) => {
    setGroupBy(next);
    setOffset(0);
  };

  const keys = keysQuery.data?.items ?? [];
  const users = usersQuery.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const currentPage = Math.floor(offset / LIMIT) + 1;

  const chartData = useMemo(() => {
    if (groupBy === "model") {
      return aggregates
        .filter((agg) => agg.group !== null)
        .map((agg, index) => ({
          label: agg.group ?? "unknown",
          value: agg.cost,
          color: CHART_COLORS[index % CHART_COLORS.length] ?? "hsl(var(--primary))",
        }));
    }
    return aggregates
      .filter((agg) => agg.group !== null)
      .map((agg, index) => ({
        label: formatShortDate(agg.group ?? ""),
        value: agg.requests,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? "hsl(var(--primary))",
      }));
  }, [aggregates, groupBy]);

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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="usage-from">From</Label>
              <Input
                id="usage-from"
                type="date"
                value={fromDraft}
                onChange={(e) => setFromDraft(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="usage-to">To</Label>
              <Input
                id="usage-to"
                type="date"
                value={toDraft}
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
          onClick={() => switchGroupBy("date")}
        >
          Date
        </Button>
        <Button
          variant={groupBy === "model" ? "default" : "outline"}
          size="sm"
          onClick={() => switchGroupBy("model")}
        >
          Model
        </Button>
      </div>

      {usageQuery.isLoading ? (
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : usageQuery.isError ? (
        <ErrorState message={usageQuery.error.message} onRetry={() => usageQuery.refetch()} />
      ) : (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>
              {groupBy === "date" ? "Requests per day" : "Cost by model"}
            </CardTitle>
            <CardDescription>
              {formatDateOnly(filters.from ?? "")} – {formatDateOnly(filters.to ?? "")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {aggregates.length === 0 ? (
              <EmptyState title="No usage in this period" description="Try widening the date range or clearing filters." />
            ) : groupBy === "date" ? (
              <BarChart data={chartData} height={240} formatValue={formatNumber} />
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
          <div className="flex gap-2">
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
                    <TableHead>Key</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {details.map((detail) => (
                    <TableRow key={detail.id}>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(detail.createdAt)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
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
                      <TableCell className="text-muted-foreground">
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
