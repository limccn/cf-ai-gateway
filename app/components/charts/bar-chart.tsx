// 轻量柱状图（自绘 SVG，无外部图表库 / CDN；spec M6.5：图表轻量方案）。
// 响应式：ResizeObserver 测容器宽度动态算柱宽（10~36px），文字固定 10px 不被缩放，
// 修复旧实现 viewBox + minWidth 压缩导致的图表失真（spec 见 fix-dashboard-display-bugs）。
// x 轴刻度：按容器宽自适应取 4~6 个（含首尾均匀采样），不随柱宽变化 —— 见 pickTickIndices。
import { useId } from "react";
import { cn } from "@/lib/utils";
import { useContainerWidth } from "@/hooks/use-container-width";

export interface BarDatum {
  label: string;
  value: number;
}

export interface BarChartProps {
  data: BarDatum[];
  height?: number;
  formatValue?: (value: number) => string;
  /** x 轴刻度数上限（默认 6）；实际值按容器宽自适应，并夹在 [MIN_TICKS, maxTicks] 内。 */
  maxTicks?: number;
  className?: string;
}

const BAR_MAX = 36;
const BAR_MIN = 10;
const BAR_GAP = 8;
const LABEL_SPACE = 28;
const VALUE_SPACE = 18;
/** 初次渲染（未测量容器宽度）的兜底宽度。 */
const FALLBACK_WIDTH = 640;
/** x 轴刻度数上限（24h 窗口下 6 个 ≈ 每 4h 一个，再密就回到拥挤）。 */
const MAX_TICKS = 6;
/** x 轴刻度数下限：容器再窄也不低于此值（24 桶窄端得 4 个 ≈ 每 6~8h 一个）。 */
const MIN_TICKS = 4;
/** 单刻度至少占用的水平空间（"00:00"/"09-14" 约 25px + 呼吸空间）。 */
const MIN_TICK_SPACING = 80;

/**
 * 在 n 个桶中挑出 k 个刻度下标（含首尾、均匀分布）。
 *
 * 为什么不是「index % every === 0」：那样在 24 桶 / every=4 时会同时出现 20 与强制的末位 23
 * （相邻 3 格），疏密不均且刻度数不可控（本应是 5 个间隔却渲染出 7 个）。含首尾均匀采样
 * 的刻度数**恒等于 k**。
 *
 * 不重不漏：`count ≤ n` 时相邻步长 `(n-1)/(count-1) ≥ 1`，`Math.round` 后严格递增，
 * 故 `Set` 不会吞掉任何下标。n=24 / k=4 得 {0, 8, 15, 23}（即 00:00/08:00/15:00/23:00）。
 */
function pickTickIndices(n: number, k: number): Set<number> {
  const count = Math.min(n, k);
  if (count <= 1) {
    return new Set([0]);
  }
  return new Set(
    Array.from({ length: count }, (_, i) => Math.round((i * (n - 1)) / (count - 1))),
  );
}

export function BarChart({
  data,
  height = 200,
  formatValue = (value) => String(value),
  maxTicks = MAX_TICKS,
  className,
}: BarChartProps) {
  const gradientId = useId();
  const [wrapperRef, containerWidth] = useContainerWidth<HTMLDivElement>();
  const chartHeight = height - VALUE_SPACE - LABEL_SPACE;
  const maxValue = Math.max(0, ...data.map((d) => d.value));

  if (data.length === 0) {
    return (
      <div className={cn("flex h-40 items-center justify-center text-sm text-muted-foreground", className)}>
        No data for this period
      </div>
    );
  }

  const n = data.length;
  // 动态柱宽：填满容器但限制在 [BAR_MIN, BAR_MAX]
  const usedWidth = containerWidth > 0 ? containerWidth : FALLBACK_WIDTH;
  const slot = (usedWidth - (n - 1) * BAR_GAP) / n;
  const barWidth = Math.max(BAR_MIN, Math.min(BAR_MAX, Math.floor(slot)));
  // 总宽 = max(容器宽, 最小柱宽自然宽)：容器过窄时横向滚动，不再压缩柱与文字
  const totalWidth = Math.max(usedWidth, n * barWidth + (n - 1) * BAR_GAP);
  // x 轴刻度：按容器宽定目标刻度数（夹在 4~6），再含首尾均匀采样。
  // 取代原先「按柱宽隔 N 个显示」的规则 —— 那条在 24 桶 / barWidth≈29 时算出 labelEvery=1，
  // 等于不抽稀，24 个标签全挤在一起（用户报的「x 轴过于密集」即此）。
  const tickCount = Math.max(
    MIN_TICKS,
    Math.min(maxTicks, Math.floor(usedWidth / MIN_TICK_SPACING)),
  );
  const tickAt = pickTickIndices(n, tickCount);
  // 数值标签在柱宽过窄时降级为 title tooltip
  const showValues = barWidth >= 14;

  return (
    <div ref={wrapperRef} className={cn("w-full overflow-x-auto", className)}>
      <svg
        role="img"
        aria-label="Usage bar chart"
        width={totalWidth}
        height={height}
        viewBox={`0 0 ${totalWidth} ${height}`}
        className="block"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.9" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        {data.map((datum, index) => {
          const ratio = maxValue > 0 ? datum.value / maxValue : 0;
          const barHeight = Math.max(ratio * chartHeight, datum.value > 0 ? 2 : 0);
          const x = index * (barWidth + BAR_GAP);
          const y = VALUE_SPACE + chartHeight - barHeight;
          return (
            <g key={datum.label}>
              <title>
                {datum.label}: {formatValue(datum.value)}
              </title>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={4}
                fill={`url(#${gradientId})`}
              />
              {showValues && datum.value > 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={y - 5}
                  textAnchor="middle"
                  fontSize="10"
                  fill="hsl(var(--muted-foreground))"
                >
                  {formatValue(datum.value)}
                </text>
              ) : null}
              {tickAt.has(index) ? (
                <text
                  x={x + barWidth / 2}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize="10"
                  fill="hsl(var(--muted-foreground))"
                >
                  {datum.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
