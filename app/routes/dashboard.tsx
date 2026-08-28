// /dashboard — 概览页（M6 6.3）：余额、Key 数量、用量趋势图、最近请求。
import { useMemo } from "react";
import { Link } from "react-router";
import { KeyRound, TrendingUp, Wallet, Zap } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { useUsage } from "@/modules/usage/hooks/use-usage";
import { useKeys } from "@/modules/keys/hooks/use-keys";
import { formatNumber, formatUsd, formatDateTime, formatShortDate } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { BarChart } from "@/components/charts/bar-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ErrorState, EmptyState } from "@/components/ui/states";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between pt-6">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <span className="rounded-md bg-primary/10 p-2 text-primary" aria-hidden="true">
          {icon}
        </span>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useSession();
  const usageQuery = useUsage({ groupBy: "date", limit: 7 });
  const keysQuery = useKeys();

  const { aggregates, details } = useMemo(() => {
    const data = usageQuery.data;
    return { aggregates: data?.aggregates ?? [], details: data?.details ?? [] };
  }, [usageQuery.data]);

  const totals = useMemo(() => {
    let requests = 0;
    let cost = 0;
    for (const agg of aggregates) {
      requests += agg.requests;
      cost += agg.cost;
    }
    return { requests, cost, days: aggregates.length };
  }, [aggregates]);

  const chartData = useMemo(
    () =>
      aggregates.map((agg) => ({
        label: formatShortDate(agg.group ?? ""),
        value: agg.requests,
      })),
    [aggregates],
  );

  const balance = user?.balance;
  const keysCount = keysQuery.data?.items.length;

  return (
    <PageContainer>
      <PageHeader
        title="Dashboard"
        description="Usage overview for your account"
        actions={
          <Link to="/keys" className={buttonVariants()}>
            Manage keys
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Balance"
          value={balance === null || balance === undefined ? "—" : formatUsd(balance)}
          hint="Recharge in Billing"
          icon={<Wallet className="size-4" />}
        />
        <StatCard
          label="API keys"
          value={keysQuery.isLoading ? "…" : formatNumber(keysCount ?? 0)}
          hint="Active keys in your account"
          icon={<KeyRound className="size-4" />}
        />
        <StatCard
          label="Requests (30 days)"
          value={usageQuery.isLoading ? "…" : formatNumber(totals.requests)}
          hint={totals.days > 0 ? `Across ${totals.days} active days` : "No activity yet"}
          icon={<Zap className="size-4" />}
        />
        <StatCard
          label="Spend (30 days)"
          value={usageQuery.isLoading ? "…" : formatUsd(totals.cost)}
          hint="Usage cost estimate"
          icon={<TrendingUp className="size-4" />}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Requests per day</CardTitle>
            <CardDescription>Last 30 days of traffic</CardDescription>
          </CardHeader>
          <CardContent>
            {usageQuery.isLoading ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : usageQuery.isError ? (
              <ErrorState message={usageQuery.error.message} onRetry={() => usageQuery.refetch()} />
            ) : (
              <BarChart data={chartData} height={220} formatValue={formatNumber} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent requests</CardTitle>
            <CardDescription>Latest API calls</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {usageQuery.isLoading ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : details.length === 0 ? (
              <div className="px-6 pb-6">
                <EmptyState
                  title="No requests yet"
                  description="Make your first API call with one of your keys."
                />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {details.slice(0, 6).map((detail) => (
                    <TableRow key={detail.id}>
                      <TableCell className="font-medium">{detail.model ?? "—"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            detail.status === "success"
                              ? "success"
                              : detail.status === "cached"
                                ? "secondary"
                                : "destructive"
                          }
                        >
                          {detail.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatUsd(detail.cost)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(detail.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <p className={cn("mt-6 text-xs text-muted-foreground")}>
        Details are grouped by day in your local timezone; request records are UTC.
      </p>
    </PageContainer>
  );
}
