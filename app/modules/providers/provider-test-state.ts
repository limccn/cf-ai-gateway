// Test connection 弹窗的**相位状态机 + 文案**（批次 O，2026-09-21；PRD 裁决 D14–D16）。
//
// 为什么单独一个纯模块（不塞进组件/hook）：
//   · **文案是产品的一部分**，而它有红线（见下）。纯函数才能被逐相位断言 —— 组件里的字符串
//     只能靠端到端探针读，慢且漏。「网关不记账，但上游可能计费」这句在批次 N 已经被复核过一轮
//     （「Nothing is billed」是兑现不了的承诺，已订正），本批次把它变成**可执行的断言**。
//   · 相位是**显式判别联合**，不是从两个 `isPending` 推导的布尔组合。推导式写法有一个真实的
//     缺陷：ping 落地与 /test 起飞之间的微任务间隙里，两个 isPending 都是 false、data 还是空，
//     渲染层会掉进 `if (!data) return null` ⇒ **弹窗内容瞬间消失**（高度跳变、行数断言读成 0）。
//
// 文案红线（tests/provider-test-state.unit.test.ts 逐相位守）：
//   1. **任何相位都不许说「不产生费用」**：/test 发的是三条真实上游调用（用 provider 的 key），
//      且 provider 的 httpOptions.body 会覆盖 max_tokens=16 这个默认值。
//   2. **ping 尚未跑完 / 未联通时不许出现「上游可能计费」**：那时**一条模型调用都没发生**，
//      说「可能计费」是凭空吓人，也把「零调用」这个卖点说没了。
//   3. **不许把 ping 结果说成「provider 可用」「密钥有效」**：ping 不带凭据，它只证明
//      「这个主机在网络层回了一个 HTTP 答复」。
import type { ProviderPingResult, ProviderProbeResult } from "./types";

export type TestRunPhase =
  /** 联通性检查在途（**首帧也算这里**：open 变 true 的那一帧 effect 还没跑）。 */
  | { kind: "pinging" }
  /** 已联通，三条协议探测在途。ping 行必须**同时在场**（别让弹窗掉成空白帧）。 */
  | { kind: "probing"; ping: ProviderPingResult }
  /** 未联通 ⇒ 三条协议**完全不跑**（上游一条模型调用都没发生），只留 ping 行 + 跳过说明。 */
  | { kind: "skipped"; ping: ProviderPingResult }
  /** 探测完成（ping 行 + 三条协议行 + 汇总）。 */
  | {
      kind: "ready";
      ping: ProviderPingResult;
      model: string;
      timeoutMs: number;
      probes: ProviderProbeResult[];
    }
  /** 请求本身失败（网关层 4xx/5xx 或传输层抛错）。`ping` 为 null ⇒ 连通性检查就没跑成。 */
  | { kind: "failed"; ping: ProviderPingResult | null; message: string };

/** 首帧相位：与 pinging 同形，弹窗从第一帧起就有内容。 */
export const INITIAL_PHASE: TestRunPhase = { kind: "pinging" };

/** ping 行的标签（探针按它做「行集合」精确比对，别改成与协议行同名的串）。 */
export const PING_ROW_LABEL = "Host reachability";

/**
 * 未联通时的那句说明。必须同时说清三件事：
 *   ① 三条协议探测被跳过了；② 上游**没有**收到任何模型调用；③ 这不等于「凭据无效」。
 * ③ 是必须的：上游若挂在反向代理 / mTLS / 按 UA 拦截的 WAF 后面，未鉴权请求可能**在连接层**
 * 就被拒 —— 那时 ping 报不可达而主机其实是通的（已知假阴性，见 lib/ping.ts 文件头）。
 */
export const SKIP_NOTICE =
  "Not reachable — the three protocol probes were skipped, so no request was sent to the upstream model endpoints. This is a network-layer result only: no credentials were sent, so it is not a verdict on your API key. Hosts behind a reverse proxy or client-certificate gateway can reject a credential-free request at the connection level.";

/**
 * ping 行的口径说明（D14 的原话）。用户看到绿点最可能的误读是「provider 好了 / key 对了」，
 * 所以这句必须常驻在 ping 行旁边，而不是只写在代码注释里。
 */
export const REACHABILITY_DOCTRINE =
  "Reachable means the origin returned any HTTP response — including 401, 403 or 404. It does not mean the upstream accepted the call, and it says nothing about your API key.";

/** 顶部描述按相位分叉 —— 静态描述在某些相位是**假话**（见红线 1、2）。 */
export function dialogDescription(phase: TestRunPhase): string {
  switch (phase.kind) {
    case "pinging":
      return "Checking whether the upstream host is reachable — one credential-free HEAD request to the origin. No model call is made at this step.";
    case "skipped":
      return "The gateway records no usage and changes no provider state. The reachability check could not reach the host, so no upstream call was made at all.";
    case "failed":
      return phase.ping === null
        ? "The reachability check could not be completed. The gateway records no usage and changes no provider state."
        : "Real calls to the upstream using this provider's key. The gateway records no usage and changes no provider state — but the upstream may bill a few tokens.";
    case "probing":
    case "ready":
      return "Real calls to the upstream using this provider's key. The gateway records no usage and changes no provider state — but the upstream may bill a few tokens.";
  }
}

/** ping 行右侧的状态串。`status` 不可读但确实收到了 HTTP 回应时**不许**说成「没有响应」。 */
export function pingStatusLabel(ping: ProviderPingResult): string {
  if (ping.status !== null && ping.status > 0) {
    return `${ping.status} ${ping.statusText}`.trim();
  }
  return ping.reachable ? "HTTP response received (status unreadable)" : "no HTTP response";
}
