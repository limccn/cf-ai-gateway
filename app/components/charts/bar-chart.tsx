// 轻量柱状图（自绘 SVG，无外部图表库 / CDN；spec M6.5：图表轻量方案）。
// 响应式：ResizeObserver 测容器宽度动态算柱宽（10~36px），文字固定 10px 不被缩放，
// 修复旧实现 viewBox + minWidth 压缩导致的图表失真（spec 见 fix-dashboard-display-bugs）。
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
  className?: string;
}

const BAR_MAX = 36;
const BAR_MIN = 10;
const BAR_GAP = 8;
const LABEL_SPACE = 28;
const VALUE_SPACE = 18;
/** 初次渲染（未测量容器宽度）的兜底宽度。 */
const FALLBACK_WIDTH = 640;

export function BarChart({
  data,
  height = 200,
  formatValue = (value) => String(value),
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
  // 密集时日期标签抽稀（保留最后一根），数值标签在柱宽过窄时降级为 title tooltip
  const labelEvery = barWidth < 20 ? 2 : 1;
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
              {index % labelEvery === 0 || index === n - 1 ? (
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
