// 模型级 max_tokens 上限（09-01-stg-glm-ccswitch-fix + 09-01-review U6 补强）：
// 慢模型（如 b.ai glm-5.3-flash）长生成易撞上游超时 → 请求 max_tokens 超上限时
// clamp 到上限（上游仍返回合法完成，agentic 客户端（Claude Code/Codex）天然续接）。
// **缺省兜底（U6）**：客户端省略 max_tokens/max_completion_tokens（OpenAI 合法省略）时
// 按 cap 补齐——防 adapter 缺省注入（anthropic 补 DEFAULT_MAX_TOKENS=4096）超过模型 cap
// 的事故形态复活。
// 纯函数、无副作用（仅 clamp/兜底时浅拷贝 body，不污染调用方——尝试循环内重试共享同一
// internalReq）；cap 非法（非正数/NaN）→ 原样返回（零回归）。
// 覆盖两个内部形态字段：
//   - max_tokens             chat/completions + anthropic 入站转换后
//   - max_completion_tokens  Responses 入站转换后（max_output_tokens → 该字段，1:1）

export interface ClampResult {
  /** clamp/兜底后的 body（未变化时与原 body 引用相同，零分配零回归） */
  body: Record<string, unknown>;
  /** 显式值超 cap 被压到 cap */
  clamped: boolean;
  /** 缺省兜底：cap 有效且客户端未显式提供任一字段 → 已按 cap 补齐 */
  defaulted: boolean;
  /** clamp 前的原始值（首个被 clamp 字段） */
  from?: number;
  /** clamp/兜底后的上限值（仅 clamped/defaulted 时存在） */
  to?: number;
}

const CLAMP_KEYS = ["max_tokens", "max_completion_tokens"] as const;

/**
 * 客户端显式索求的 max 值（两字段取最大；均缺/非法 → undefined）。
 * O3c（09-11-kv-ops-optimization）modelcap 快/慢路径判定用：索求 > 常量才需查真值。
 */
export function maxRequestedTokens(body: Record<string, unknown>): number | undefined {
  let max: number | undefined;
  for (const key of CLAMP_KEYS) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value) && (max === undefined || value > max)) {
      max = value;
    }
  }
  return max;
}

export function clampMaxTokens(
  body: Record<string, unknown>,
  cap: number | undefined,
): ClampResult {
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
    return { body, clamped: false, defaulted: false };
  }
  let clamped = false;
  let from: number | undefined;
  let out = body;
  for (const key of CLAMP_KEYS) {
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= cap) {
      continue;
    }
    if (!clamped) {
      out = { ...body };
      clamped = true;
      from = value;
    }
    out[key] = cap;
  }
  if (clamped) {
    return { body: out, clamped: true, defaulted: false, from, to: cap };
  }
  // U6 缺省兜底：两个 key 均缺失（含显式 null——adapter 按非数字跳过同样走缺省注入）
  // → 设为 cap（内部形态为 chat 兼容 → 设 max_tokens；anthropic adapter 的
  // pickMaxTokens 按 max_tokens 取值，缺省注入 DEFAULT_MAX_TOKENS 不再可能超过 cap）。
  const hasExplicit = CLAMP_KEYS.some((key) => body[key] != null);
  if (!hasExplicit) {
    return { body: { ...body, max_tokens: cap }, clamped: false, defaulted: true, to: cap };
  }
  return { body, clamped: false, defaulted: false };
}
