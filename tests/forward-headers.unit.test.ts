// 头开集转发单测（09-28-upstream-custom-type-passthrough 批次 4，design §5.1 / AC6）。
// 纯函数、无 Worker。钉三件事：
//   ① 开集放行（design §5.1 的 allow 面照抄实现）：`anthropic-beta`（anthropic-* 开集）、
//      `retry-after` / `x-should-retry`（重试恢复依据）、`x-request-id`（追踪）、
//      `anthropic-ratelimit-unified-*`（上游限流观察）——**每项都要有判别力**：放行断言与
//      拒绝断言成对出现在同一份 Headers 里（防止「输入为空 ⇒ 全绿」的夹具退化）；
//   ② deny 清单逐项「确实没透传」（双向断言纪律）：11 个精确名 + `anthropic-version`
//      版本锁例外（§5.3，防被当 bug「修」掉）+ `x-ratelimit-*` 前缀（网关自有限流头语义）；
//      每一项的断言都带同输入下的放行正对照 —— 拒绝不可能是「机器没跑」的假绿；
//   ③ 两个组装器：mergeForwardedHeaders（固定头优先 + 大小写不敏感剔除，防 Headers 组装期
//      append 合并出 "a, b" 复合值）与 errorHeadersWithContentTypeFallback（上游
//      content-type 同真；缺省兜底 application/json）。
// 拒绝语义的真源是设计文档 deny 表（不是实现）：本文件逐行对照 §5.1 表，实现与表漂移即红。
import { describe, expect, it } from "vitest";
import {
  errorHeadersWithContentTypeFallback,
  forwardUpstreamHeaders,
  isForwardableUpstreamHeader,
  mergeForwardedHeaders,
} from "../src/providers/forward-headers";

/** 同一份 Headers 里必然放行的正对照标记（四类放行代表 + 前缀开集代表）。 */
const ALLOWED_MARKERS: Record<string, string> = {
  "anthropic-beta": "safeguards-2026-08-30",
  "retry-after": "7",
  "x-should-retry": "true",
  "x-request-id": "req_probe_0001",
  "anthropic-ratelimit-unified-5m-input-token-remaining": "12345",
};

/** 断言：放行标记全部存活（正对照）+ 目标名确实不在产物里（双向判别）。 */
function expectDenied(forwarded: Record<string, string>, deniedName: string): void {
  for (const [name, value] of Object.entries(ALLOWED_MARKERS)) {
    expect(forwarded[name]).toBe(value);
  }
  expect(forwarded[deniedName]).toBeUndefined();
}

function headersWith(extra: Record<string, string>): Headers {
  return new Headers({ ...ALLOWED_MARKERS, ...extra });
}

describe("isForwardableUpstreamHeader — deny 清单逐项（design §5.1 表照抄）", () => {
  const DENY_LIST = [
    // 凭据类
    "authorization",
    "cookie",
    "set-cookie",
    "host",
    // 调用方 IP 类
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-real-ip",
    "true-client-ip",
    // 消息框架类
    "content-length",
    "content-encoding",
    "transfer-encoding",
    // 版本锁例外（§5.3：不进 anthropic-* 开集）
    "anthropic-version",
  ] as const;

  for (const denied of DENY_LIST) {
    it(`deny：${denied} 不透传（同输入放行标记全存活 → 排除「输入为空」假绿）`, () => {
      expect(isForwardableUpstreamHeader(denied)).toBe(false);
      expectDenied(forwardUpstreamHeaders(headersWith({ [denied]: "must-not-leak" })), denied);
    });
  }

  it("deny：x-ratelimit-* 前缀（网关自有限流头不接受上游同名头）", () => {
    for (const denied of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
      expect(isForwardableUpstreamHeader(denied)).toBe(false);
      expectDenied(forwardUpstreamHeaders(headersWith({ [denied]: "99" })), denied);
    }
  });

  it("前缀边界：不带连字符的同形名不受前缀拒绝（'x-ratelimits' ≠ 'x-ratelimit-*'）", () => {
    // 判别力：证明前缀匹配要求完整 'x-ratelimit-' 串，而不是 'x-ratelimit' 子串
    expect(isForwardableUpstreamHeader("x-ratelimits")).toBe(true);
  });

  it("大小写不敏感：混合大小写输入同样被拒（HTTP 头名不区分大小写）", () => {
    expect(isForwardableUpstreamHeader("SET-COOKIE")).toBe(false);
    expect(isForwardableUpstreamHeader("Set-Cookie")).toBe(false);
    expect(isForwardableUpstreamHeader("X-RateLimit-Limit")).toBe(false);
    expect(isForwardableUpstreamHeader("Anthropic-Version")).toBe(false);
    // 且 Headers 迭代出的原始大小写键不会以原样大小写漏进产物
    const forwarded = forwardUpstreamHeaders(
      new Headers({ ...ALLOWED_MARKERS, "Set-Cookie": "s=1", "X-Trace-Id": "case-check" }),
    );
    expect(forwarded["Set-Cookie"]).toBeUndefined();
    expect(forwarded["set-cookie"]).toBeUndefined();
    // 放行头经 Headers 归一后以小写键产出
    expect(forwarded["x-trace-id"]).toBe("case-check");
  });

  it("同名多头：Headers 层已合并为逗号连接值，产物以小写单键透传该组合值；set-cookie 全部消失", () => {
    const raw = new Headers();
    for (const [name, value] of Object.entries(ALLOWED_MARKERS)) {
      raw.set(name, value);
    }
    raw.append("set-cookie", "a=1; Path=/");
    raw.append("set-cookie", "b=2; Path=/");
    raw.append("x-trace-id", "first");
    raw.append("x-trace-id", "second");
    const forwarded = forwardUpstreamHeaders(raw);
    // deny 清单内的多头一个都不出现（Headers.forEach 对 set-cookie 逐值迭代，逐值命中 deny）
    expect(forwarded["set-cookie"]).toBeUndefined();
    // 其余头重复对客户端语义无害（HTTP 语义本就是逗号连接集合）
    expect(forwarded["x-trace-id"]).toBe("first, second");
  });
});

describe("forwardUpstreamHeaders — 产物形态", () => {
  it("键统一小写（上游 'X-Trace-Id' → 产物 'x-trace-id'）", () => {
    const forwarded = forwardUpstreamHeaders(
      new Headers({ ...ALLOWED_MARKERS, "X-Trace-Id": "case-check" }),
    );
    expect(forwarded["x-trace-id"]).toBe("case-check");
    expect(forwarded["X-Trace-Id"]).toBeUndefined();
  });

  it("空 Headers ⇒ 空产物（无键凭空出现）", () => {
    expect(forwardUpstreamHeaders(new Headers())).toEqual({});
  });
});

describe("mergeForwardedHeaders — 固定头优先（防 append 合并 'a, b'）", () => {
  it("forwarded=undefined ⇒ {...fixed} 浅拷贝（convert 路径与既有行为逐字段一致）", () => {
    const fixed = { "Content-Type": "application/json" };
    const merged = mergeForwardedHeaders(undefined, fixed);
    expect(merged).toEqual(fixed);
    // 浅拷贝：改产物不得污染 fixed（后续请求复用字面量）
    merged["Content-Type"] = "mutated";
    expect(fixed["Content-Type"]).toBe("application/json");
  });

  it("大小写不敏感剔除：转发集的 'content-type' 与固定 'Content-Type' 同名 ⇒ 固定值独占", () => {
    // 判别力：若不剔除，Headers 构造期 append 会把两值合并成 'application/json, text/event-stream'
    const merged = mergeForwardedHeaders(
      { "content-type": "application/json", "x-request-id": "r1" },
      { "Content-Type": "text/event-stream" },
    );
    expect(merged["Content-Type"]).toBe("text/event-stream");
    expect(merged["content-type"]).toBeUndefined();
    expect(merged["x-request-id"]).toBe("r1");
  });

  it("反向大小写：转发集大写、固定小写同样剔除", () => {
    const merged = mergeForwardedHeaders(
      { "Content-Type": "text/html", "retry-after": "3" },
      { "content-type": "application/json" },
    );
    expect(merged["content-type"]).toBe("application/json");
    expect(merged["Content-Type"]).toBeUndefined();
    expect(merged["retry-after"]).toBe("3");
  });

  it("固定头不被转发集覆盖（固定优先，网关承诺不可被上游改写）", () => {
    const merged = mergeForwardedHeaders(
      { "Cache-Control": "public, max-age=999" },
      { "Cache-Control": "no-cache" },
    );
    expect(merged["Cache-Control"]).toBe("no-cache");
  });
});

describe("errorHeadersWithContentTypeFallback — 错误体内容类型", () => {
  it("上游带 content-type ⇒ 原样保留（逐字语义：内容类型同真）", () => {
    const out = errorHeadersWithContentTypeFallback({
      "content-type": "application/problem+json",
      "retry-after": "7",
    });
    expect(out["content-type"]).toBe("application/problem+json");
    expect(out["retry-after"]).toBe("7");
  });

  it("上游无 content-type ⇒ 兜底 application/json（c.body 裸文本缺省落 text/plain，破坏 JSON 解析）", () => {
    const out = errorHeadersWithContentTypeFallback({ "x-request-id": "r" });
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["x-request-id"]).toBe("r");
  });

  it("兜底判定大小写不敏感（上游 'CONTENT-TYPE' 不再重复兜底）", () => {
    const out = errorHeadersWithContentTypeFallback({ "CONTENT-TYPE": "text/plain" });
    expect(out["CONTENT-TYPE"]).toBe("text/plain");
    expect(out["Content-Type"]).toBeUndefined();
  });

  it("undefined ⇒ 仅兜底头", () => {
    expect(errorHeadersWithContentTypeFallback(undefined)).toEqual({
      "Content-Type": "application/json",
    });
  });
});
