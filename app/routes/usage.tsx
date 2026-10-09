// /usage — 用量报表页（09-14 批次 A 改造）：筛选即选即查，成本 / 请求 / tokens 三行图表卡
// （各 1/2 柱状图 + 1/2 环形图，2026-09-18 批次 H 由「2/3 + 1/3」改为对半分）+ 明细分页表格。
//
// 与旧版的差别（裁决理由见任务 design.md）：
//   - 筛选即选即查：没有 Apply/Reset 与草稿态，控件直接写查询参数；Time / API key / User
//     变更走 updateFilters()（刷新桶窗口快照 + 回第一页），状态筛选与翻页只回第一页 /
//     改 offset（快照与请求必须同刻，判据见 updateFilters 的注释）；
//   - 时间维度收成一个下拉（默认 Today，含 Custom）：Custom 的 From/To 收进 Popover，
//     关闭时只留一行文本触发器，不再占满整行两个输入框；模型筛选入口移除
//     （model 只作聚合维度；后端参数保留，属契约面）；
//   - 图表从「一个可切维度的大图」改为三张固定维度的卡：groupBy 是单值参数、
//     一次请求只能给一种聚合，故四路查询在 use-usage-report 里编排；
//   - 三张柱状图共用同一套桶窗口（buildRangeSeries 按 metric 取列），tokens 取
//     `tokensIn + tokensOut`；tokens 环形图是同批聚合的 input / output 两段切分
//     （cached 未落库，见 modules/usage/series.ts，2026-09-18 用户裁决不做迁移）；
//   - 状态筛选只作用于明细查询（D3）：图表不随它变化，也修掉「range 模式筛状态会连带
//     改变柱状图、custom 模式不会」的既存不一致。
import { useMemo, useState } from "react";
import { CalendarDays, Filter } from "lucide-react";
import type { UsageRange } from "@/modules/usage/types";
import { useUsageReport } from "@/modules/usage/hooks/use-usage-report";
import { buildRangeSeries, getTzOffsetMin, RANGE_OPTIONS } from "@/modules/usage/range";
import { buildModelCostSeries, buildTokenSplitSeries } from "@/modules/usage/series";
import { useKeys } from "@/modules/keys/hooks/use-keys";
import { useUsers } from "@/modules/users/hooks/use-users";
import { useSession } from "@/hooks/use-session";
import { useIsMobile } from "@/hooks/use-media-query";
import {
  daysAgoParam,
  formatDateOnly,
  formatDateTime,
  formatDateTimeShort,
  formatNumber,
  formatNumberCompact,
  formatShortDate,
  formatUsd,
  formatUsdShort,
  toDateParam,
} from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { BarChart } from "@/components/charts/bar-chart";
import { DonutChart, CHART_COLORS } from "@/components/charts/donut-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
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

/** Popover 面板尺寸常量（w-72；两个 Label + h-9 日期输入 + p-3 的内高）：
 *  定位算术的输入，同时是面板的 inline 尺寸 —— 面板在坐标算出前不渲染，无法测量自身。
 *  高度 158 是 1440×900 实测值（两个 Label 20 + 间距 8 + 输入 36 的两组 + 组间距 12 + 内边距 24），
 *  只参与「上下翻转」与 maxHeight 判定；真实高度仍由 CSS 决定。 */
const RANGE_POPOVER_PANEL = { width: 288, height: 158 };

/** 状态环形图的固定段序：缺项补 0，颜色语义不随数据抖动（design §6）。 */
const STATUS_ORDER = ["success", "cached", "error", "rejected"] as const;

// 状态语义色（与明细 Badge 配色一致）：success 绿 / cached 黄 / error 红 / rejected 灰
const STATUS_COLORS: Record<string, string> = {
  success: "hsl(142 71% 45%)",
  cached: "hsl(38 92% 50%)",
  error: "hsl(0 84% 60%)",
  rejected: "hsl(var(--muted-foreground))",
};

/** 三行卡的「柱状图高度」与「环形图 size」共用同一值 —— 同一行内两者等高是**刻意的视觉契约**
 *  （2026-09-18 用户裁决：柱状图原为 240，比同排环图高出一大截）。抽成一个常量是为了让
 *  「柱高 = 环图尺寸」这件事只有一个来源，将来改高度不会只改一边。
 *
 *  为什么取 152：环形图的 `size` 是**上限**而非定值（donut-chart.tsx 按容器宽反算
 *  `min(size, max(80, 内容盒 − 118 − 24))`）。二分栏（批次 H）后每列内容盒实测
 *  ≥425px（1280）→ 算得 283 > 152，上限恒先生效 ⇒ **≥1280 的任意宽度下环图都渲染成 152**，
 *  与柱图严格等高。页面在最大宽度容器下 1920/1600/1440 三档内容盒完全相同（实测 726 / 350），
 *  1440 起即进入稳态。
 *
 *  **批次 H（2026-09-18）前的历史**：三分栏时代环图列内容盒只有 259.7px（1280）→ 算得
 *  117.7 < 152，被图例挤小（实测 1366 → 146.3、1280 → 117.7），该段柱图比环图高 34px。
 *  用户裁决「直接 3 分栏改为 2 分栏，bar 图和环图对半分」，加宽环图列后这个坏带消失 ——
 *  这是**改布局**而非「让柱高跟随环图」，故不需要跨卡测量。
 *  唯一残存的挤小档是**手机单列**（375 内容盒 ≈214px，算出 80 = 下限），见 implement.md 记录。 */
const CHART_ROW_SIZE = 152;

export default function UsagePage() {
  const { user } = useSession();
  const isAdmin = user?.role === "admin";
  const isMobile = useIsMobile();

  // ===== 筛选（即选即查：无草稿态，控件直接写这里） =====
  const [range, setRange] = useState<UsageRange | "custom">("today");
  // Custom 区间：默认最近 30 天（先给可用初值，切到 Custom 即有结果）；两端都可被清空
  const [from, setFrom] = useState(() => daysAgoParam(30));
  const [to, setTo] = useState(() => toDateParam(new Date()));
  const [keyId, setKeyId] = useState<number | undefined>(undefined);
  const [userId, setUserId] = useState<number | undefined>(undefined);
  // 明细状态筛选：只提交给明细查询（D3）
  const [status, setStatus] = useState<"all" | "success" | "error" | "cached" | "rejected">("all");
  // 时区快照与查询参数同源（模块加载时计算一次；窗口边界与桶构建共用）
  const tzOffsetMin = useMemo(() => getTzOffsetMin(), []);
  // 桶窗口时刻快照：必须与发起查询同时刻。后端在请求时刻自取 Date.now()，
  // 前端若跨本地午夜后 useMemo 重算取新快照，桶窗口会整体偏移一天、与后端错位。
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);

  const keysQuery = useKeys();
  const usersQuery = useUsers(isAdmin ? { limit: 100 } : { limit: 1, enabled: false });

  const report = useUsageReport({
    isAdmin,
    range,
    // 清空的端点按「不限」处理（原生 date 输入可被清空；传 "" 会被 schema 判为非法日期）
    from: from || undefined,
    to: to || undefined,
    tzOffsetMin,
    keyId,
    userId,
    status: status === "all" ? undefined : status,
    limit: LIMIT,
    offset,
  });

  /** 筛选变更统一入口：刷新桶窗口快照 + 回第一页。
   *  判据是「这一改会不会让**图表三路**重取」（Time / API key / User 在图表查询键里，会）。
   *  分页与状态筛选只重取明细（status 不在图表键里），走这里反而会让前端桶窗口脱离
   *  后端**已取**窗口：跨本地午夜时桶键整体偏移一天，`buildRangeSeries` 按桶键查不到值 → 图整片归零。
   *  故这两条路径只 `setOffset(0)`（沿用旧页 status 的处置）。 */
  const updateFilters = () => {
    setNowMs(Date.now());
    setOffset(0);
  };

  // range 模式的窗口值（custom 时 undefined）：查 RANGE_OPTIONS 与建桶都要窄化后的类型
  const usageRange: UsageRange | undefined = range === "custom" ? undefined : range;
  const rangeMeta = usageRange ? RANGE_OPTIONS.find((o) => o.value === usageRange) : undefined;

  // 三张柱状图（请求 / 成本 / tokens）：range 模式共用同一套固定桶公式（桶边界必须逐桶对齐），
  // custom 模式按天后端已排序
  const requestsSeries = useMemo(() => {
    if (usageRange) {
      return buildRangeSeries(report.buckets, usageRange, tzOffsetMin, nowMs, "requests");
    }
    return report.buckets
      .filter((agg) => agg.group !== null)
      .map((agg) => ({ label: formatShortDate(agg.group ?? ""), value: agg.requests }));
  }, [usageRange, report.buckets, tzOffsetMin, nowMs]);

  const costSeries = useMemo(() => {
    if (usageRange) {
      return buildRangeSeries(report.buckets, usageRange, tzOffsetMin, nowMs, "cost");
    }
    return report.buckets
      .filter((agg) => agg.group !== null)
      .map((agg) => ({ label: formatShortDate(agg.group ?? ""), value: agg.cost }));
  }, [usageRange, report.buckets, tzOffsetMin, nowMs]);

  // tokens 柱状图：取「输入 + 输出」，与 tokens 环形图两段之和同口径（09-14 批次 B）
  const tokensSeries = useMemo(() => {
    if (usageRange) {
      return buildRangeSeries(report.buckets, usageRange, tzOffsetMin, nowMs, "tokens");
    }
    return report.buckets
      .filter((agg) => agg.group !== null)
      .map((agg) => ({
        label: formatShortDate(agg.group ?? ""),
        value: agg.tokensIn + agg.tokensOut,
      }));
  }, [usageRange, report.buckets, tzOffsetMin, nowMs]);

  // 模型成本环形图：Top5 + Other models。颜色在这里配（series.ts 不引 .tsx，见其文件头），
  // Other 用 muted 灰 —— 它不是某个模型，不该占用调色板语义色。
  const modelSeries = useMemo(
    () =>
      buildModelCostSeries(report.byModel).map((datum, index) => ({
        ...datum,
        color: datum.isOther
          ? "hsl(var(--muted-foreground))"
          : (CHART_COLORS[index % CHART_COLORS.length] ?? "hsl(var(--primary))"),
      })),
    [report.byModel],
  );

  // tokens 切分环形图：input / output 两段（D7 —— cachedTokens 未落库，本批次不做三段）。
  // 顺序由 buildTokenSplitSeries 固定，颜色在页面层按下标配（series.ts 不引 .tsx，见其文件头）。
  const tokenSplitSeries = useMemo(
    () =>
      buildTokenSplitSeries(report.buckets).map((datum, index) => ({
        ...datum,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? "hsl(var(--primary))",
      })),
    [report.buckets],
  );

  // 状态环形图：固定四段 + 后端只返回有数据的组，缺项补 0
  const statusSeries = useMemo(
    () =>
      STATUS_ORDER.map((s) => ({
        label: s,
        value: report.byStatus.find((agg) => agg.group === s)?.requests ?? 0,
        color: STATUS_COLORS[s] ?? "hsl(var(--primary))",
      })),
    [report.byStatus],
  );

  // 区间说明（custom 模式）：端点可被清空，空端用省略号占位而不是空串（" – "）
  const rangeEdge = (value: string) => (value ? formatDateOnly(value) : "…");
  const periodDesc = from || to ? `${rangeEdge(from)} – ${rangeEdge(to)}` : "All time";
  const requestsTitle = usageRange ? (rangeMeta?.title ?? "Requests") : "Requests per day";
  const requestsDesc = usageRange ? (rangeMeta?.desc ?? "") : periodDesc;
  // 用词统一为 spend（批次 J，2026-09-18）：字段名 `costTitle` 保留 —— 用户裁决只改**用户可见文案**，
  // 不动后端字段与表；改字段名属纯 churn，且会与后端 `cost` 字段名分叉。
  const costTitle = usageRange ? (rangeMeta?.costTitle ?? "Spend") : "Spend per day";
  const costDesc = usageRange ? (rangeMeta?.costDesc ?? "") : periodDesc;
  const tokensTitle = usageRange ? (rangeMeta?.tokensTitle ?? "Tokens") : "Tokens per day";
  const tokensDesc = usageRange ? (rangeMeta?.tokensDesc ?? "") : periodDesc;

  // Custom 触发器文案：两端都未选时给提示文案，只选一端时另一端用省略号
  const customRangeLabel = from || to ? `${from || "…"} – ${to || "…"}` : "Time range";

  const keys = keysQuery.data?.items ?? [];
  const users = usersQuery.data?.items ?? [];

  return (
    <PageContainer>
      <PageHeader title="Usage" description="Request volumes, spend and request details" />

      {/* 筛选栏：三个控件一行（Time → API key → User），变更即查 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="size-4 text-primary" aria-hidden="true" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="usage-range">Time</Label>
              <Select
                id="usage-range"
                value={range}
                onChange={(e) => {
                  setRange(e.target.value as UsageRange | "custom");
                  updateFilters();
                }}
              >
                {RANGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </Select>
              {/* Custom 的区间选择收进浮层，触发器留在 Time 单元格内（不是第四个控件） */}
              {range === "custom" ? (
                <Popover
                  panel={RANGE_POPOVER_PANEL}
                  panelLabel="Custom time range"
                  // 可访问名必须**包含**可见文本（WCAG 2.5.3 Label in Name）：
                  // 只写 "Custom time range" 会让语音控制用户念不出屏幕上的日期区间
                  triggerLabel={`Custom time range: ${customRangeLabel}`}
                  triggerClassName={buttonVariants({
                    variant: "outline",
                    className: "w-full justify-start font-normal",
                  })}
                  trigger={
                    <>
                      <CalendarDays aria-hidden="true" />
                      <span className="truncate">{customRangeLabel}</span>
                    </>
                  }
                >
                  {/* From/To 允许逆序（用户先改 From 再改 To）：不做本地校验拦截 ——
                      拦截会与「即选即查」冲突（改了没反应），后端 gte/lte 自然返回空集 + 空态。 */}
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="usage-from">From</Label>
                      <Input
                        id="usage-from"
                        type="date"
                        value={from}
                        onChange={(e) => {
                          setFrom(e.target.value);
                          updateFilters();
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="usage-to">To</Label>
                      <Input
                        id="usage-to"
                        type="date"
                        value={to}
                        onChange={(e) => {
                          setTo(e.target.value);
                          updateFilters();
                        }}
                      />
                    </div>
                  </div>
                </Popover>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="usage-key">API key</Label>
              <Select
                id="usage-key"
                value={keyId === undefined ? "" : String(keyId)}
                onChange={(e) => {
                  setKeyId(e.target.value ? Number(e.target.value) : undefined);
                  updateFilters();
                }}
              >
                <option value="">All keys</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.prefix})
                  </option>
                ))}
              </Select>
            </div>
            {isAdmin ? (
              <div className="space-y-2">
                <Label htmlFor="usage-user">User</Label>
                <Select
                  id="usage-user"
                  value={userId === undefined ? "" : String(userId)}
                  onChange={(e) => {
                    setUserId(e.target.value ? Number(e.target.value) : undefined);
                    updateFilters();
                  }}
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
          {isAdmin ? null : (
            <p className="mt-4 text-xs text-muted-foreground">
              Showing usage for your account only.
            </p>
          )}
        </CardContent>
      </Card>

      {/* 图表：成本行在上、请求行在下（A4/A3），每行 **1/2 柱状图 + 1/2 环形图**（批次 H）。
          grid 显式 grid-cols-1 起步：BarChart 首帧用 FALLBACK_WIDTH=640 兜底，
          不显式写单列会让窄屏先被撑开再被测量锁死（frontend/components.md 响应式契约）。
          二分栏用 **xl（1280）而非 lg（1024）**：环形图并排的宽度预算是
          `MIN_SIZE(80) + LEGEND_MIN_WIDTH(118) + gap(24) = 222px`，而 lg 正好也是侧栏出现的
          断点，1024 下**单列**内容盒就已只剩 174px（实测）→ 174 < 222 时下限获胜，
          图例被压到 70px、序列名 0 宽（**名字完全不可见**）。1280 起单列内容盒 ≈971px、
          二分栏后每列 ≈425px > 222，预算成立；1024~1279 退回单列堆叠（与平板同形态），不再有坏带。
          批次 H 之前这里是三分栏（1/3 环图列内容盒 259.7px），环图被图例挤到 117.7px、
          比 152 的柱图矮一截；改对半分后环图列宽翻倍，环图恒渲染满 152。 */}
      {report.isLoading ? (
        <div className="mb-6 flex h-64 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : report.isError ? (
        <div className="mb-6">
          <ErrorState message={report.error?.message} onRetry={report.refetch} />
        </div>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{costTitle}</CardTitle>
                <CardDescription>{costDesc}</CardDescription>
              </CardHeader>
              <CardContent>
                {report.buckets.length === 0 ? (
                  <EmptyState title="No usage in this period" />
                ) : (
                  <BarChart data={costSeries} height={CHART_ROW_SIZE} formatValue={formatUsdShort} />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Spend by model</CardTitle>
                <CardDescription>Top 5 models plus combined others</CardDescription>
              </CardHeader>
              <CardContent>
                {modelSeries.length === 0 ? (
                  <EmptyState title="No usage in this period" />
                ) : (
                  <DonutChart data={modelSeries} formatValue={formatUsdShort} size={CHART_ROW_SIZE} />
                )}
              </CardContent>
            </Card>
          </div>

          <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{requestsTitle}</CardTitle>
                <CardDescription>{requestsDesc}</CardDescription>
              </CardHeader>
              <CardContent>
                {report.buckets.length === 0 ? (
                  <EmptyState title="No usage in this period" />
                ) : (
                  <BarChart data={requestsSeries} height={CHART_ROW_SIZE} formatValue={formatNumber} />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Requests by status</CardTitle>
                <CardDescription>Share of request outcomes</CardDescription>
              </CardHeader>
              <CardContent>
                {report.byStatus.length === 0 ? (
                  <EmptyState title="No usage in this period" />
                ) : (
                  <DonutChart data={statusSeries} formatValue={formatNumber} size={CHART_ROW_SIZE} />
                )}
              </CardContent>
            </Card>
          </div>

          {/* tokens 行（B1）：柱状图取「输入 + 输出」总量，环形图按 input / output 两段切分。
              环形图数据源是 buckets（时间桶）—— 时间桶必有键，故不适用 model 那套 null 组过滤；
              两段之和恒等于柱状图各桶之和（AC13/AC14）。 */}
          <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{tokensTitle}</CardTitle>
                <CardDescription>{tokensDesc}</CardDescription>
              </CardHeader>
              <CardContent>
                {report.buckets.length === 0 ? (
                  <EmptyState title="No usage in this period" />
                ) : (
                  // 柱顶标签用紧凑格式：token 数是百万量级，完整写法在 24/30 桶下会互相重叠
                  <BarChart data={tokensSeries} height={CHART_ROW_SIZE} formatValue={formatNumberCompact} />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Tokens by direction</CardTitle>
                <CardDescription>Input and output share</CardDescription>
              </CardHeader>
              <CardContent>
                {tokenSplitSeries.length === 0 ? (
                  <EmptyState title="No usage in this period" />
                ) : (
                  // 图例空间充裕，用精确值（紧凑格式会让两段之和看起来对不上总量）
                  <DonutChart data={tokenSplitSeries} formatValue={formatNumber} size={CHART_ROW_SIZE} />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {/* 明细：status 筛选只作用于这一路查询（图表不受影响） */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Request details</CardTitle>
            <CardDescription>{formatNumber(report.total)} total</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select
              id="usage-status"
              aria-label="Status filter"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                // 只回第一页，**不**刷新桶窗口快照：status 不在图表三路的查询键里，
                // 图表不会重取（见 updateFilters 的判据注释）。
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
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {report.detailsLoading ? (
            // 明细单独一路查询：翻页 / 筛状态时只有它在加载，不能连图表一起显示加载态，
            // 也不能把「正在加载」显示成「没有请求」
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : report.detailsError ? (
            <div className="px-6 pb-6">
              <ErrorState
                title="Failed to load request details"
                message={report.detailsError.message}
                onRetry={report.refetch}
              />
            </div>
          ) : report.details.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState title="No requests found" />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead className="hidden sm:table-cell">Key</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>Spend</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden md:table-cell">Latency</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.details.map((detail) => (
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
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-6 pb-6">
                <span className="text-sm text-muted-foreground">
                  Showing {offset + 1}–{offset + report.details.length} of {report.total}
                </span>
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
                    disabled={offset + LIMIT >= report.total}
                    onClick={() => setOffset(offset + LIMIT)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 时区说明（批次 L，2026-09-21）：原先 today/yesterday 三张卡的描述各缀一句
          "(local timezone)"，同一件事复述三遍。按用户裁决摘掉，收成**页尾一条**——
          与 dashboard 页尾同款，两页口径一致。 */}
      <p className="mt-6 text-xs text-muted-foreground">
        Quick ranges are bucketed in your local timezone; a custom range uses the dates as picked.
      </p>
    </PageContainer>
  );
}
