// 上游响应头 → 客户端头的开集转发（09-28-upstream-custom-type-passthrough 批次 4，
// design §5.1）。全仓此前三处头构造点（openai.ts / anthropic.ts / probe.ts）全是白名单、
// 零先例 —— 本模块是**新机制**（09-07 §9.11 G-4），不是给白名单加条目：LGP
// "Forward as open lists" 要求把头当开集对待，钉死在今日观察到的清单上会随上游演进而
// 静默丢头。因此规则是「开集转发 + 显式 deny」：不给 deny 就等于把 Authorization/Cookie/
// 调用方 IP 端点泄露出去（spec backend/security.md 同一结论）。
//
// 仅 verbatim 路径调用（proxy.ts 的流式/非流式/错误三处响应构造点）；convert 路径头行为
// 零变化（零回归红线）。网关自有 `x-ratelimit-*` 不在转发集内（design §5.1 表末行：那是
// 网关对**客户端**的承诺，不是上游的），前缀拒绝从机制上杜绝「上游同名头覆盖/合并网关
// 限流头」的冲突。`anthropic-version` 例外于 `anthropic-*` 开集（§5.3 版本锁：网关固定
// 2023-06-01，不透传客户端 pin）。

/** 绝不透传给客户端的上游响应头（精确名，小写匹配）。 */
const DENIED_HEADERS: ReadonlySet<string> = new Set([
  // 凭据类：上游视角的调用方凭据绝不能回显到网关客户端
  "authorization",
  "cookie",
  "set-cookie",
  "host",
  // 调用方 IP 类：防把终端用户 IP 泄露给上游聚合商后再被回带回来
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "true-client-ip",
  // 消息框架类：出站体由网关构造/改写，长度与编码由 Workers 运行时重算，写死会截断
  "content-length",
  "content-encoding",
  "transfer-encoding",
  // 版本锁例外（design §5.3）：anthropic-version 不进 `anthropic-*` 开集
  "anthropic-version",
]);

/** 前缀拒绝：网关自有限流头（x-ratelimit-*）保持网关语义，不接受上游同名头。 */
const DENIED_PREFIXES: readonly string[] = ["x-ratelimit-"];

/** 单个上游响应头是否可转发给客户端（精确名 + 前缀双清单；输入大小写不敏感）。 */
export function isForwardableUpstreamHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (DENIED_HEADERS.has(lower)) {
    return false;
  }
  return !DENIED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * 上游响应头 → 客户端头的开集转发产物（键统一小写；deny 清单外的头全部透传）。
 * Headers 迭代语义：同名多头（set-cookie 除外）在 Headers 层已合并为逗号连接的单值 ——
 * 组合值原样透传（HTTP 语义本就是集合）；set-cookie 逐值迭代，全部命中 deny 不出现。
 */
export function forwardUpstreamHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (isForwardableUpstreamHeader(name)) {
      out[name.toLowerCase()] = value;
    }
  });
  return out;
}

/**
 * 合并转发头与网关固定头：**固定头优先**（大小写不敏感剔除转发集中的同名键）。
 * 必须剔除而不能直接 spread：HeadersInit 组装期对同名键（content-type vs Content-Type）
 * 走 append 语义，会合并成 `"a, b"` 复合值 —— SSE 的 `text/event-stream` 会被上游自己的
 * content-type 污染成两段拼接。
 * forwarded 为 undefined（convert 路径不转发）⇒ 返回 fixed 的浅拷贝（与既有行为逐字段一致）。
 */
export function mergeForwardedHeaders(
  forwarded: Record<string, string> | undefined,
  fixed: Record<string, string>,
): Record<string, string> {
  if (forwarded === undefined) {
    return { ...fixed };
  }
  const merged: Record<string, string> = { ...forwarded };
  const fixedNames = Object.keys(fixed).map((name) => name.toLowerCase());
  for (const key of Object.keys(merged)) {
    if (fixedNames.includes(key.toLowerCase())) {
      delete merged[key];
    }
  }
  return { ...merged, ...fixed };
}

/**
 * verbatim 错误响应头：转发头原样（含上游 content-type —— 错误体逐字要求内容类型同真）；
 * 上游未给 content-type 时兜底 application/json（c.body 裸文本缺省会落 text/plain，破坏
 * 客户端 JSON 错误解析）。
 */
export function errorHeadersWithContentTypeFallback(
  forwarded: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...(forwarded ?? {}) };
  const hasContentType = Object.keys(headers).some(
    (name) => name.toLowerCase() === "content-type",
  );
  if (!hasContentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}
