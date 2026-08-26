// 上游转发工具（M3 3.3 第六步）：超时控制 + 错误响应归一化。
import type { Logger } from "./logger";

/** 上游超时默认值（毫秒）；M4 起可配置化。 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

export class UpstreamTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Upstream request timed out after ${timeoutMs}ms`);
    this.name = "UpstreamTimeoutError";
  }
}

/**
 * 带超时的 fetch（AbortController，请求处理内创建，无全局 I/O）。
 * 超时抛 UpstreamTimeoutError；网络/解析错误原样上抛（调用方映射 502）。
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new UpstreamTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 上游非 2xx 响应 → 可读错误消息（OpenAI 风格 `{error:{message}}` 优先提取；
 * 非 JSON 响应退回状态行）。
 */
export async function extractUpstreamError(resp: Response): Promise<string> {
  const fallback = `Upstream provider returned ${resp.status} ${resp.statusText}`.trim();
  try {
    const raw: unknown = await resp.json();
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const err = obj["error"];
      if (err && typeof err === "object") {
        const message = (err as Record<string, unknown>)["message"];
        if (typeof message === "string" && message.length > 0) {
          return message;
        }
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** 上游调用错误 → OpenAI 风格日志字段（避免记录密钥等敏感字段）。 */
export function logUpstreamError(
  logger: Logger,
  providerId: number,
  model: string,
  error: unknown,
): void {
  if (error instanceof Error) {
    logger.error("upstream_request_failed", {
      providerId,
      model,
      error: error.message,
    });
  } else {
    logger.error("upstream_request_failed", { providerId, model });
  }
}
