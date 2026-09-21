// /dashboard — 概览页（批次 J，2026-09-18 用户 5 点改造）。
//
// 结构自上而下：
//   ① 账户三卡（Balance / API keys / Spend）三分栏；
//   ② Time Filter 全宽**窄**卡：一行 `Filter:` + 4 个快捷窗口按钮（移动端允许换行），
//      压到 ~58px —— 故不用 CardHeader/CardContent 的标准 p-6（CardContent 的 `pt-0`
//      在 Tailwind 排序里晚于 `py-*`，传 `py-3` 盖不住它），改用普通 div 显式给内边距；
//   ③ 3 组 × 2 = 6 卡（2 行 3 列）：Spend / Requests / Tokens 各「值卡 + 柱图卡」上下成对。
//
// **本批删除**原「Requests 主题」两张卡（请求柱图大卡 + Recent requests 明细表卡）——
// 明细因此无人消费，useUsage 的 limit 收到 schema 下限 1。
//
// **两个 Spend 口径别混**：顶部那张是**账户累计消费**（全时段、独立端点、不随筛选变化），
// 6 卡区那张是**当前窗口**的消费（随 Time Filter 变）。标签上「Spend」对「Spend — Last 30 days」，
// 是用户可分辨的。
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { CircleDollarSign, Coins, Filter, KeyRound, TrendingUp, Wallet, Zap } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { useUsage } from "@/modules/usage/hooks/use-usage";
import { useLifetimeCost } from "@/modules/usage/hooks/use-lifetime-cost";
import {
  buildRangeSeries,
  getTzOffsetMin,
  rangeGranularity,
  RANGE_OPTIONS,
} from "@/modules/usage/range";
import type { UsageRange } from "@/modules/usage/types";
import { useKeys } from "@/modules/keys/hooks/use-keys";
import { formatNumber, formatNumberCompact, formatUsd, formatUsdShort } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { BarChart } from "@/components/charts/bar-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { Button, buttonVariants } from "@/components/ui/button";

/** 柱图高度：与 usage 页的 `CHART_ROW_SIZE` 同值（app/routes/usage.tsx），保持两页观感一致。 */
const CHART_HEIGHT = 152;

type RangeOption = (typeof RANGE_OPTIONS)[number];

interface MetricSpec {
  /** 同时是 buildRangeSeries 的 metric 取值。 */
  metric: "requests" | "cost" | "tokens";
  label: string;
  icon: React.ReactNode;
  /** 柱图卡标题：随窗口变化（"Spend today" / "Spend per day" …），取自 RANGE_OPTIONS。 */
  chartTitle: (option: RangeOption) => string;
  format: (value: number) => string;
}

/** 6 卡区的三组指标，**顺序即列序**（用户指定：Spend → requests → tokens）。
 *  格式化函数与 usage 页同名柱图一致（消费走 min2/max3 的紧凑美元、tokens 走紧凑计数）。 */
const METRICS: MetricSpec[] = [
  {
    metric: "cost",
    label: "Spend",
    icon: <CircleDollarSign className="size-4" />,
    chartTitle: (o) => o.costTitle,
    format: formatUsdShort,
  },
  {
    metric: "requests",
    label: "Requests",
    icon: <Zap className="size-4" />,
    chartTitle: (o) => o.title,
    format: formatNumber,
  },
  {
    metric: "tokens",
    label: "Tokens",
    icon: <Coins className="size-4" />,
    chartTitle: (o) => o.tokensTitle,
    format: formatNumberCompact,
  },
];

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
  const [range, setRange] = useState<UsageRange>("last30");
  // 时区快照与查询参数同源（模块加载时计算一次；窗口边界与桶构建共用）
  const tzOffsetMin = useMemo(() => getTzOffsetMin(), []);
  // 桶窗口时刻快照：与发起查询同时刻，且 range 切换时刷新（否则跨本地午夜后
  // useMemo 重算会取新 Date.now() → 桶窗口偏移一天，与后端窗口错位）
  const [nowMs, setNowMs] = useState(() => Date.now());
  // limit 取 schema 下限：本页只用聚合，明细（details）自 Recent requests 卡删除后已无消费方
  const usageQuery = useUsage({ range, tzOffsetMin, limit: 1 });
  const lifetimeQuery = useLifetimeCost();
  const keysQuery = useKeys();

  const aggregates = useMemo(() => usageQuery.data?.aggregates ?? [], [usageQuery.data]);

  // 三组指标共用同一条桶窗口（buildRangeSeries 按 metric 取列）——桶边界逐桶对齐
  const metricCards = useMemo(
    () =>
      METRICS.map((spec) => {
        const series = buildRangeSeries(aggregates, range, tzOffsetMin, nowMs, spec.metric);
        return {
          spec,
          series,
          // 值卡 = 柱图逐桶求和：两者**构造上同源**，不会出现「卡上一个数、柱子加起来另一个数」
          total: series.reduce((sum, datum) => sum + datum.value, 0),
        };
      }),
    [aggregates, range, tzOffsetMin, nowMs],
  );

  // find 必中（range 来自 RANGE_OPTIONS 枚举）；noUncheckedIndexedAccess 下数组索引可能 undefined，用 as 收敛
  const rangeMeta =
    RANGE_OPTIONS.find((o) => o.value === range) ?? (RANGE_OPTIONS[3] as RangeOption);

  const balance = user?.balance;
  // 用 total 而非 items.length：useKeys 默认 limit=50，Key 多时长度会截断
  const keysCount = keysQuery.data?.total;
  const lifetimeCost = lifetimeQuery.data?.totalCost;

  // 活跃桶的措辞随窗口粒度变：today/yesterday 是小时桶，不能写成 "active days"
  const activeUnit = rangeGranularity(range) === "hour" ? "hours" : "days";
  const activeHint =
    aggregates.length > 0 ? `Across ${aggregates.length} active ${activeUnit}` : "No activity yet";

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

      {/* ① 账户三卡：Spend 是**累计消费**（全时段），与下方窗口消费不同口径 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
          label="Spend"
          value={
            lifetimeQuery.isLoading
              ? "…"
              : lifetimeCost === undefined
                ? "—" // 请求失败：不拿 $0.00 冒充「没花过钱」
                : formatUsd(lifetimeCost)
          }
          hint="All-time usage charges"
          icon={<TrendingUp className="size-4" />}
        />
      </div>

      {/* ② Time Filter：全宽窄卡，一行 4 个按钮（移动端 flex-wrap 换行） */}
      <Card className="mt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-3">
          <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Filter className="size-4 text-primary" aria-hidden="true" />
            Filter:
          </span>
          {RANGE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant={range === option.value ? "default" : "outline"}
              size="sm"
              aria-pressed={range === option.value}
              onClick={() => {
                setRange(option.value);
                // 切换窗口 = 新查询时刻：同步刷新桶窗口快照（跨午夜不错位）
                setNowMs(Date.now());
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </Card>

      {/* ③ 6 卡区：3 组 × 2（值卡在上、柱图在下），2 行 3 列。
          错误态**整块替换**而不是每卡各报一次 —— 三张图同源同一路失败，重复三遍是噪音。 */}
      {usageQuery.isError ? (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <ErrorState
              message={usageQuery.error.message}
              onRetry={() => void usageQuery.refetch()}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {metricCards.map(({ spec, series, total }) => (
            <div key={spec.metric} className="flex flex-col gap-4">
              <StatCard
                label={`${spec.label} — ${rangeMeta.label}`}
                value={usageQuery.isLoading ? "…" : spec.format(total)}
                hint={activeHint}
                icon={spec.icon}
              />
              <Card className="flex flex-1 flex-col">
                <CardHeader>
                  <CardTitle>{spec.chartTitle(rangeMeta)}</CardTitle>
                  {/* 副标题显示**本窗口合计**（批次 L，2026-09-21 用户裁决）。
                      原副标题是 "Daily request count over the last 30 days" 这类**复述标题**的话
                      （标题已是 "Requests per day"），按用户「删除冗余的文字描述」改掉。
                      格式各按本指标现用 format，与上方值卡**同一个数、同一串字符**。 */}
                  <CardDescription>
                    {usageQuery.isLoading ? "…" : `${spec.format(total)} total`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {/* dense：本卡内容盒仅 ~270~310px 而桶有 24~30 个，常规柱宽/间距会撑出横向滚动 */}
                  <BarChart
                    data={series}
                    height={CHART_HEIGHT}
                    formatValue={spec.format}
                    dense
                  />
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        Quick ranges are bucketed in your local timezone; all-time spend is shown without a time
        filter.
      </p>
    </PageContainer>
  );
}
