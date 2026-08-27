// R1 [1m] 后缀模型 ID 工具单元测试（PRD R1.1/R1.2）：纯函数，无运行时依赖。
// resolveModelId 三值语义：matched（路由可命中）/ upstream（上游名：[1m] 仅下游别名，
// 默认转发无后缀映射值；显式映射值含 [1m] 时按配置保留）/ billing（计费剥离）。
import { describe, expect, it } from "vitest";
import {
  SUFFIX_1M,
  has1mSuffix,
  resolveModelId,
  strip1mSuffix,
} from "../src/lib/model-id";

describe("has1mSuffix / strip1mSuffix", () => {
  it("识别 [1m] 后缀", () => {
    expect(has1mSuffix("deepseek-chat[1m]")).toBe(true);
    expect(has1mSuffix("deepseek-chat")).toBe(false);
    expect(has1mSuffix("")).toBe(false);
  });

  it("剥离 [1m] 后缀（仅末尾精确匹配，非子串）", () => {
    expect(strip1mSuffix("deepseek-chat[1m]")).toBe("deepseek-chat");
    expect(strip1mSuffix("deepseek-chat")).toBe("deepseek-chat");
    expect(strip1mSuffix("x[1m]y")).toBe("x[1m]y");
    expect(strip1mSuffix("x1m")).toBe("x1m");
    expect(strip1mSuffix("")).toBe("");
  });
});

describe("resolveModelId", () => {
  const MODELS = { "deepseek-chat": "deepseek-chat", "claude-sonnet": "claude-sonnet-4-5" };

  it("精确匹配（无后缀请求）：上游/计费均为映射值", () => {
    const r = resolveModelId(MODELS, "deepseek-chat");
    expect(r.matched).toBe(true);
    expect(r.upstream).toBe("deepseek-chat");
    expect(r.billing).toBe("deepseek-chat");
  });

  it("显式映射含 [1m]：精确优先，上游保留配置后缀，计费剥离", () => {
    const models = { ...MODELS, [`deepseek-chat${SUFFIX_1M}`]: `deepseek-chat${SUFFIX_1M}` };
    const r = resolveModelId(models, "deepseek-chat[1m]");
    expect(r.matched).toBe(true);
    expect(r.upstream).toBe("deepseek-chat[1m]");
    expect(r.billing).toBe("deepseek-chat");
  });

  it("[1m] 请求回退无后缀映射：上游转发无后缀映射值，计费剥离（R1.2 核心：后缀仅下游别名）", () => {
    const r = resolveModelId(MODELS, "deepseek-chat[1m]");
    expect(r.matched).toBe(true);
    expect(r.upstream).toBe("deepseek-chat");
    expect(r.billing).toBe("deepseek-chat");
  });

  it("回退时映射值显式含 [1m]：按配置转发（如 `{\"opus-4-8\": \"opus[1m]\"}` → 上游 opus[1m]）", () => {
    const r = resolveModelId({ "opus-4-8": "opus[1m]" }, "opus-4-8[1m]");
    expect(r.matched).toBe(true);
    expect(r.upstream).toBe("opus[1m]");
    expect(r.billing).toBe("opus-4-8");
  });

  it("无匹配：matched=false，upstream=raw，billing=剥离（路由层据此 404 拒绝）", () => {
    const r = resolveModelId(MODELS, "no-such-model");
    expect(r.matched).toBe(false);
    expect(r.upstream).toBe("no-such-model");
    expect(r.billing).toBe("no-such-model");

    const r1m = resolveModelId(MODELS, "no-such-model[1m]");
    expect(r1m.matched).toBe(false);
    expect(r1m.upstream).toBe("no-such-model[1m]");
    expect(r1m.billing).toBe("no-such-model");
  });

  it("空模型表/空请求：不崩溃", () => {
    const r = resolveModelId({}, "");
    expect(r.matched).toBe(false);
    expect(r.upstream).toBe("");
    expect(r.billing).toBe("");
  });
});
