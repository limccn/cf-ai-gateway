// DB → API 响应转换（type-safety spec：models JSON 解析与密钥脱敏集中在转换工具）。
import type { Provider } from "../../../db/schema";
import { maskHeaderValue, maskSecret } from "../../../lib/mask";
import { parseProviderModels } from "../../../lib/provider-models";
import type { HttpOptions } from "../../../providers/types";
import type { ProviderResponse, ProviderType, ThinkingMode } from "../types";

/**
 * DB providers 行 → API 响应。
 * - apiKeyEnc 为 AES-GCM 密文，绝不回显；仅返回 maskSecret 后的展示串。
 * - models 列是 JSON 字符串，解析失败按空映射处理（不应发生，防御性兜底）。
 * - httpOptions（解密后的明文）：headers 值一律掩码（`****abcd`），body 与 userAgent 明文；
 *   未配置（null）→ 空对象。
 */
export function toProviderResponse(
  provider: Provider,
  httpOptions: HttpOptions | null = null,
): ProviderResponse {
  const models = parseProviderModels(provider.models);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(httpOptions?.headers ?? {})) {
    headers[name] = maskHeaderValue(value);
  }
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type as ProviderType,
    baseUrl: provider.baseUrl,
    // 仅用明文前缀脱敏展示（如 `sk-mock-ope****`）；AES-GCM 密文永不下发。
    // **空前缀 ⇒ 空串，不是 `"****"`**（09-21-seed-migration-tooling R-A15）：`"****"` 与
    // 真实密钥的掩码逐字相同 ⇒ 管理台会把「未配置」显示成「已配置」。判据属**响应契约**，
    // 故放在这里而不是 maskSecret 里 —— 后者是通用脱敏工具（任何入参都该吐出掩码）。
    // 迁移后 prod 的 10/10 个 provider 都是空前缀，这条不是边角路径。
    apiKeyMasked: provider.apiKeyPrefix ? maskSecret(provider.apiKeyPrefix) : "",
    models,
    weight: typeof provider.weight === "number" ? provider.weight : 1,
    enabled: provider.enabled,
    // R2：思考模式直通（NULL ≡ auto，响应显式返回 null）
    thinkingMode: (provider.thinkingMode ?? null) as ThinkingMode,
    // Workstream B：reasoning 回传直通（DB boolean 非空默认 false）
    reasoningRoundtrip: provider.reasoningRoundtrip === true,
    // 09-01-stg-glm-ccswitch-fix：上游超时直通（NULL ≡ 默认 60s，响应显式返回 null）
    upstreamTimeoutMs: provider.upstreamTimeoutMs ?? null,
    httpOptions: {
      ...(httpOptions?.userAgent !== undefined ? { userAgent: httpOptions.userAgent } : {}),
      headers,
      body: httpOptions?.body ?? {},
    },
    createdAt: provider.createdAt.toISOString(),
  };
}
