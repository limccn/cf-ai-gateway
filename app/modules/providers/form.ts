// providers 表单的纯逻辑层：字段状态、校验 schema、文本 ↔ 结构互转。
//
// 从 app/routes/providers.tsx 抽出（批次 N，2026-09-21，PRD 裁决 D13）。抽出的理由是
// **三个入口必须共用同一份规则**：Add provider（不拆，一个弹窗）+ Edit basics + Edit advanced。
// 校验与回填各写一遍必然漂移，而漂移的后果是「同一个字段在 Add 能存、在 Edit 存不进去」。
//
// 与后端 src/routes/providers/types.ts 的校验规则一致（header 名 token 字符集、值禁 CR/LF、
// 长度上限、超时 1000–600000）；前端校验只为即时反馈，后端仍是权威。
import { z } from "zod";
import { httpOptionsSchema } from "../../../src/routes/providers/types";
import type { ProviderResponse, ProviderType, ThinkingMode } from "./types";

// ============= 单个字段的规则（三处入口共用）=============

const nameField = z.string().min(1, "Name is required").max(100, "Max 100 characters");
const typeField = z.enum(["openai", "anthropic"]);
const baseUrlField = z.string().url("Enter a valid URL").max(500);
const apiKeyField = z.string().min(1, "API key is required").max(1000);
const weightField = z.coerce.number().int("Must be a whole number").min(1, "Min 1").max(1000, "Max 1000");
// R2 思考模式（null ≡ auto）；仅 anthropic 上游有意义
const thinkingModeField = z.enum(["adaptive", "budget", "off"]).nullable().optional();
// Workstream B：reasoning 回传（仅 openai 上游有意义）
const reasoningRoundtripField = z.boolean().optional();
// 09-01-stg-glm-ccswitch-fix：上游超时（ms；null ≡ 默认 60s；UI 空输入 = null）
const upstreamTimeoutMsField = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? null : v),
  z.coerce
    .number()
    .int("Must be a whole number")
    .min(1000, "Min 1000 ms")
    .max(600000, "Max 600000 ms")
    .nullable()
    .optional(),
);

/** textarea 行格式 → 路由映射对象（内部名=上游名，每行一个）。 */
export const modelsMapTextSchema = z
  .string()
  .transform((text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )
  .refine((lines) => lines.length > 0, {
    message: "At least one model mapping is required",
  })
  .refine((lines) => lines.every((line) => line.includes("=")), {
    message: "Each line must be in the form: internalName=upstreamName",
  })
  .transform((lines) => {
    const record: Record<string, string> = {};
    for (const line of lines) {
      const [key, ...rest] = line.split("=");
      if (key === undefined) {
        continue;
      }
      const internal = key.trim();
      const upstream = rest.join("=").trim();
      if (internal.length > 0 && upstream.length > 0) {
        record[internal] = upstream;
      }
    }
    return record;
  })
  .refine((record) => Object.keys(record).length > 0, {
    message: "Each mapping needs a non-empty internal and upstream name",
  });

export function modelsToText(models: Record<string, string>): string {
  return Object.entries(models)
    .map(([internal, upstream]) => `${internal}=${upstream}`)
    .join("\n");
}

// ============= httpOptions（JSON textarea）=============

/**
 * 解析 httpOptions JSON 文本 → 提交值。
 * 空文本 → undefined（创建：不配置；编辑：保持原配置）；解析/结构校验失败 → 错误消息。
 */
export function parseHttpOptionsText(
  text: string,
): { ok: true; value?: z.infer<typeof httpOptionsSchema> } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "Must be valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      message:
        'Must be a JSON object, e.g. {"userAgent":"MyAgent/1.0","headers":{"X-Provider":"acme"},"body":{"temperature":0}}',
    };
  }
  const result = httpOptionsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "";
    return {
      ok: false,
      message: `${path ? `${path}: ` : ""}${issue?.message ?? "Invalid http options"}`,
    };
  }
  return { ok: true, value: result.data };
}

/** 是否已配置 httpOptions（响应中未配置 = 空对象）。 */
export function hasHttpOptions(httpOptions: ProviderResponse["httpOptions"]): boolean {
  if (!httpOptions) {
    return false;
  }
  return (
    httpOptions.userAgent !== undefined ||
    Object.keys(httpOptions.headers ?? {}).length > 0 ||
    Object.keys(httpOptions.body ?? {}).length > 0
  );
}

/** 响应对象 → 编辑回填文本：跳过空对象字段；全部为空 → 空文本（编辑留空 = 保持原配置）。 */
export function httpOptionsToText(httpOptions: ProviderResponse["httpOptions"]): string {
  if (!httpOptions) {
    return "";
  }
  const compact: Record<string, unknown> = {};
  if (httpOptions.userAgent !== undefined) {
    compact.userAgent = httpOptions.userAgent;
  }
  if (Object.keys(httpOptions.headers ?? {}).length > 0) {
    compact.headers = httpOptions.headers;
  }
  if (Object.keys(httpOptions.body ?? {}).length > 0) {
    compact.body = httpOptions.body;
  }
  return Object.keys(compact).length === 0 ? "" : JSON.stringify(compact, null, 2);
}

// ============= 表单字段（basics / advanced 两组）=============

/** 表单全部的字段值。三个弹窗各自持有一份，按需要提交自己那组。 */
export interface ProviderFormState {
  // —— basics 组（Edit basics 与 Add 共用的那五个）——
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  modelsText: string;
  // —— advanced 组（原先收在 Collapsible 里的那五个）——
  httpOptionsText: string;
  weight: number;
  thinkingMode: ThinkingMode;
  reasoningRoundtrip: boolean;
  upstreamTimeoutMs: string;
}

/** 新建态的初值。 */
export function emptyProviderForm(): ProviderFormState {
  return {
    name: "",
    type: "openai",
    baseUrl: "",
    apiKey: "",
    modelsText: "",
    httpOptionsText: "",
    weight: 1,
    thinkingMode: null,
    reasoningRoundtrip: false,
    upstreamTimeoutMs: "",
  };
}

/**
 * 编辑态回填。**apiKey 恒为空串**（PRD N2）：响应里只有掩码 `apiKeyMasked`，明文永不下发，
 * 所以编辑态绝不预填密钥 —— 留空即「保持原密钥」（提交时整个字段省略）。
 */
export function providerToForm(provider: ProviderResponse): ProviderFormState {
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: "",
    modelsText: modelsToText(provider.models),
    httpOptionsText: httpOptionsToText(provider.httpOptions),
    weight: provider.weight,
    thinkingMode: provider.thinkingMode,
    reasoningRoundtrip: provider.reasoningRoundtrip,
    upstreamTimeoutMs: provider.upstreamTimeoutMs?.toString() ?? "",
  };
}

// ============= 提交 schema（按弹窗切分）=============

/** Add provider：五个基础字段全必填，apiKey 必填。 */
export const providerCreateFormSchema = z.object({
  name: nameField,
  type: typeField,
  baseUrl: baseUrlField,
  apiKey: apiKeyField,
  models: modelsMapTextSchema,
  weight: weightField,
  thinkingMode: thinkingModeField,
  reasoningRoundtrip: reasoningRoundtripField,
  upstreamTimeoutMs: upstreamTimeoutMsField,
});

/**
 * Edit basics：name/type/baseUrl 恒提交（表单里始终有值）；models 留空 = 保持原映射；
 * apiKey 留空 = 保持原密钥（整个字段省略，后端据「省略」判定不重加密）。
 *
 * 刻意**不包含** advanced 组字段 —— 两个编辑弹窗各提交各的，是拆分的目的本身。
 */
export const providerBasicsUpdateSchema = z.object({
  name: nameField,
  type: typeField,
  baseUrl: baseUrlField,
  apiKey: apiKeyField.optional(),
  models: modelsMapTextSchema.optional(),
});

/** Edit advanced：四个枚举/数值字段恒提交（显式传 null/false = 重置，与后端语义一致）。 */
export const providerAdvancedUpdateSchema = z.object({
  weight: weightField,
  thinkingMode: thinkingModeField,
  reasoningRoundtrip: reasoningRoundtripField,
  upstreamTimeoutMs: upstreamTimeoutMsField,
  // 留空 = 保持原配置（后端据「省略」判定不替换密文）
  httpOptions: httpOptionsSchema.optional(),
});

// ============= 提交载荷的构造 =============
//
// 这三段是「哪个弹窗提交哪些字段」的**唯一真源**，抽成纯函数是为了能被单测直接钉住：
// 两个编辑弹窗各提交各的、互不携带对方字段 —— 这条契约写在 JSX 里就只能靠端到端碰运气，
// 写在这里则是一条 `Object.keys(data)` 断言。判别力在于**故意多喂**：给 basics 的载荷
// 塞进 weight，断言它不会出现在结果里（Zod object 默认剥离未声明键）。

export type FieldErrors = Partial<Record<string, string>>;

export type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

/** Zod issues → 字段错误表（多个 issue 落在同一字段时保留第一条）。 */
export function issuesToErrors(issues: { path: PropertyKey[]; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "root");
    if (errors[key] === undefined) {
      errors[key] = issue.message;
    }
  }
  return errors;
}

/**
 * Add provider 的 POST body。
 * httpOptions 先单独解析：空文本 → 不配置；JSON 语法/结构错 → 落 `httpOptions` 错误位。
 */
export function parseCreateForm(
  form: ProviderFormState,
): ParseResult<z.infer<typeof providerCreateFormSchema>> {
  const httpOptions = parseHttpOptionsText(form.httpOptionsText);
  if (!httpOptions.ok) {
    return { ok: false, errors: { httpOptions: httpOptions.message } };
  }
  const parsed = providerCreateFormSchema.safeParse({
    name: form.name,
    type: form.type,
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    models: form.modelsText,
    weight: form.weight,
    thinkingMode: form.thinkingMode,
    reasoningRoundtrip: form.reasoningRoundtrip,
    upstreamTimeoutMs: form.upstreamTimeoutMs,
    ...(httpOptions.value !== undefined ? { httpOptions: httpOptions.value } : {}),
  });
  if (!parsed.success) {
    return { ok: false, errors: issuesToErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Edit basics 的 PATCH body。两条「留空 = 保持原值」都在这里落地：
 *   · apiKey 空 → 整个字段省略（后端见「省略」即不重新加密）
 *   · models 空 → 整个字段省略（后端 modelsMapSchema 要求非空，传 {} 会被 400 拒掉）
 */
export function parseBasicsUpdate(
  form: ProviderFormState,
): ParseResult<z.infer<typeof providerBasicsUpdateSchema>> {
  const parsed = providerBasicsUpdateSchema.safeParse({
    name: form.name,
    type: form.type,
    baseUrl: form.baseUrl,
    ...(form.apiKey !== "" ? { apiKey: form.apiKey } : {}),
    ...(form.modelsText.trim() !== "" ? { models: form.modelsText } : {}),
  });
  if (!parsed.success) {
    return { ok: false, errors: issuesToErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}

/** Edit advanced 的 PATCH body。httpOptions 留空 → 省略（保持原密文，含掩码哨兵语义）。 */
export function parseAdvancedUpdate(
  form: ProviderFormState,
): ParseResult<z.infer<typeof providerAdvancedUpdateSchema>> {
  const httpOptions = parseHttpOptionsText(form.httpOptionsText);
  if (!httpOptions.ok) {
    return { ok: false, errors: { httpOptions: httpOptions.message } };
  }
  const parsed = providerAdvancedUpdateSchema.safeParse({
    weight: form.weight,
    thinkingMode: form.thinkingMode,
    reasoningRoundtrip: form.reasoningRoundtrip,
    upstreamTimeoutMs: form.upstreamTimeoutMs,
    ...(httpOptions.value !== undefined ? { httpOptions: httpOptions.value } : {}),
  });
  if (!parsed.success) {
    return { ok: false, errors: issuesToErrors(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}
