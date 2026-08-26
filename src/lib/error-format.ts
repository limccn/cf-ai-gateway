// 统一 zod 校验错误格式（M8 8.2）：@hono/zod-validator v0.9 校验失败时直接返回
// 400 响应体 `{success:false, error: <ZodError 序列化>}`（safeParse 结果序列化），
// 与项目统一错误格式 `{error:{message}}` 不一致。这里提供检测与转换的纯函数，由
// src/index.ts 的全局中间件对全部响应做一次重写——不逐调用点修改（journal 延期项 1）。
// 转换后的 message 与 onError 中 ZodError 分支同格式：
// `Validation failed: <path>: <issue.message>`（path 为空时用 "body"）。
//
// ZodError 的序列化形态随 zod 版本不同：
// - zod v3 / 部分版本：`{issues:[...]}`（issues 为可枚举数组属性）；
// - zod v4（本项目）：`{name:"ZodError", message:"<issues 数组的 JSON 字符串>"}`。
// 两种形态都检测，message 统一取首个 issue 的可读描述。

interface ParsedZodIssue {
  path?: Array<string | number>;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** 是否为 @hono/zod-validator 校验失败响应体（{success:false, error: ZodError 序列化}）。 */
export function isZodValidatorErrorBody(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  if (body["success"] !== false) {
    return false;
  }
  const error = body["error"];
  if (!isRecord(error)) {
    return false;
  }
  if (Array.isArray(error["issues"])) {
    return true;
  }
  return error["name"] === "ZodError" && typeof error["message"] === "string";
}

/** 从两种 ZodError 序列化形态中提取 issues 数组（解析失败回退空数组）。 */
function extractIssues(error: Record<string, unknown>): ParsedZodIssue[] {
  const issues = error["issues"];
  if (Array.isArray(issues)) {
    return issues as ParsedZodIssue[];
  }
  if (typeof error["message"] === "string") {
    try {
      const parsed: unknown = JSON.parse(error["message"]);
      if (Array.isArray(parsed)) {
        return parsed as ParsedZodIssue[];
      }
    } catch {
      // 非 JSON message：回退空数组
    }
  }
  return [];
}

/**
 * zod-validator 错误体 → 统一 `{error:{message}}`；非 zod-validator 形状返回 null（不重写）。
 * 供全局中间件使用：仅在检测到 zod 校验失败时替换，其余 400 响应原样返回。
 */
export function toUnifiedErrorBody(
  body: unknown,
): { error: { message: string } } | null {
  if (!isZodValidatorErrorBody(body)) {
    return null;
  }
  if (!isRecord(body)) {
    return null;
  }
  const error = body["error"];
  if (!isRecord(error)) {
    return null;
  }
  const first = extractIssues(error)[0];
  if (first === undefined) {
    return { error: { message: "Validation failed: Invalid request" } };
  }
  const path =
    first.path !== undefined && first.path.length > 0
      ? first.path.join(".")
      : "body";
  return {
    error: { message: `Validation failed: ${path}: ${first.message}` },
  };
}
