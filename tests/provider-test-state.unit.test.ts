// Test connection 弹窗相位状态机 + 文案单元测试（09-14 批次 O，2026-09-21；PRD D14–D16）。
//
// 为什么文案要单独测：批次 N 的独立复核揪出过一句「Nothing is billed」—— 那是**兑现不了的承诺**
// （第二步是三条真实上游调用，且 provider 的 `httpOptions.body` 会覆盖 max_tokens=16 这个默认值，
// 配了 {"max_tokens": 8192} 就是三条真实大生成）。当时的结论是「文案错了」，改完就完了；
// 本批次把同一类错误变成**可执行断言**：文案与相位的绑定关系一旦漂移，这里立刻红。
//
// 三类断言，各有各的失败模式：
//   1. **不许出现的**（全相位）：任何「不产生费用」的说法。语义上无解 —— 网关确实不记账，
//      但用户读到的是「这次测试不花钱」，而账单在 provider 那边。
//   2. **必须出现的**：`probing`/`ready` 必须披露上游计费风险；`skipped` 必须说清
//      「跳过了三条协议」「没往上游发任何模型调用」「这不是对密钥的判决」。第③条是为
//      D14 的已知假阴性兜底：挂在反向代理 / mTLS 后面的主机可能**在连接层**拒掉无凭据请求，
//      那时 ping 报不可达而主机其实是通的 —— 不说这句，用户会拿它当「key 失效」的证据。
//   3. **两个谓词不许混**：`reachable`（收到任何 HTTP 回应，含 401/403/404）≠ `ok`（2xx）。
//      混在一句汇总里必然说谎，混在状态串里会把「上游拒绝了这次调用」读成「网络不通」。
import { describe, expect, it } from "vitest";
import {
  dialogDescription,
  INITIAL_PHASE,
  pingStatusLabel,
  PING_ROW_LABEL,
  REACHABILITY_DOCTRINE,
  SKIP_NOTICE,
  type TestRunPhase,
} from "../app/modules/providers/provider-test-state";
import type {
  ProviderPingResult,
  ProviderProbeResult,
} from "../app/modules/providers/types";

/** 联通性结果夹具。`status` 与 `reachable` 显式传入 —— 两者的组合正是本文件的被测对象。 */
function ping(over: Partial<ProviderPingResult> = {}): ProviderPingResult {
  return {
    url: "https://upstream.example:8443/",
    reachable: true,
    status: 404,
    statusText: "Not Found",
    ttfbMs: 12,
    totalMs: 12,
    error: null,
    ...over,
  };
}

function probe(over: Partial<ProviderProbeResult> = {}): ProviderProbeResult {
  return {
    protocol: "openai-chat",
    label: "OpenAI Chat Completions",
    url: "https://upstream.example:8443/v1/chat/completions",
    ok: true,
    status: 200,
    statusText: "OK",
    ttfbMs: 30,
    totalMs: 40,
    error: null,
    ...over,
  };
}

/** 五种相位各一份，供「全相位」类断言遍历（判别联合的穷举由类型系统守住）。 */
const ALL_PHASES: TestRunPhase[] = [
  { kind: "pinging" },
  { kind: "probing", ping: ping() },
  { kind: "skipped", ping: ping({ reachable: false, status: null, statusText: null }) },
  { kind: "ready", ping: ping(), model: "gpt-4o-mini-2024-07-18", timeoutMs: 30_000, probes: [probe()] },
  { kind: "failed", ping: null, message: "boom" },
];

const descOf = (kind: TestRunPhase["kind"]): string => {
  const phase = ALL_PHASES.find((p) => p.kind === kind);
  if (!phase) {
    throw new Error(`夹具缺相位 ${kind}`); // 显式收窄，不用 non-null assertion
  }
  return dialogDescription(phase);
};

describe("dialogDescription —— 「不产生费用」是任何相位都不许说的话", () => {
  // 逐条列出实际出现过的措辞 + 常见变体：单测不可能穷举自然语言，但**至少**让
  // 「Nothing is billed」这个前科无法回归，并覆盖住最可能被顺手写下的几个同义说法。
  const FORBIDDEN = /nothing is billed|no cost|free of charge|no charge|won't be billed|will not be billed|does not bill|doesn't bill|no billing/i;

  it.each(ALL_PHASES.map((p) => p.kind))("%s 相位的描述不含任何「不产生费用」的说法", (kind) => {
    expect(descOf(kind)).not.toMatch(FORBIDDEN);
  });

  // 判别性用例，且**只**断言真正成立的那条性质：`probing`/`ready`/`failed@test` 三句
  // 刻意共用同一段文案（三者都处在「三条真实调用已经发出去了」的语义里，措辞该一样），
  // 所以「五句两两不同」是过强的断言、不对应任何用户可见要求。真正不允许相同的是
  // **「一条调用都没发生」与「刚发了三条调用」这两个语义相反的位置** ——
  // 批次 N 的缺陷正是这里：一句静态文案同时套在所有相位上。
  it("「没发生上游调用」的相位与「已发生」的相位，描述必须不同", () => {
    const didCall = descOf("ready");
    for (const kind of ["pinging", "skipped"] as const) {
      expect(descOf(kind)).not.toBe(didCall);
    }
  });
});

describe("dialogDescription —— 计费披露只在真的发了上游调用时出现", () => {
  // 正反两侧都断言：只断言「pinging 不说 bill」会在「所有相位都不说 bill」时静默变绿。
  it("probing / ready 披露上游可能计费（那时三条真实调用已发出）", () => {
    expect(descOf("probing")).toMatch(/may bill/i);
    expect(descOf("ready")).toMatch(/may bill/i);
  });

  it("pinging 不提计费（第一步无凭据 HEAD，一条模型调用都没发生）", () => {
    expect(descOf("pinging")).not.toMatch(/bill/i);
  });

  it("skipped 不提计费（三条协议根本没跑，说「可能计费」是凭空吓人）", () => {
    expect(descOf("skipped")).not.toMatch(/bill/i);
  });

  it("failed@ping 不提计费（连通性检查都没跑成，更没有上游调用）", () => {
    expect(descOf("failed")).not.toMatch(/bill/i);
  });

  it("failed@test 披露计费（ping 结果在场 ⇒ 协议探测已经发出去过）", () => {
    const desc = dialogDescription({ kind: "failed", ping: ping(), message: "boom" });
    expect(desc).toMatch(/may bill/i);
  });

  it("每个**终态/已发调用**相位都声明网关自身不计账（「测试失败=被下线」的顾虑要主动消解）", () => {
    // 不含 `pinging`：那是 10s 内的过渡帧，用户不会从它得出「provider 被下线了」的结论，
    // 它那句「这一步不发模型调用」是另一个（也恰当的）安民告示。把 pinging 排除在外是
    // 按语义收窄，不是为了让断言变绿 —— 真正需要这句话的是会显示红行的那些相位。
    for (const phase of ALL_PHASES.filter((p) => p.kind !== "pinging")) {
      expect(dialogDescription(phase)).toMatch(/no usage|no provider state/i);
    }
  });
});

describe("SKIP_NOTICE —— 未联通时用户必须知道的三件事", () => {
  it("① 三条协议探测被跳过了", () => {
    expect(SKIP_NOTICE).toMatch(/skipped/i);
  });

  it("② 上游没有收到任何模型调用", () => {
    expect(SKIP_NOTICE).toMatch(/no request was sent|nothing was sent/i);
  });

  it("③ 这不是对密钥的判决（D14 的已知假阴性：连接层就可能被拒）", () => {
    expect(SKIP_NOTICE).toMatch(/not a verdict on your api key/i);
  });

  it("反面对照：不许把它写成「密钥无效」「provider 已停用」", () => {
    expect(SKIP_NOTICE).not.toMatch(/invalid (api )?key|key is invalid|disabled|deactivat/i);
  });
});

describe("REACHABILITY_DOCTRINE —— D14 的口径要原样说给用户听", () => {
  it("明说 401/403/404 也算联通（用户看到绿点最可能的误读是「key 对了」）", () => {
    expect(REACHABILITY_DOCTRINE).toMatch(/401/);
    expect(REACHABILITY_DOCTRINE).toMatch(/403/);
    expect(REACHABILITY_DOCTRINE).toMatch(/404/);
    expect(REACHABILITY_DOCTRINE).toMatch(/any http response/i);
  });

  it("同时否认两件它证明不了的事", () => {
    expect(REACHABILITY_DOCTRINE).toMatch(/does not mean the upstream accepted/i);
    expect(REACHABILITY_DOCTRINE).toMatch(/nothing about your api key/i);
  });
});

describe("pingStatusLabel —— 收到了 HTTP 回应就不许说成「没有响应」", () => {
  it("有状态码：回显真实状态（404 也算联通，故这里不会写成失败）", () => {
    expect(pingStatusLabel(ping({ status: 404, statusText: "Not Found" }))).toBe("404 Not Found");
    expect(pingStatusLabel(ping({ status: 401, statusText: "Unauthorized" }))).toBe(
      "401 Unauthorized",
    );
  });

  it("statusText 为空时不留尾空格", () => {
    expect(pingStatusLabel(ping({ status: 302, statusText: "" }))).toBe("302");
  });

  it("status 不可读但 reachable ⇒ 说「收到了回应」，不说「没有响应」", () => {
    // 这条是 `status > 0` 守卫的判别性用例：运行时（workerd 的 redirect:"manual" 路径）
    // 可能出现 reachable=true 而 status 读不出来的组合，此时说 "no HTTP response" 是自相矛盾。
    const label = pingStatusLabel(ping({ status: null, statusText: null, reachable: true }));
    expect(label).toMatch(/received/i);
    expect(label).not.toMatch(/no http response/i);
  });

  it("网络层失败（reachable=false, status=null）⇒ 才说「没有响应」", () => {
    const label = pingStatusLabel(
      ping({ reachable: false, status: null, statusText: null, error: "connect ECONNREFUSED" }),
    );
    expect(label).toBe("no HTTP response");
  });

  it("status 为 0（读到了但无意义）不被当成真实状态码回显", () => {
    expect(pingStatusLabel(ping({ status: 0, statusText: "" }))).toMatch(/unreadable/i);
  });
});

describe("PING_ROW_LABEL 与协议行不许串味", () => {
  it("标签不是协议行的任何一个（探针按标签做行集合比对）", () => {
    expect(PING_ROW_LABEL).not.toMatch(/openai|anthropic|messages|chat completions|responses/i);
  });

  it("标签本身不含 passed/failed/reachable —— 那些是 sr-only 状态串，混进标签会让探针误匹配", () => {
    expect(PING_ROW_LABEL).not.toMatch(/passed|failed|reachable/i);
  });
});

describe("INITIAL_PHASE —— 首帧必须有内容", () => {
  it("初始相位是 pinging（不是 null/空态）：open 那一帧 effect 还没跑，弹窗不能是空白", () => {
    expect(INITIAL_PHASE.kind).toBe("pinging");
  });

  it("pinging 的描述能独立成立（首帧就会显示它）", () => {
    expect(dialogDescription(INITIAL_PHASE)).toMatch(/reachab/i);
  });
});
