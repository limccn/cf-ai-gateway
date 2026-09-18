// Usage 页图表系列构造（纯函数；09-14 批次 A / design §6）。
//
// 为什么独立成文件：Top N + Other 的合并规则是数据形态转换，不依赖 DOM / React，
// 抽出来即可用无 DOM 单测锁死（tests/usage-series.unit.test.ts）。
//
// 两条 import 纪律（否则 `tsc -p tsconfig.test.json` 会失败，而 vitest 只转译不查类型，
// 问题会一路溜到 typecheck 才暴露）：
//   1. 不得引入 .tsx —— 测试用的 tsconfig 没有 jsx 标志（TS6142），而 CHART_COLORS 住在
//      donut-chart.tsx 里。故颜色不在本模块决定，由页面层（usage.tsx）按下标配上。
//   2. 只能用相对路径 —— tsconfig.test.json 没有 `@/*` 别名。
import type { UsageAggregate } from "./types";

/** 合并组显示名（页面与单测共用同一常量，避免文案两处漂移）。 */
export const OTHER_MODELS_LABEL = "Other models";

export interface ModelCostDatum {
  label: string;
  value: number;
  /** true = Top N 之外的合并组，页面据此配 muted 灰而非调色板色。 */
  isOther: boolean;
}

/**
 * 按模型成本构造环形图数据：过滤无归属行 → 成本降序 → 取前 topN → 其余合并为 Other models。
 *
 * - 过滤 `group === null`：rejected 行的 model 为 null（design §3「已知口径差」），
 *   并入 Other 会把「没有归属」伪装成「归属了别的模型」。
 * - 同成本按 label 升序：后端返回顺序（按 model 字典序）不保证与成本序一致，
 *   不设次级键时图例顺序会随数据到达顺序抖动。
 * - 空集或只有 null 组 → `[]`（页面据此显示空态，而不是渲染一个空环形）。
 */
export function buildModelCostSeries(
  aggregates: UsageAggregate[],
  topN = 5,
): ModelCostDatum[] {
  const rows = aggregates
    .filter((agg): agg is UsageAggregate & { group: string } => agg.group !== null)
    .sort((a, b) => b.cost - a.cost || a.group.localeCompare(b.group));

  const top = rows
    .slice(0, topN)
    .map((row) => ({ label: row.group, value: row.cost, isOther: false }));
  const rest = rows.slice(topN);
  if (rest.length > 0) {
    top.push({
      label: OTHER_MODELS_LABEL,
      value: rest.reduce((sum, row) => sum + row.cost, 0),
      isOther: true,
    });
  }
  return top;
}
