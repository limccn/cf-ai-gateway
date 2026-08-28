// 敏感字段展示工具：上游 Provider 密钥 / 各类 token 的响应脱敏（spec：`sk-****abcd`）。

/**
 * 展示用脱敏：保留前缀 + `****`（如 `sk-mock-ope****`）。
 * DB 中只存 AES-GCM 密文 + 明文前缀（providers.api_key_prefix），永远不回显明文。
 */
export function maskSecret(prefix: string): string {
  return `${prefix}****`;
}

/** 存储用前缀：明文前 10 字符（用于 UI 展示与识别，不敏感）。 */
export function extractSecretPrefix(secret: string): string {
  return secret.slice(0, 10);
}

/**
 * Header 值展示脱敏（`****abcd` 风格）：短值全掩，长值保留末 4 位用于识别。
 * httpOptions.headers 值可能含上游认证信息，GET /api/providers 时使用。
 */
export function maskHeaderValue(value: string): string {
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}
