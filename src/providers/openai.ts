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

const PATH_BY_KIND: Record<EndpointKind, string> = {
  chat: "/chat/completions",
  completions: "/completions",
  embeddings: "/embeddings",
};

function buildRequest(
  req: InternalRequest,
  cfg: ProviderConfig,
): UpstreamRequest {
  const upstreamModel = cfg.models[req.model] ?? req.model;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  return {
    url: `${baseUrl}${PATH_BY_KIND[req.kind]}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ ...req.body, model: upstreamModel }),
    },
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
