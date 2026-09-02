// OpenAI 兼容适配器（3.4）：请求即 OpenAI 形态，仅替换 base_url + Authorization；
// 流式为透传（上游 SSE 已是 OpenAI 格式）；usage 直接读取。
import type {
  EndpointKind,
  InternalRequest,
  ProviderAdapter,
  ProviderConfig,
  TokenUsage,
  UpstreamRequest,
} from "./types";
import { resolveModelId } from "../lib/model-id";
import { applyHttpBody, buildUpstreamHeaders } from "./http-options";

const PATH_BY_KIND: Record<EndpointKind, string> = {
  chat: "/chat/completions",
  completions: "/completions",
  embeddings: "/embeddings",
};

/** 网关内部保留键：`_gateway_` 前缀（本地信号，如 Responses include reasoning），
 * 绝不转发给 OpenAI 上游（R4：一处剥离，通用安全；上游白名单构造不感知）。 */
function stripGatewayReserved(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("_gateway_")) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * reasoning_roundtrip 剥离（provider 配置驱动，Workstream B）：flag off（默认）时剥掉
 * assistant 消息的 reasoning_content——OpenAI 系上游（OpenAI/b.ai 等）不接收该字段，
 * 保持现状语义（= 未开回传时的零变化）；flag on 时保留 → deepseek 思考模式上游要求
 * thinking 轮询中把 reasoning_content 原样回传（`must be passed back to the API`）。
 */
function stripReasoningRoundtrip(
  body: Record<string, unknown>,
  keep: boolean,
): Record<string, unknown> {
  if (keep) {
    return body;
  }
  const messages = body["messages"];
  if (!Array.isArray(messages)) {
    return body;
  }
  let changed = false;
  const clean = messages.map((m) => {
    if (m && typeof m === "object" && "reasoning_content" in (m as Record<string, unknown>)) {
      const copy = { ...(m as Record<string, unknown>) };
      delete copy["reasoning_content"];
      changed = true;
      return copy;
    }
    return m;
  });
  if (!changed) {
    return body;
  }
  return { ...body, messages: clean };
}

function buildRequest(
  req: InternalRequest,
  cfg: ProviderConfig,
): UpstreamRequest {
  // 上游模型名保留 `[1m]` 后缀（路由映射后缀感知，PRD R1.2）
  const upstreamModel = resolveModelId(cfg.models, req.model).upstream;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  let body = applyHttpBody<Record<string, unknown>>(
    stripReasoningRoundtrip(
      stripGatewayReserved({ ...req.body, model: upstreamModel }),
      cfg.reasoningRoundtrip === true,
    ),
    cfg,
  );
  body = ensureStreamIncludeUsage(body).body;
  return {
    url: `${baseUrl}${PATH_BY_KIND[req.kind]}`,
    init: {
      method: "POST",
      headers: buildUpstreamHeaders(
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        cfg,
      ),
      body: JSON.stringify(body),
    },
  };
}

/**
 * F1（安全评审）：流式计费兜底 —— 规范 OpenAI 上游仅显式请求才返回 usage 尾包，
 * 不注入则无 usage 帧 → 计费落空（免单）。强制 include_usage（计费优先，客户端无权关闭）；
 * 用户已有 stream_options 其他字段保留（浅拷贝，不污染原始 body）。
 * 非流式 / 已含 include_usage=true → 零变化（返回原引用）。
 */
export function ensureStreamIncludeUsage(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; changed: boolean } {
  if (body.stream !== true) {
    return { body, changed: false };
  }
  const existing = (body.stream_options ?? {}) as Record<string, unknown>;
  if (existing.include_usage === true) {
    return { body, changed: false };
  }
  return {
    body: { ...body, stream_options: { ...existing, include_usage: true } },
    changed: true,
  };
}

/** 从 OpenAI 形态响应对象中提取 usage（流式尾包与普通响应同构）。 */
export function parseOpenAiUsage(body: unknown): TokenUsage | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const usage = (body as Record<string, unknown>)["usage"];
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const prompt = u["prompt_tokens"];
  const completion = u["completion_tokens"];
  if (typeof prompt !== "number" || typeof completion !== "number") {
    return null;
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: extractCachedTokens(u),
  };
}

/** 提取 OpenAI 形态 `usage.prompt_tokens_details.cached_tokens`；缺失/非数字返回 undefined。 */
function extractCachedTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage["prompt_tokens_details"];
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const cached = (details as Record<string, unknown>)["cached_tokens"];
  return typeof cached === "number" && Number.isFinite(cached) && cached > 0 ? cached : undefined;
}

export const openaiAdapter: ProviderAdapter = {
  type: "openai",

  supports(): boolean {
    return true;
  },

  buildRequest,

  // 无 transformResponse：上游响应原样透传（已是 OpenAI 格式）

  parseUsage: parseOpenAiUsage,

  parseStreamUsage: parseOpenAiUsage,

  // 流式透传：上游 SSE 已是 OpenAI chunk 格式（含末尾 usage 尾包与 [DONE]）
  transformStreamToOpenAI(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return body;
  },
};
