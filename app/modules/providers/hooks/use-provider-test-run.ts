// 「先 ping 联通、再跑三条协议」的编排（批次 O；PRD 裁决 D16）。
//
// 两个**必须在同一处**满足的性质：
//
// 1. **第二步只从第一步的成功里起飞** ⇒ 「未联通时上游零模型调用」是构造性成立，
//    而不是靠 UI 把行藏起来。任何「两个 effect 各盯一个 mutation 状态」的写法都会破坏它：
//    那样的下一步是由**状态推导**的，不是由**序列**保证的。
// 2. **一次打开 = 恰好 1 个 ping + 1 个 test**（dev 与生产一致）。本 hook 挂在
//    `ProviderTestDialog` 上 —— 那个组件在**页面加载时**就已挂载（`open=false`），
//    用户开弹窗是**依赖变化触发的 update**。React 的 StrictMode 只在**挂载**时做
//    mount→unmount→mount 双调用，不对 update 双调用，故 `!open` 的那两次 body 都直接早退、
//    一个请求都不发。
//
//    ⚠ 别把本 hook 挪进「随 open 才挂载」的子树里（例如原来的 `{open && <TestRun/>}`）——
//    那样挂载即双调用，dev 下会变成 2 个 ping + 2 个 test（= 6 条真实模型调用，花 provider 的钱）。
//    探针里「ping 恰 1 次、test 恰 1 次」这条断言就是这条前提的证伪器。
//    （这条**反转**了 implement.md 里「dev 双调用不修」的旧记录：旧记录否掉的是「用 ref 挡第二发」
//     这种掩盖式修法 —— 它确实会与重测按钮打架。正解是把**触发点**从「子树挂载」换成
//    「open 跃迁」，于是不需要挡任何东西。）
//
// ticket 仍然必需（关窗 / 重测 / 迟到的响应三种情况下，唯一正确的机制就是「结果只在仍是当前轮
// 时才被采用、才允许发下一个请求」）：closing 或 restart 都会让 ticket 失效。
import { useCallback, useEffect, useRef, useState } from "react";
import { usePingProvider } from "./use-ping-provider";
import { useTestProvider } from "./use-test-provider";
import { INITIAL_PHASE, type TestRunPhase } from "../provider-test-state";
import type { ProviderPingResult } from "../types";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export interface ProviderTestRun {
  phase: TestRunPhase;
  /** 重跑整轮两步（不在「只重跑协议」上开分支：不引入没被测过的状态）。 */
  restart: () => void;
}

/** 相位 + 它属于哪一轮（`key`）。两者一起存，才能在渲染期判断「这个相位还作数吗」。 */
interface PhaseSlot {
  key: string;
  phase: TestRunPhase;
}

export function useProviderTestRun(open: boolean, providerId: number | null): ProviderTestRun {
  const ping = usePingProvider();
  const test = useTestProvider();
  // 相位**连同它属于哪一轮**一起存（见下方 runKey）：单存相位的话，关窗重开后首帧会拿上一轮的
  // 结果渲染一次 —— 协议行「闪回」是本批次要防的缺陷（探针 O5 的判别性用例）。
  const [slot, setSlot] = useState<PhaseSlot>({ key: "", phase: INITIAL_PHASE });
  const [runSeq, setRunSeq] = useState(0);
  // 当前轮次号：只有仍是当前轮的响应才允许改状态 / 触发第二步
  const ticketRef = useRef(0);

  // mutateAsync 在 react-query 里是稳定引用
  const { mutateAsync: pingAsync } = ping;
  const { mutateAsync: testAsync } = test;

  // 本轮身份 = provider + 第几次跑。关窗时为 ""（任何相位都不再匹配）。
  const runKey = open && providerId !== null ? `${providerId}#${runSeq}` : "";
  // **结构性防串台**：相位只在仍属于当前轮时才被显示，否则一律按首帧处理。
  // 比「依赖 effect 在下一 tick 把状态改回来」强：那条路上有一帧是上一轮的画面
  // （重测时尤其明显：点 Test again 后旧结果会先留在屏幕上）。这里不涉及 effect 时序。
  const phase = slot.key === runKey ? slot.phase : INITIAL_PHASE;

  useEffect(() => {
    // 早退（未打开 / 没有 provider）。StrictMode 的两次挂载调用都命中这里 ⇒ 零请求（见文件头）。
    if (!open || providerId === null) {
      // 关窗即清空相位：重开时首帧就是 pinging，不会闪回上一轮（runKey 此时已变 ""，
      // 这一句是为了「重开后 runKey 又会变回同一个值」的那个缝隙）。
      setSlot({ key: "", phase: INITIAL_PHASE });
      return;
    }
    const key = `${providerId}#${runSeq}`;
    const put = (next: TestRunPhase) => {
      setSlot({ key, phase: next });
    };
    const ticket = ++ticketRef.current;
    const alive = () => ticketRef.current === ticket;

    put({ kind: "pinging" });

    void (async () => {
      // 第一步：联通性。失败时靠 `stage` 分辨归因（ping 挂了 ⇒ 没有 ping 结果可显示）。
      let stage: "ping" | "test" = "ping";
      let pingResult: ProviderPingResult | null = null;
      try {
        const pingOut = await pingAsync(providerId);
        if (!alive()) {
          return; // 关窗 / 重测 / 换了 provider：本轮作废，别污染新轮的状态
        }
        pingResult = pingOut.ping;
        const reachable = pingResult;
        if (!reachable.reachable) {
          // **未联通 ⇒ 到此为止**：一条模型调用都不发（这是本批次的核心语义）
          put({ kind: "skipped", ping: reachable });
          return;
        }

        // 第二步：三条协议。先落 ping 相位再起飞，保证「ping 结果已经显示出来了」
        put({ kind: "probing", ping: reachable });
        stage = "test";
        const testOut = await testAsync(providerId);
        if (!alive()) {
          return;
        }
        put({
          kind: "ready",
          ping: reachable,
          model: testOut.model,
          timeoutMs: testOut.timeoutMs,
          probes: testOut.probes,
        });
      } catch (error) {
        if (!alive()) {
          return;
        }
        // ping 阶段的失败 ⇒ 没有任何 ping 结果可显示（ping: null，视图据此只出错、不画行）
        put({
          kind: "failed",
          ping: stage === "test" ? pingResult : null,
          message: messageOf(error),
        });
      }
    })();

    // 清理 = 本轮作废：关窗、切 provider、restart（runSeq 变化）、卸载都走这里。
    // 已经在途的请求无法撤回（如实写在 spec 里），但它的结果不会再被采用、
    // 更不会触发第二步 —— 「关窗即停」的落点就在这一行。
    return () => {
      ticketRef.current++;
    };
  }, [open, providerId, runSeq, pingAsync, testAsync]);

  const restart = useCallback(() => {
    setRunSeq((n) => n + 1);
  }, []);

  return { phase, restart };
}
