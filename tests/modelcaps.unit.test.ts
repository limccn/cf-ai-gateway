// modelcap 档位乘算单测（09-16 kv-ops 档位化）：
// cap = MODELCAP_BASE_TOKENS × MODELCAP_MULTIPLIER × 档位（xlarge 式）；
// 档位来自 src/generated/modelcaps.ts。2026-09-16 用户手工调档后全量模型均有档位
// （无 null——null 代码路径保留，seed 恢复 NULL 时 render 自动还原）。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELCAP_BASE_TOKENS,
  DEFAULT_MODELCAP_MULTIPLIER,
  modelCapFor,
  parsePositiveInt,
} from "../src/lib/modelcaps";

describe("parsePositiveInt（env 字符串 → 正整数，非法回退默认）", () => {
  it("缺失/空串回退默认", () => {
    expect(parsePositiveInt(undefined, 8192)).toBe(8192);
    expect(parsePositiveInt("", 8192)).toBe(8192);
  });
  it("合法正整数解析", () => {
    expect(parsePositiveInt("8192", 100)).toBe(8192);
    expect(parsePositiveInt("2", 100)).toBe(2);
  });
  it("非法值回退默认（非数字/零/负数/小数）", () => {
    expect(parsePositiveInt("abc", 8192)).toBe(8192);
    expect(parsePositiveInt("0", 8192)).toBe(8192);
    expect(parsePositiveInt("-5", 8192)).toBe(8192);
    expect(parsePositiveInt("8192.5", 8192)).toBe(8192);
  });
});

describe("modelCapFor（档位 × 常数 = cap）", () => {
  it("缺省常数：1x = 16384、2x = 32768、4x = 65536", () => {
    expect(modelCapFor("gpt-5.6-luna", DEFAULT_MODELCAP_BASE_TOKENS, DEFAULT_MODELCAP_MULTIPLIER)).toEqual({
      known: true,
      cap: 16384,
    });
    expect(modelCapFor("glm-5.3", DEFAULT_MODELCAP_BASE_TOKENS, DEFAULT_MODELCAP_MULTIPLIER)).toEqual({
      known: true,
      cap: 32768,
    });
    expect(modelCapFor("kimi-k2.6", DEFAULT_MODELCAP_BASE_TOKENS, DEFAULT_MODELCAP_MULTIPLIER)).toEqual({
      known: true,
      cap: 65536,
    });
  });
  it("原「不限」模型已全量上档（用户 09-16 手工调档）：claude 系 1x", () => {
    expect(modelCapFor("claude-fable-5", DEFAULT_MODELCAP_BASE_TOKENS, DEFAULT_MODELCAP_MULTIPLIER)).toEqual({
      known: true,
      cap: 16384,
    });
    expect(modelCapFor("claude-opus-5", 4096, 3)).toEqual({ known: true, cap: 12288 });
  });
  it("未知模型 → known=false（慢路径 D1 权威）", () => {
    expect(modelCapFor("my-custom-model", DEFAULT_MODELCAP_BASE_TOKENS, DEFAULT_MODELCAP_MULTIPLIER)).toEqual({
      known: false,
      cap: null,
    });
  });
  it("常数可配：base 4096 × mult 2 → 1x=8192、4x=32768；mult 3 → 2x=49152", () => {
    expect(modelCapFor("gpt-5.6-luna", 4096, 2)).toEqual({ known: true, cap: 8192 });
    expect(modelCapFor("kimi-k2.6", 4096, 2)).toEqual({ known: true, cap: 32768 });
    expect(modelCapFor("glm-5.3", 8192, 3)).toEqual({ known: true, cap: 49152 });
  });
});
