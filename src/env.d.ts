// 字符串环境变量类型补充（与 worker-configuration.d.ts 生成的 Env 接口合并）。
// 这些变量通过 .dev.vars（本地）或 wrangler secret（生产）注入，wrangler types 不会为它们生成类型。
// 静态资源绑定（M6）：wrangler.toml `assets = { binding = "ASSETS" }`。
// `wrangler types` 不会为 assets binding 生成类型（虚拟绑定），这里合并进 __BaseEnv_Env，
// 使全局 Env（worker 代码）与 Cloudflare.Env（cloudflare:test 测试环境）都包含 ASSETS。
interface __BaseEnv_Env {
  ASSETS: Fetcher;
}

interface Env {
  // 上游 Provider 密钥的 AES-GCM 加密密钥（生产：wrangler secret put GATEWAY_SECRET_KEY，
  // 任意长度字符串，建议 >=32 字符随机值；本地由 .dev.vars 提供）
  GATEWAY_SECRET_KEY: string;
  // Better Auth 会话签名密钥（生产：wrangler secret put BETTER_AUTH_SECRET）
  BETTER_AUTH_SECRET: string;
  // 前端 origin（本地 http://localhost:5173；生产为部署域名），用于 baseURL/cookie/回调地址
  BETTER_AUTH_URL: string;
  // GitHub OAuth App 凭据（生产：wrangler secret put）
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // GitHub OAuth 白名单邮箱，逗号分隔；为空时拒绝所有 GitHub 登录（fail-closed）
  GITHUB_ALLOWED_EMAILS: string;
  // request_logs 明细保留天数（M5 5.4；scheduled cron 清理用，缺省 30）
  REQUEST_LOG_RETENTION_DAYS?: string;
  // 测试用户批量初始化（dev-only，JSON 数组字符串）：设置后启用 POST /api/seed/users
  // 并在注册校验中放行种子邮箱（绕过邀请码）。生产禁止设置。格式见 src/lib/seed-users.ts
  SEED_USERS?: string;
}
