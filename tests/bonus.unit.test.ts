// 赠金配置解析单测（09-16-signup-bonus-grant，design §8.1）：纯函数，无 DB。
// 覆盖金额解析矩阵与邮箱验证开关矩阵 —— 这两者是「配置到底生不生效」的唯一裁决点，
// 而且必须在 DB 之外可测（miniflare bindings 在测试进程内固定，无法逐用例改 env）。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_VERIFY_BONUS,
  DEFAULT_SIGNUP_BONUS,
  isEmailVerificationEnabled,
  parseBonusAmount,
} from "../src/lib/bonus";

describe("parseBonusAmount（env 字符串 → USD 金额）", () => {
  it("未配置（undefined/空串/空白串）→ fallback 默认值（开箱即送）", () => {
    expect(parseBonusAmount(undefined, DEFAULT_SIGNUP_BONUS)).toBe(5);
    expect(parseBonusAmount("", DEFAULT_SIGNUP_BONUS)).toBe(5);
    expect(parseBonusAmount("   ", DEFAULT_SIGNUP_BONUS)).toBe(5);
    expect(parseBonusAmount(undefined, DEFAULT_EMAIL_VERIFY_BONUS)).toBe(5);
  });

  it("显式 0 → 0（不动余额、不写流水、不置标记）", () => {
    expect(parseBonusAmount("0", DEFAULT_SIGNUP_BONUS)).toBe(0);
    expect(parseBonusAmount("0.0", DEFAULT_SIGNUP_BONUS)).toBe(0);
    expect(parseBonusAmount(" 0 ", DEFAULT_SIGNUP_BONUS)).toBe(0);
  });

  it("负数/非法值 → 0（涉及钱，fail-safe 方向是少发而非多发；不抛错）", () => {
    expect(parseBonusAmount("-1", DEFAULT_SIGNUP_BONUS)).toBe(0);
    expect(parseBonusAmount("-0.01", DEFAULT_SIGNUP_BONUS)).toBe(0);
    expect(parseBonusAmount("abc", DEFAULT_SIGNUP_BONUS)).toBe(0);
    expect(parseBonusAmount("NaN", DEFAULT_SIGNUP_BONUS)).toBe(0);
    expect(parseBonusAmount("Infinity", DEFAULT_SIGNUP_BONUS)).toBe(0);
  });

  it("合法正数 → 原值（四舍五入到分）", () => {
    expect(parseBonusAmount("8", DEFAULT_SIGNUP_BONUS)).toBe(8);
    expect(parseBonusAmount("2.5", DEFAULT_SIGNUP_BONUS)).toBe(2.5);
    expect(parseBonusAmount("5.555", DEFAULT_SIGNUP_BONUS)).toBe(5.56);
    expect(parseBonusAmount("5.554", DEFAULT_SIGNUP_BONUS)).toBe(5.55);
  });
});

describe("isEmailVerificationEnabled（EMAIL_VERIFICATION_ENABLED → 布尔）", () => {
  it("缺省/false/0/其他值 → 关闭（新机制默认关）", () => {
    expect(isEmailVerificationEnabled(undefined)).toBe(false);
    expect(isEmailVerificationEnabled("")).toBe(false);
    expect(isEmailVerificationEnabled("false")).toBe(false);
    expect(isEmailVerificationEnabled("FALSE")).toBe(false);
    expect(isEmailVerificationEnabled("0")).toBe(false);
    expect(isEmailVerificationEnabled("off")).toBe(false);
    expect(isEmailVerificationEnabled("nope")).toBe(false);
  });

  it("true/1/yes/on（大小写与空白不敏感）→ 开启", () => {
    expect(isEmailVerificationEnabled("true")).toBe(true);
    expect(isEmailVerificationEnabled("TRUE")).toBe(true);
    expect(isEmailVerificationEnabled(" TRUE ")).toBe(true);
    expect(isEmailVerificationEnabled("1")).toBe(true);
    expect(isEmailVerificationEnabled("yes")).toBe(true);
    expect(isEmailVerificationEnabled("on")).toBe(true);
  });
});
