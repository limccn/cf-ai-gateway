// 网关 API Key 生成/展示工具（M3 3.1）。
// 格式：`${prefix}` + 32 位 Base62 随机串（≈190 bits 熵）；DB 只存 sha256 哈希 + 前缀。
// 前缀默认 `sk-`，可用环境变量 API_KEY_PREFIX 覆盖（非敏感环境差异值，见 spec environment.md）。
import { generateSecureCode } from "./security";

/** 默认网关 Key 前缀（环境变量 API_KEY_PREFIX 未设置 / 为空白时生效）。 */
export const DEFAULT_KEY_PREFIX = "sk-";
const RANDOM_LENGTH = 32;
/** 前缀长度：创建后 UI 仅凭前缀即可识别（如 sk-AbCdEf12）。 */
const PREFIX_LENGTH = 10;

/** 解析生效前缀：env.API_KEY_PREFIX trim 后非空则用之，否则回退默认。 */
export function resolveKeyPrefix(envPrefix?: string): string {
  const normalized = envPrefix?.trim() ?? "";
  return normalized.length > 0 ? normalized : DEFAULT_KEY_PREFIX;
}

/** 生成明文网关 Key（仅在创建响应中返回一次）。 */
export function generateGatewayKey(prefix: string): string {
  return `${prefix}${generateSecureCode(RANDOM_LENGTH)}`;
}

/** 存储用前缀（明文前 10 字符，用于列表展示与检索，不敏感）。 */
export function extractKeyPrefix(plainKey: string): string {
  return plainKey.slice(0, PREFIX_LENGTH);
}
