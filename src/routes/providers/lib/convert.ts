// DB → API 响应转换（type-safety spec：models JSON 解析与密钥脱敏集中在转换工具）。
import type { Provider } from "../../../db/schema";
import { maskSecret } from "../../../lib/mask";
import { parseProviderModels } from "../../../lib/provider-models";
import type { ProviderResponse, ProviderType } from "../types";

/**
 * DB providers 行 → API 响应。
 * - apiKeyEnc 为 AES-GCM 密文，绝不回显；仅返回 maskSecret 后的展示串。
 * - models 列是 JSON 字符串，解析失败按空映射处理（不应发生，防御性兜底）。
 */
export function toProviderResponse(provider: Provider): ProviderResponse {
  const models = parseProviderModels(provider.models);
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type as ProviderType,
    baseUrl: provider.baseUrl,
    // 仅用明文前缀脱敏展示（如 `sk-mock-ope****`）；AES-GCM 密文永不下发
    apiKeyMasked: maskSecret(provider.apiKeyPrefix),
    models,
    enabled: provider.enabled,
    createdAt: provider.createdAt.toISOString(),
  };
}
