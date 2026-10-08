// 批次 U AC50：预校验三分支判定（警示条件 / 禁用条件 / fail-open）——
// **变异自检的落点**：注册页无 DOM 测试框架，AC52 要求的「各破坏一次、对应断言必须变红」
// 只能落在 inviteCheckGate 这个纯函数上；register.tsx 的 JSX 只按它的输出渲染
// （文件头有约定），故此处变红 ⇔ 画面行为变红。
import { describe, expect, it } from "vitest";
import { inviteCheckGate, type InviteCheckStatus } from "../app/lib/invite-check";

const ALL_STATUSES: readonly InviteCheckStatus[] = [
  "unchecked",
  "checking",
  "valid",
  "invalid",
  "error",
];

describe("inviteCheckGate — 警示/禁用/中性提示的唯一判据（D29）", () => {
  it("invalid（服务端 valid:false）→ 警示 + 禁用，且不给中性提示", () => {
    const gate = inviteCheckGate("invalid");
    expect(gate.showInvalidAlert).toBe(true);
    expect(gate.blockSubmit).toBe(true);
    expect(gate.showRetryHint).toBe(false);
  });

  it("error（429/5xx/网络错）→ **fail-open**：不警示、不禁用，只给中性提示", () => {
    const gate = inviteCheckGate("error");
    expect(gate.showInvalidAlert).toBe(false);
    expect(gate.blockSubmit).toBe(false);
    expect(gate.showRetryHint).toBe(true);
  });

  it("unchecked / checking / valid → 零警示、零拦截、零提示（未知 ≠ 失效）", () => {
    for (const status of ["unchecked", "checking", "valid"] as const) {
      expect(inviteCheckGate(status)).toEqual({
        showInvalidAlert: false,
        blockSubmit: false,
        showRetryHint: false,
      });
    }
  });

  // 判别性总锁：恰好只有 invalid 一个状态被拦/被警示。
  // 只锁「invalid=true」的话，「把所有状态都禁用」也能绿；反之「全部放行」也会红 ——
  // 集合等值同时挡住两个方向（防退化成恒真或恒假）。
  it("全部状态里恰好只有 invalid 被警示且被禁用", () => {
    expect(ALL_STATUSES.filter((s) => inviteCheckGate(s).showInvalidAlert)).toEqual([
      "invalid",
    ]);
    expect(ALL_STATUSES.filter((s) => inviteCheckGate(s).blockSubmit)).toEqual(["invalid"]);
    expect(ALL_STATUSES.filter((s) => inviteCheckGate(s).showRetryHint)).toEqual(["error"]);
  });
});
