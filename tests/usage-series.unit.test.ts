// Top N + Other models 合并规则单元测试（09-14 批次 A / design §6）。
// 纯函数、无 DOM：合并规则错了不会报错、只会静默展示错误占比，属于最该被锁死的一类逻辑。
import { describe, expect, it } from "vitest";
import {
  OTHER_MODELS_LABEL,
  buildModelCostSeries,
} from "../app/modules/usage/series";
import type { UsageAggregate } from "../app/modules/usage/types";

/** 只关心 group 与 cost 的聚合行夹具（其余字段与合并规则无关）。 */
function agg(group: string | null, cost: number): UsageAggregate {
  return { group, requests: 1, tokensIn: 1, tokensOut: 1, cost };
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
