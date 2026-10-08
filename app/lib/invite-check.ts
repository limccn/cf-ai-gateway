// 注册页邀请码预校验的判定层（批次 U，D29 闭环体验）。
//
// 把「警示 / 禁用 / 中性提示」三个**效果**从组件里抽成纯函数，原因有二：
//   1. 本仓库无 DOM 测试框架 —— AC50 的三分支变异自检（警示条件 / 禁用条件 / fail-open
//      各破坏一次、对应断言必须变红）只能落在可单测的纯函数上；
//   2. 组件必须**只**按本函数的输出渲染（register.tsx 不许在 JSX 里另写一份判断）——
//      否则锁住的是一个没人用的死函数，组件侧改坏了不会有任何测试变红。
//
// 三分支语义（prd D29）：
//   - **invalid**（服务端明确回答 valid:false）→ 警示 + 禁用提交 —— 唯一该拦的分支；
//   - **error**（校验请求本身失败：429/5xx/网络错）→ **fail-open**：不警示、不禁用，
//     只给中性提示。把网络故障说成「码失效」会吓退本可注册的好码，最终判定由提交时
//     Better Auth 的 403 兜底；
//   - 其余（unchecked / checking / valid）→ 零警示零拦截。未知（checking）不等于失效。

export type InviteCheckStatus =
  /** 尚未校验（初始进入 / 刚改过码） */
  | "unchecked"
  /** 校验请求在途 —— 不警示、不禁用（未知不等于失效） */
  | "checking"
  /** 服务端 valid: true */
  | "valid"
  /** 服务端 valid: false —— 唯一该拦的分支 */
  | "invalid"
  /** 校验请求本身失败（429/5xx/网络错）—— fail-open */
  | "error";

export interface InviteCheckGate {
  /** 失效警示（`role="alert"`）：只有服务端明确回答 valid:false 才渲染。 */
  showInvalidAlert: boolean;
  /** 禁用提交：同上。error/unchecked/checking 一律不禁 —— fail-open。 */
  blockSubmit: boolean;
  /** 中性提示（非 alert、非失效文案）：校验失败时说明提交时会再校验。 */
  showRetryHint: boolean;
}

// Record 形态：漏一个 key 就是编译错误（switch 各分支手写三元则可能「一起漂移」）。
const GATE_BY_STATUS: Record<InviteCheckStatus, InviteCheckGate> = {
  unchecked: { showInvalidAlert: false, blockSubmit: false, showRetryHint: false },
  checking: { showInvalidAlert: false, blockSubmit: false, showRetryHint: false },
  valid: { showInvalidAlert: false, blockSubmit: false, showRetryHint: false },
  invalid: { showInvalidAlert: true, blockSubmit: true, showRetryHint: false },
  error: { showInvalidAlert: false, blockSubmit: false, showRetryHint: true },
};

export function inviteCheckGate(status: InviteCheckStatus): InviteCheckGate {
  return GATE_BY_STATUS[status];
}
