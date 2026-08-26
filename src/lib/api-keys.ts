// 网关 API Key 生成/展示工具（M3 3.1）。
// 格式：`gw_` + 32 位 Base62 随机串（≈190 bits 熵）；DB 只存 sha256 哈希 + 前缀。
import { generateSecureCode } from "./security";

export const GATEWAY_KEY_PREFIX = "gw_";
const RANDOM_LENGTH = 32;
/** 前缀长度：创建后 UI 仅凭前缀即可识别（如 gw_AbCdEf12）。 */
const PREFIX_LENGTH = 10;

/** 生成明文网关 Key（仅在创建响应中返回一次）。 */
export function generateGatewayKey(): string {
  return `${GATEWAY_KEY_PREFIX}${generateSecureCode(RANDOM_LENGTH)}`;
}

/** 存储用前缀（明文前 10 字符，用于列表展示与检索，不敏感）。 */
export function extractKeyPrefix(plainKey: string): string {
  return plainKey.slice(0, PREFIX_LENGTH);
}
