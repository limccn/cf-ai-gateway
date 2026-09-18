// Top N + Other models 合并规则单元测试（09-14 批次 A / design §6）。
// 纯函数、无 DOM：合并规则错了不会报错、只会静默展示错误占比，属于最该被锁死的一类逻辑。
import { describe, expect, it } from "vitest";
import {
  OTHER_MODELS_LABEL,
  buildModelCostSeries,
  buildTokenSplitSeries,
} from "../app/modules/usage/series";
import type { UsageAggregate } from "../app/modules/usage/types";

/** 只关心 group 与 cost 的聚合行夹具（其余字段与合并规则无关）。 */
function agg(group: string | null, cost: number): UsageAggregate {
  return { group, requests: 1, tokensIn: 1, tokensOut: 1, cost };
}

/** 只关心 tokens 两列的聚合行夹具（时间桶键；cost 与 tokens 规则无关）。 */
function bucket(tokensIn: number, tokensOut: number): UsageAggregate {
  return { group: "2026-09-18T00:00:00Z", requests: 1, tokensIn, tokensOut, cost: 0 };
}

describe("buildModelCostSeries — Top N 截断与 Other 合并", () => {
  it("超过 N 个模型：取成本前 5，其余合并为一个 Other models", () => {
    const series = buildModelCostSeries([
      agg("m1", 700),
      agg("m2", 600),
      agg("m3", 500),
      agg("m4", 400),
      agg("m5", 300),
      agg("m6", 200),
      agg("m7", 100),
    ]);

    expect(series).toHaveLength(6); // 5 个模型 + 1 个合并组
    expect(series.slice(0, 5).map((d) => d.label)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(series[5]).toEqual({ label: OTHER_MODELS_LABEL, value: 300, isOther: true });
  });

  it("第 6 名及以后不再以自身名字出现（只存在于合并值里）", () => {
    const series = buildModelCostSeries([
      agg("m1", 700),
      agg("m2", 600),
      agg("m3", 500),
      agg("m4", 400),
      agg("m5", 300),
      agg("m6", 200),
    ]);

    const labels = series.map((d) => d.label);
    expect(labels).not.toContain("m6");
    // 合计守恒：环形图中心的总数与后端聚合总和一致，合并不能吞掉数值
    expect(series.reduce((sum, d) => sum + d.value, 0)).toBe(2700);
  });

  it("恰好 5 个：不产生 Other 组（不出现 0 值尾巴）", () => {
    const series = buildModelCostSeries([
      agg("m1", 700),
      agg("m2", 600),
      agg("m3", 500),
      agg("m4", 400),
      agg("m5", 300),
    ]);

    expect(series).toHaveLength(5);
    expect(series.some((d) => d.isOther)).toBe(false);
    expect(series.map((d) => d.label)).not.toContain(OTHER_MODELS_LABEL);
  });
});

describe("buildModelCostSeries — 排序与过滤", () => {
  it("不依赖输入顺序：按成本降序重排（后端按 model 字典序返回）", () => {
    const series = buildModelCostSeries([
      agg("zzz", 100),
      agg("aaa", 900),
      agg("mmm", 500),
    ]);

    expect(series.map((d) => d.label)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("成本相同按 label 升序：图例顺序不随数据到达顺序抖动", () => {
    const series = buildModelCostSeries([agg("beta", 100), agg("alpha", 100)]);

    expect(series.map((d) => d.label)).toEqual(["alpha", "beta"]);
  });

  it("null 组（rejected 无 model 归属）被过滤，不并入 Other", () => {
    const series = buildModelCostSeries([
      agg(null, 9999), // 若被算进来，Other 会出现且总额翻倍
      agg("m1", 700),
      agg("m2", 600),
      agg("m3", 500),
      agg("m4", 400),
      agg("m5", 300),
      agg("m6", 200),
    ]);

    expect(series).toHaveLength(6);
    expect(series[5]).toEqual({ label: OTHER_MODELS_LABEL, value: 200, isOther: true });
    expect(series.reduce((sum, d) => sum + d.value, 0)).toBe(2700); // 9999 未被计入
  });

  it("全为 null 组 → 空集（页面显示空态，而不是空环形）", () => {
    expect(buildModelCostSeries([agg(null, 100), agg(null, 200)])).toEqual([]);
  });

  it("空输入 → 空集", () => {
    expect(buildModelCostSeries([])).toEqual([]);
  });
});

// 09-14 批次 B / D7：cachedTokens 未落库，故环形图只有 input / output 两段。
describe("buildTokenSplitSeries — input / output 两段", () => {
  it("恒为两段且顺序固定（Input 在前，Output 在后）", () => {
    const series = buildTokenSplitSeries([bucket(100, 20), bucket(50, 5)]);

    expect(series).toHaveLength(2);
    expect(series.map((d) => d.label)).toEqual(["Input", "Output"]);
  });

  it("各段为全桶求和，两段之和 = 输入 + 输出总量（与柱状图同口径）", () => {
    const series = buildTokenSplitSeries([bucket(100, 20), bucket(50, 5), bucket(1, 1)]);

    expect(series[0]?.value).toBe(151);
    expect(series[1]?.value).toBe(26);
    expect(series.reduce((sum, d) => sum + d.value, 0)).toBe(177);
  });

  it("只有输入或只有输出时仍是两段：段数不随数据抖动", () => {
    expect(buildTokenSplitSeries([bucket(100, 0)]).map((d) => d.value)).toEqual([100, 0]);
    expect(buildTokenSplitSeries([bucket(0, 100)]).map((d) => d.value)).toEqual([0, 100]);
  });

  it("不过滤 group === null —— 与 buildModelCostSeries 口径**相反**，是刻意的", () => {
    // 时间桶必有键，null 组不存在；即便出现，桶内 tokens 也是真实消耗，漏计反而错。
    // 这条锁防止将来有人「顺手对齐」两个函数的口径（那会静默少算用量）。
    const withNull = buildTokenSplitSeries([
      { group: null, requests: 1, tokensIn: 7, tokensOut: 3, cost: 0 },
    ]);

    expect(withNull.reduce((sum, d) => sum + d.value, 0)).toBe(10);
  });

  it("空输入 → 空集", () => {
    expect(buildTokenSplitSeries([])).toEqual([]);
  });

  it("全零 → 空集（零总量下环形无意义，且会退化为不可见扇区）", () => {
    expect(buildTokenSplitSeries([bucket(0, 0), bucket(0, 0)])).toEqual([]);
  });
});
