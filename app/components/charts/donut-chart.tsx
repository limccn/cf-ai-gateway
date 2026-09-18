// 轻量环形图（自绘 SVG，无外部图表库 / CDN；用于按模型 / 维度占比展示）。
// 布局契约：环图与图例**恒并排**（根容器不 flex-wrap）。图例可收缩（min-w-0 flex-1）、
// 长序列名截断（title 兜底全名）、数值永不截断 —— 「图例换行到环图下方」是缺陷而非降级，
// 见 design §9.5（宽度账的实测订正见 §9.5a/§9.5b）。
//
// 环图尺寸**自适应收缩**（2026-09-18，批次 B 实测补）：`size` 是**上限**而非定值。
// 窄端实测（375 视口 / 1/3 卡）：卡片内容盒仅 **214px**，固定 size=152 + 16px 间距会把图例压到
// **46px** —— label 被压成 0 宽（序列名完全不可见）、数值 64px 溢出卡片。此时「不换行」这条
// 契约靠牺牲图例来满足，等于把换行缺陷换成了压扁缺陷。
// 故按容器宽反算：先给图例留够 LEGEND_MIN_WIDTH，余量才是环图能占的宽度。
// 桌面端（1/3 卡内容盒实测 **302px**）算得 302−118−24 = 160 > 152 → 上限先生效，
// 视觉与改动前逐像素一致。
//
// **适用前提（调用方必读）**：预算是 `MIN_SIZE(80) + LEGEND_MIN_WIDTH(118) + LEGEND_GAP(24)
// = **222px**`，容器窄于此则 `max(MIN_SIZE, …)` 的下限获胜、图例被压破。实测：1024 视口下
// 1/3 卡内容盒只有 **174px** → 图例 70px、序列名 0 宽（名字完全不可见）—— 与上面 375 的缺陷同源。
// MIN_SIZE=80 不是随手取的：它正是中心总数（9 位精确数 @fontSize 11 ≈55px）放得下的最小环。
// 故**容器 < 222px 时不要用本组件**（1/3 栏布局须改用 ≥1280 的断点，见 usage.tsx）；
// 单列全宽下 360 视口给 199px 仍略欠（序列名压到 ~13px，可辨但已截断），320 视口给 159px
// 则与 1024 同病 —— 320 低于本仓库的验证下限（verify-responsive 自 375 起），不在契约内。
import { useId } from "react";
import { cn } from "@/lib/utils";
import { useContainerWidth } from "@/hooks/use-container-width";

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

/** 环图收缩下限。环粗与中心字号都随尺寸同比缩放，故小尺寸下中心总数仍放得下。
 *  80 不是随手取的：中心总数（9 位精确数 @fontSize 11 ≈55px）要装进环内径
 *  80 − 2×12 = 56px。**调低它中心数就会压到环上**（调用方前提另见文件头）。 */
const MIN_SIZE = 80;
/** 图例保底宽度：圆点 10 + 间距 8×2 + 数值（9 位精确数 ≈64px）+ 序列名 ≈28px。 */
const LEGEND_MIN_WIDTH = 118;
/**
 * 环图与图例之间的间距预算。取**较大的那一档**（= CSS 的 `sm:gap-6`）。
 *
 * 不可按容器宽分档：CSS 的断点是 `gap-4 sm:gap-6`，即按**视口**判定，而这里只能拿到
 * **容器**宽 —— 1/3 卡的容器恒 < 640，按容器判会一路取 16px，而视口 ≥ 640 时 CSS 实际给
 * 24px。实测后果：1280 下预算算出 125.7、实际按 24px 排，图例被挤到 110px（比地板少 8px）。
 * 取大一档则误差方向永远安全：实际间距小时图例**多**得 8px，绝不会少。
 */
const LEGEND_GAP = 24;
/** 环粗 / 中心字号占 size 的比例（152 × 0.145 = 22、152 × 0.105 ≈ 16，与改动前的定值一致）。 */
const THICKNESS_RATIO = 0.145;
const CENTER_FONT_RATIO = 0.105;
const MIN_THICKNESS = 10;

export function DonutChart({
  data,
  size = 180,
  thickness = 22,
  formatValue = (value) => String(value),
  className,
}: DonutChartProps) {
  const clipId = useId();
  // 首帧未测量（containerWidth=0）时用调用方给的 size，测到后再收缩 —— 只会变小，不会撑破。
  const [wrapperRef, containerWidth] = useContainerWidth<HTMLDivElement>();
  const renderSize = containerWidth > 0
    ? Math.min(size, Math.max(MIN_SIZE, containerWidth - LEGEND_MIN_WIDTH - LEGEND_GAP))
    : size;
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const center = renderSize / 2;
  // 环粗随尺寸同比收窄，环内空白才跟着变大 —— 否则小尺寸下中心的总数会压到环上。
  const renderThickness = Math.max(MIN_THICKNESS, Math.min(thickness, Math.round(renderSize * THICKNESS_RATIO)));
  const radius = (renderSize - renderThickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const centerFontSize = Math.max(11, Math.round(renderSize * CENTER_FONT_RATIO));

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
    // 起始角用「角度」累计；渲染处 offset * RADIANS * radius 换算为沿弧线的长度偏移。
    // 注意不可用弧长（fraction * circumference）——再乘 RADIANS*radius 会超转 ~(π/180)·r。
    const offset = -accumulated * 360;
    accumulated += fraction;
    return { datum, dash, offset };
  });

  return (
    <div ref={wrapperRef} className={cn("flex items-center gap-4 sm:gap-6", className)}>
      <svg
        role="img"
        aria-label="Usage distribution donut chart"
        width={renderSize}
        height={renderSize}
        viewBox={`0 0 ${renderSize} ${renderSize}`}
        className="shrink-0"
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
              strokeWidth={renderThickness}
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
          fontSize={centerFontSize}
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
      <ul className="min-w-0 flex-1 space-y-1.5 text-sm">
        {data.map((datum) => (
          <li key={datum.label} className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: datum.color }}
              aria-hidden="true"
            />
            {/* min-w-0 不可省：flex item 默认 min-width:auto 会拒绝收缩，truncate 便不会生效 */}
            <span className="min-w-0 truncate text-muted-foreground" title={datum.label}>
              {datum.label}
            </span>
            <span className="shrink-0 font-medium">{formatValue(datum.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
