// 高级 HTTP 选项应用（PRD R2）：两个适配器共享的 headers / body 强制覆盖逻辑。
// 语义：httpOptions 配置值总是覆盖适配器默认值与请求值（厂商适配 + 附加认证）。

import type { ProviderConfig } from "./types";

/**
 * 构造上游请求头：适配器默认值 + 高级 HTTP 选项（强制覆盖）。
 * - httpOptions.headers 同名覆盖默认头（含认证头）。
 * - httpOptions.userAgent 存在时覆盖 User-Agent。
 */
export function buildUpstreamHeaders(
  defaults: Record<string, string>,
  cfg: ProviderConfig,
): Record<string, string> {
  const headers = { ...defaults };
  const httpOptions = cfg.httpOptions;
  if (httpOptions === undefined) {
    return headers;
  }
  if (httpOptions.headers !== undefined) {
    Object.assign(headers, httpOptions.headers);
  }
  if (httpOptions.userAgent !== undefined) {
    headers["User-Agent"] = httpOptions.userAgent;
  }
  return headers;
}

/** body 强制覆盖（R2.4）：配置字段覆盖出站 body 同名字段（如 temperature）。 */
export function applyHttpBody<T extends Record<string, unknown>>(
  body: T,
  cfg: ProviderConfig,
): T {
  if (cfg.httpOptions?.body !== undefined) {
    Object.assign(body, cfg.httpOptions.body);
  }
  return body;
}
