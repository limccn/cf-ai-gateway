// 轻量环形图（自绘 SVG，无外部图表库 / CDN；用于按模型 / 维度占比展示）。
import { useId } from "react";
import { cn } from "@/lib/utils";

export interface DonutDatum {
  label: string;
  value: number;
  color: string;
}

export interface DonutChartProps {
  data: DonutDatum[];
  size?: number;
  thickness?: number;
  formatValue?: (value: number) => string;
  className?: string;
}

/** 固定调色板（按索引循环），避免引入外部颜色库。 */
export const CHART_COLORS = [
  "hsl(var(--primary))",
  "hsl(262 83% 66%)",
  "hsl(142 71% 45%)",
  "hsl(38 92% 50%)",
  "hsl(0 84% 60%)",
  "hsl(187 92% 52%)",
  "hsl(330 81% 60%)",
  "hsl(100 60% 50%)",
];

const RADIANS = Math.PI / 180;

export function DonutChart({
  data,
  size = 180,
  thickness = 22,
  formatValue = (value) => String(value),
  className,
}: DonutChartProps) {
  const clipId = useId();
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const center = size / 2;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  if (total <= 0 || data.length === 0) {
    return (
      <div className={cn("flex items-center justify-center text-sm text-muted-foreground", className)}>
        No data
      </div>
    );
  }

  let accumulated = 0;
  const segments = data.map((datum) => {
    const fraction = datum.value / total;
    const dash = fraction * circumference;
    const offset = -accumulated * circumference;
    accumulated += fraction;
    return { datum, dash, offset };
  });

  return (
    <div className={cn("flex flex-wrap items-center gap-6", className)}>
      <svg
        role="img"
        aria-label="Usage distribution donut chart"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <defs>
          <clipPath id={clipId}>
            <circle cx={center} cy={center} r={radius} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`} transform={`rotate(-90 ${center} ${center})`}>
          {segments.map(({ datum, dash, offset }) => (
            <circle
              key={datum.label}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={datum.color}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={offset * RADIANS * radius}
            >
              <title>
                {datum.label}: {formatValue(datum.value)}
              </title>
            </circle>
          ))}
        </g>
        <text
          x={center}
          y={center - 4}
          textAnchor="middle"
          fontSize="16"
          fontWeight="600"
          fill="hsl(var(--foreground))"
        >
          {formatValue(total)}
        </text>
        <text
          x={center}
          y={center + 14}
          textAnchor="middle"
          fontSize="10"
          fill="hsl(var(--muted-foreground))"
        >
          total
        </text>
      </svg>
      <ul className="space-y-1.5 text-sm">
        {data.map((datum) => (
          <li key={datum.label} className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ backgroundColor: datum.color }}
              aria-hidden="true"
            />
            <span className="text-muted-foreground">{datum.label}</span>
            <span className="font-medium">{formatValue(datum.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
