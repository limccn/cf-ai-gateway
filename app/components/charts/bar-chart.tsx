// 轻量柱状图（自绘 SVG，无外部图表库 / CDN；spec M6.5：图表轻量方案）。
import { useId } from "react";
import { cn } from "@/lib/utils";

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

const BAR_WIDTH = 36;
const BAR_GAP = 8;
const LABEL_SPACE = 28;
const VALUE_SPACE = 18;

export function BarChart({
  data,
  height = 200,
  formatValue = (value) => String(value),
  className,
}: BarChartProps) {
  const gradientId = useId();
  const chartHeight = height - VALUE_SPACE - LABEL_SPACE;
  const maxValue = Math.max(0, ...data.map((d) => d.value));

  if (data.length === 0) {
    return (
      <div className={cn("flex h-40 items-center justify-center text-sm text-muted-foreground", className)}>
        No data for this period
      </div>
    );
  }

  const totalWidth = data.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;

  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <svg
        role="img"
        aria-label="Usage bar chart"
        viewBox={`0 0 ${totalWidth} ${height}`}
        className="mx-auto block h-auto max-w-full"
        style={{ minWidth: `${Math.min(totalWidth, 640)}px` }}
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
          const x = index * (BAR_WIDTH + BAR_GAP);
          const y = VALUE_SPACE + chartHeight - barHeight;
          return (
            <g key={datum.label}>
              <title>
                {datum.label}: {formatValue(datum.value)}
              </title>
              <rect
                x={x}
                y={y}
                width={BAR_WIDTH}
                height={barHeight}
                rx={4}
                fill={`url(#${gradientId})`}
              />
              {datum.value > 0 ? (
                <text
                  x={x + BAR_WIDTH / 2}
                  y={y - 5}
                  textAnchor="middle"
                  fontSize="10"
                  fill="hsl(var(--muted-foreground))"
                >
                  {formatValue(datum.value)}
                </text>
              ) : null}
              <text
                x={x + BAR_WIDTH / 2}
                y={height - 8}
                textAnchor="middle"
                fontSize="10"
                fill="hsl(var(--muted-foreground))"
              >
                {datum.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
