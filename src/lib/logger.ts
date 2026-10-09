// 结构化 JSON logger（spec quality.md：禁 console.log，用结构化日志）。
// console 仅在本文件内部使用（本文件是唯一的日志输出口）；wrangler dev 会将 stdout 输出到终端。
/* eslint-disable no-console */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

type LogLevel = "info" | "warn" | "error";

function write(
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// 模块级 logger：仅用于非请求上下文（queue handler、onError 兜底等）。
export const logger: Logger = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

// 请求级 logger：由 requestContext 中间件创建，附带 requestId（及后续 userId 等上下文）。
// spec environment.md：请求日志统一走上下文中的 logger，不新建实例。
export function createRequestLogger(requestId: string): Logger {
  const base = { requestId };
  return {
    info: (message, fields) => write("info", message, { ...base, ...fields }),
    warn: (message, fields) => write("warn", message, { ...base, ...fields }),
    error: (message, fields) =>
      write("error", message, { ...base, ...fields }),
  };
}
