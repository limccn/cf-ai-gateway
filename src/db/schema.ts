// D1 全表 schema（design.md §2 数据模型）。
// 约定：
// - 数据库列名 snake_case；时间戳 integer epoch seconds（drizzle mode "timestamp"）。
// - 网关 API Key 只存 sha256 哈希（spec 强制）；上游 Provider 密钥 AES-GCM 加密后存储。
// - 金额一律 REAL（虚拟币）；价格单位为 USD / 每百万 tokens。
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
};

// --- 用户 ---
// role: 'admin' | 'member'；balance 为预充值余额（硬配额）；status: 'active' | 'disabled'。
// M2 起该表同时充当 Better Auth 的 user 模型：
// - 列名与 Better Auth 字段名映射通过 drizzle 属性名（camelCase）匹配（id/name/email/createdAt/updatedAt/emailVerified/image）。
// - role/balance/status/githubId 为应用自有字段；其中 role/balance/status 注册为 additionalFields（input: false，不可由客户端写入）。
// - id 保持 INTEGER 自增；Better Auth 侧配置 advanced.database.generateId = "serial" 与之匹配。
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: text("role").notNull().default("member"), // 'admin' | 'member'
    status: text("status").notNull().default("active"), // 'active' | 'disabled'
    balance: real("balance").notNull().default(0),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    image: text("image"),
    githubId: text("github_id").unique(),
    ...timestamps,
  },
  (table) => [index("users_email_idx").on(table.email)],
);

// --- Better Auth session 表 ---
// 列（drizzle 属性名）与 Better Auth session 模型字段名一致：token/expiresAt/ipAddress/userAgent/userId/createdAt/updatedAt。
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull().unique(), // SHA-256 哈希后的会话 token
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("sessions_token_idx").on(table.token),
    index("sessions_user_id_idx").on(table.userId),
  ],
);

// --- Better Auth account 表 ---
// email/password 账号（providerId='credential'）与 GitHub OAuth 账号（providerId='github'）统一存储。
// password 列为 scrypt 哈希；accessToken/refreshToken 等 OAuth 令牌不对外返回。
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("accounts_issuer_account_id_idx").on(
      table.issuer,
      table.accountId,
    ),
    index("accounts_user_id_idx").on(table.userId),
  ],
);

// --- Better Auth verification 表（邮箱验证 token 等一次性记录） ---
export const verifications = sqliteTable(
  "verifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

// --- 邀请码（admin 生成，邮箱密码注册携带） ---
// code 明文存储（一次性使用 + 乐观锁置 used_at，遵循 security.md 一次性 code 模式）；
// usedAt 通过条件 UPDATE 置位，防并发重复使用。
export const inviteCodes = sqliteTable(
  "invite_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull().unique(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    usedAt: integer("used_at", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("invite_codes_created_by_idx").on(table.createdBy),
    index("invite_codes_code_idx").on(table.code),
  ],
);

// --- 网关 API Key ---
// hash = sha256(明文 key)，明文仅在创建响应中返回一次；prefix 用于 UI 识别。
/** 响应缓存默认 TTL（秒）：schema 默认值与 /api/admin/settings 展示的唯一来源。 */
export const DEFAULT_CACHE_TTL_SECONDS = 3600;

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    hash: text("hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    status: text("status").notNull().default("active"), // 'active' | 'revoked'
    qpsLimit: integer("qps_limit").notNull().default(60),
    cacheEnabled: integer("cache_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    cacheTtl: integer("cache_ttl")
      .notNull()
      .default(DEFAULT_CACHE_TTL_SECONDS), // 秒
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("api_keys_user_id_idx").on(table.userId)],
);

// --- 上游 Provider ---
// type: 'openai' | 'anthropic'；api_key_enc 为 AES-GCM 加密后的上游密钥；
// models 为 JSON 路由映射（内部模型名 -> 上游模型名）。
export const providers = sqliteTable(
  "providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEnc: text("api_key_enc").notNull(),
    // 明文前 10 字符（与 api_keys.prefix 同思路）：仅用于 UI 展示识别，不敏感
    apiKeyPrefix: text("api_key_prefix").notNull().default(""),
    models: text("models").notNull(),
    // 高级 HTTP 选项（JSON 字符串）：AES-GCM 加密存储（headers 可能含上游认证值）；
    // NULL ≡ 未配置（{}，行为与现状一致）
    httpOptionsEnc: text("http_options_enc"),
    // 负载均衡权重：多 provider 供同一模型时按 weight 比例分配（槽位法），默认 1 均分
    weight: integer("weight").notNull().default(1),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("providers_type_idx").on(table.type)],
);

// --- 余额流水 ---
// amount 带符号（充值 + / 扣费 -）；type: 'recharge' | 'usage' | 'adjust'。
export const balanceTx = sqliteTable(
  "balance_tx",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    amount: real("amount").notNull(),
    type: text("type").notNull(),
    note: text("note"),
    refRequestId: integer("ref_request_id").references(
      () => requestLogs.id,
    ),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("balance_tx_user_id_idx").on(table.userId),
    index("balance_tx_created_at_idx").on(table.createdAt),
  ],
);

// --- 请求明细 ---
// 鉴权失败（rejected）/未路由时 user_id / key_id / provider_id 为 null；
// latency 字段仅在转发后存在。
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id),
    keyId: integer("key_id").references(() => apiKeys.id),
    providerId: integer("provider_id").references(() => providers.id),
    model: text("model"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cost: real("cost").notNull().default(0),
    latencyMs: integer("latency_ms"),
    upstreamLatencyMs: integer("upstream_latency_ms"),
    status: text("status").notNull(), // 'success' | 'error' | 'cached' | 'rejected'
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("request_logs_created_at_idx").on(table.createdAt),
    index("request_logs_user_id_idx").on(table.userId),
    index("request_logs_key_id_idx").on(table.keyId),
  ],
);

// --- 用量日聚合（Queues consumer 异步 upsert） ---
export const usageDaily = sqliteTable(
  "usage_daily",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    keyId: integer("key_id")
      .notNull()
      .references(() => apiKeys.id),
    model: text("model").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD
    requests: integer("requests").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    cost: real("cost").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.keyId, table.model, table.date],
    }),
  ],
);

// --- 模型价格表 ---
// 单价单位：USD / 每百万 tokens；seed 提供默认价格（seed.sql），admin 可覆盖。
// 分层规则（M9）：请求未缓存输入 tokens > 128,000 时输入/输出均取 long 档，否则 short 档；
// 缓存命中输入按 inputPriceCached 计（各厂商官方公布的缓存价，通常为 short 输入价的 10%~20%）。
export const models = sqliteTable(
  "models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    model: text("model").notNull().unique(),
    inputPriceShort: real("input_price_short").notNull(),
    inputPriceLong: real("input_price_long").notNull(),
    inputPriceCached: real("input_price_cached").notNull(),
    outputPriceShort: real("output_price_short").notNull(),
    outputPriceLong: real("output_price_long").notNull(),
    ...timestamps,
  },
  (table) => [index("models_model_idx").on(table.model)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type NewInviteCode = typeof inviteCodes.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Provider = typeof providers.$inferSelect;
export type NewProvider = typeof providers.$inferInsert;
export type BalanceTx = typeof balanceTx.$inferSelect;
export type NewBalanceTx = typeof balanceTx.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type UsageDaily = typeof usageDaily.$inferSelect;
export type NewUsageDaily = typeof usageDaily.$inferInsert;
export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
