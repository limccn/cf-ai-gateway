// 安全原语（spec backend/security.md）。
// - 网关 API Key / 一次性 code：generateSecureCode + hashToken（SHA-256，只存哈希）
// - 上游 Provider 密钥：AES-GCM 加密存储（GATEWAY_SECRET_KEY 派生密钥）
// 注意：所有 crypto 调用必须在请求处理函数内执行（Workers 禁止全局作用域 I/O）。
const CODE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 生成密码学安全随机串（Base62，length 字符 ≈ 5.95×length bits 熵）。 */
export function generateSecureCode(length = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => CODE_CHARS[byte % CODE_CHARS.length]).join(
    "",
  );
}

/** SHA-256 哈希（hex）。明文仅出现在请求内存中，落库一律为哈希。 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** 常量时间字符串比较（防时序侧信道）。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** 校验明文 token 与存储哈希是否匹配（恒定时长）。 */
export async function verifyToken(
  token: string,
  storedHash: string,
): Promise<boolean> {
  const tokenHash = await hashToken(token);
  return timingSafeEqual(tokenHash, storedHash);
}

// ============ AES-GCM（上游 Provider 密钥加密） ============

/**
 * 从 GATEWAY_SECRET_KEY 派生 AES-GCM 密钥。
 * 密钥长度不足 32 字节时以 SHA-256 扩展/压缩为固定 256-bit，兼容任意长度 secret。
 */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * AES-GCM 加密（随机 12 字节 IV）。
 * 存储格式：`base64(iv):base64(ciphertext)`；GCM 自带完整性校验，解密失败即抛错。
 */
export async function encryptSecret(
  plaintext: string,
  secretKey: string,
): Promise<string> {
  const key = await deriveAesKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/** AES-GCM 解密（格式/完整性错误抛错，由调用方捕获并记录）。 */
export async function decryptSecret(
  encrypted: string,
  secretKey: string,
): Promise<string> {
  const parts = encrypted.split(":");
  const ivPart = parts[0];
  const dataPart = parts[1];
  if (!ivPart || !dataPart) {
    throw new Error("Invalid encrypted payload format");
  }
  const key = await deriveAesKey(secretKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivPart) },
    key,
    base64ToBytes(dataPart),
  );
  return new TextDecoder().decode(plaintext);
}
