// 入站协议错误适配（P2）：后置重写中间件工厂。
// 仿 src/index.ts 400 重写模式：await next() 后检测 4xx/5xx JSON 错误体，
// 将 OpenAI 统一形态 `{error:{message}}`（含 @hono/zod-validator 400 形态）改写为
// 入站协议错误形态（Anthropic：`{type:"error",error:{type,message}}`）。
// 状态码与 message 原文不动；豁免 SSE（非 JSON）与已带协议错误标记（顶层 type:"error"）的响应。
import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types";
import { toUnifiedErrorBody } from "./error-format";

export type ErrorAdaptFormat = "anthropic";

/** Anthropic error.type 映射（AB §2.5/§3.4）：400/401/402/403/404/429/500/502/504/529，其余 5xx → api_error。 */
const ANTHROPIC_TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "permission_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  500: "api_error",
  502: "api_error",
  504: "overloaded_error",
  529: "overloaded_error",
};

function toAnthropicErrorType(status: number): string {
  const mapped = ANTHROPIC_TYPE_BY_STATUS[status];
  if (mapped !== undefined) {
    return mapped;
  }
  return status >= 500 ? "api_error" : "invalid_request_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** OpenAI 统一错误体 `{error:{message}}` 中提取 message；非该形态返回 null。 */
function extractOpenAiMessage(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const error = body["error"];
  if (!isRecord(error)) {
    return null;
  }
  const message = error["message"];
  return typeof message === "string" ? message : null;
}

export interface ErrorAdaptOptions {
  format: ErrorAdaptFormat;
  /**
   * 动态格式解析（08-31-protocol-auto-detect，design §4.2）：按请求上下文决定改写形态。
   * 返回 null → 不改写（保持 OpenAI 统一形态）；缺省 undefined → 恒用 options.format（现状行为逐字节不变）。
   */
  resolveFormat?: (c: Context<AppEnv>) => ErrorAdaptFormat | null;
}

export function createErrorAdaptMiddleware(
  options: ErrorAdaptOptions,
): MiddlewareHandler<AppEnv> {
  const { format, resolveFormat } = options;
  return async (c, next) => {
    await next();
    const res = c.res;
    // 动态格式（协议感知）：resolveFormat 返回 null → 不改写（OpenAI 形态原样返回）；
    // 返回 undefined（未提供）→ 缺省 format（现状行为）。注意不能用 `?? format`（会吞掉 null）。
    const resolved = resolveFormat?.(c);
    const activeFormat = resolved === undefined ? format : resolved;
    // 仅改写错误响应（4xx/5xx）；2xx 响应（含 SSE 成功流）原样返回
    if (res.status < 400 || res.status >= 600) {
      return;
    }
    const contentType = res.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) {
      return;
    }
    const cloned = res.clone();
    const body: unknown = await cloned.json().catch(() => null);
    if (!isRecord(body)) {
      return;
    }
    // 已带协议错误标记（如上游已是 Anthropic 形态）→ 透传
    if (body["type"] === "error") {
      return;
    }
    // OpenAI 统一形态 → 协议形态；zod-validator 400 形态先经 toUnifiedErrorBody 归一
    const direct = extractOpenAiMessage(body);
    const unified = toUnifiedErrorBody(body);
    const message = direct ?? unified?.error.message ?? null;
    if (message === null) {
      return;
    }
    if (activeFormat === "anthropic") {
      c.get("logger")?.warn("inbound_error_rewritten", {
        path: c.req.path,
        status: res.status,
        format: activeFormat,
      });
      c.res = c.json(
        {
          type: "error",
          error: { type: toAnthropicErrorType(res.status), message },
        },
        res.status as ContentfulStatusCode,
      );
    }
  };
}
