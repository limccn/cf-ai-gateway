// modelcap 档位乘算（09-16 kv-ops O3c 档位化，用户裁决）：
// MODELCAPS 存档位（xlarge 式 1x/2x，null=不限）；运行时
// cap = MODELCAP_BASE_TOKENS × MODELCAP_MULTIPLIER × 档位。
// 两常数为 env [vars] 烘焙（缺省 8192 × 2 = 16384 基准；staging 的值取自 .dev.vars.staging 的同名键，
// 但 render:modelcaps 只读顶层值 —— 档位表两环境共享，不要分叉）。
// 改常数需重跑 render:modelcaps + 部署（档位按生成时常数推导，design.md §3.1 契约）。
import { MODELCAPS } from "../generated/modelcaps";

export const DEFAULT_MODELCAP_BASE_TOKENS = 8192;
export const DEFAULT_MODELCAP_MULTIPLIER = 2;

/** 正整数解析（env 字符串）；缺失/非法回退默认（render 链已保证缺失即烘焙默认值）。 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ModelCapLookup {
  /** billingModel 是否在常量中（不在 → 慢路径 D1 权威）。 */
  known: boolean;
  /** 乘算后的 cap（null = 不限）。 */
  cap: number | null;
}

export function modelCapFor(model: string, baseTokens: number, multiplier: number): ModelCapLookup {
  if (!Object.prototype.hasOwnProperty.call(MODELCAPS, model)) {
    return { known: false, cap: null };
  }
  const tier = MODELCAPS[model] ?? null;
  return { known: true, cap: tier === null ? null : baseTokens * multiplier * tier };
}
