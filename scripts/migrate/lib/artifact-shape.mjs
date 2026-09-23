// 产物字段 ↔ DB 列的**唯一映射表**（09-21-seed-migration-tooling）。
//
// 序列化侧（render-import-sql.mjs）按它渲染 INSERT，校验侧（verify-seed.mjs）按它逐字段
// 比对目标库 —— 两边共用一份，因为"渲染时写了哪一列"与"校验时比了哪一列"一旦各写一份，
// 漂移的形态恰恰是**校验漏掉某一列而看起来全绿**。
//
// 键名（camelCase）取自 Drizzle 属性名：AC-A1 与 design §5 的字段表都用这套名字，
// 导出侧（export-seed.mjs）按同一套写产物；`undefined` 会在渲染时 fail-fast。

export const USER_FIELDS = [
  { column: "id", key: "id" },
  { column: "email", key: "email" },
  { column: "name", key: "name" },
  { column: "role", key: "role" },
  { column: "status", key: "status" },
  { column: "balance", key: "balance" },
  { column: "email_verified", key: "emailVerified" },
  { column: "image", key: "image" },
  { column: "github_id", key: "githubId" },
  { column: "signup_bonus_granted_at", key: "signupBonusGrantedAt" },
  { column: "email_verify_bonus_granted_at", key: "emailVerifyBonusGrantedAt" },
  { column: "welcome_seen_at", key: "welcomeSeenAt" },
  { column: "created_at", key: "createdAt" },
  { column: "updated_at", key: "updatedAt" },
];

/**
 * 三个 OAuth token 列恒 NULL（导出侧就没 SELECT 它们；R-A5「产物不含明文机密」与
 * R-A7「accounts 整行原样」冲突时的裁决见 export-seed.mjs 文件头）。
 * 列在这里是因为**渲染与校验都必须写/比它们**：不写 = 沿用列默认值（无默认 ⇒ NULL，恰好
 * 一致），不比 = 万一将来谁把 token 塞进产物也查不出来。
 */
export const ACCOUNT_FIELDS = [
  { column: "id", key: "id" },
  { column: "issuer", key: "issuer" },
  { column: "account_id", key: "accountId" },
  { column: "provider_id", key: "providerId" },
  { column: "user_id", key: "userId" },
  { column: "access_token", key: "accessToken" },
  { column: "refresh_token", key: "refreshToken" },
  { column: "id_token", key: "idToken" },
  { column: "access_token_expires_at", key: "accessTokenExpiresAt" },
  { column: "refresh_token_expires_at", key: "refreshTokenExpiresAt" },
  { column: "scope", key: "scope" },
  { column: "password", key: "password" },
  { column: "created_at", key: "createdAt" },
  { column: "updated_at", key: "updatedAt" },
];

export const PROVIDER_FIELDS = [
  { column: "id", key: "id" },
  { column: "name", key: "name" },
  { column: "type", key: "type" },
  { column: "base_url", key: "baseUrl" },
  { column: "api_key_enc", key: "apiKeyEnc" },
  { column: "api_key_prefix", key: "apiKeyPrefix" },
  { column: "models", key: "models" },
  { column: "http_options_enc", key: "httpOptionsEnc" },
  { column: "weight", key: "weight" },
  { column: "thinking_mode", key: "thinkingMode" },
  { column: "reasoning_roundtrip", key: "reasoningRoundtrip" },
  { column: "upstream_timeout_ms", key: "upstreamTimeoutMs" },
  { column: "enabled", key: "enabled" },
  { column: "created_at", key: "createdAt" },
];

/** 表名 → 字段表（渲染与校验的入口）。 */
export const TABLE_FIELDS = {
  users: USER_FIELDS,
  accounts: ACCOUNT_FIELDS,
  providers: PROVIDER_FIELDS,
};

/** 只含列名（导出侧的 SELECT 列清单；token 三列由导出侧自己剔除）。 */
export function columnsOf(fields) {
  return fields.map((field) => field.column);
}
