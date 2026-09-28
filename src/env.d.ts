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
  // **同时是分流的"平台域"真源**：`new URL(BETTER_AUTH_URL).hostname`（见 src/lib/domains.ts，
  // 刻意不新增 PLATFORM_DOMAIN token —— 那会是第三个真源）。故生产/staging 必须把它设成管理台域。
  BETTER_AUTH_URL: string;
  // 公开 API 域名（双域名分流，09-21-dual-domain-split；[vars] 渲染烘焙）：/v1、/anthropic 只在
  // 该域服务，管理台域上的这两个前缀会被 308/301 跳到它。**未配置（或为空）= 分流整体关闭**。
  // staging 在 .dev.vars.staging 中以同名键给值。
  // ⚠ **本地 dev 不是"未配置"形态**：`.dev.vars` 同时承载生产值（spec config-inventory §1），
  //   故本地 API_DOMAIN 是真的公网域名，保护本地的是中间件的**环回例外**（isLoopbackHost，
  //   见 src/middleware/domain-split.ts 与 src/lib/domains.ts）。两者别混为一谈：删掉环回例外
  //   会让本地 /v1 被 301 到线上；断言"未配置即关闭"的用例只覆盖另一条路径（tests/domain-split.test.ts）。
  // 注意 `LEGACY_DOMAIN` **不在此声明**：它**只出现在 routes 绑定**里（模板顶层与 [env.staging]
  // **各一条**：prod = router.lmlh.net / stg = stg-router.lmlh.net，D16 后两段同形），运行时不出现
  // —— 中间件按「host 既不是 DOMAIN 也不是 API_DOMAIN ⇒ 按路径转发」处理它（这就是旧域转发的全部实现）。
  API_DOMAIN?: string;
  // GitHub OAuth App 凭据（生产：wrangler secret put）
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // GitHub OAuth 白名单邮箱，逗号分隔；为空时拒绝所有 GitHub 登录（fail-closed）
  GITHUB_ALLOWED_EMAILS: string;
  // request_logs 明细保留天数（M5 5.4；scheduled cron 清理用，缺省 30）
  REQUEST_LOG_RETENTION_DAYS?: string;
  // 延迟计费队列名（[vars] 烘焙；queue() handler 按 batch.queue 分流用；缺失时回退 usage 聚合）
  BILLING_QUEUE_NAME?: string;
  // 网关 API Key 明文前缀（缺省 "sk-"；空白视为未设置，回退默认。仅影响新生成 Key）
  API_KEY_PREFIX?: string;
  // 全局响应缓存总开关（09-03-stg-cache-investigation；[vars] 渲染烘焙）：缺省/false = 关闭，
  // 即使 key.cacheEnabled=true 也不缓存；true/1/yes/on = 开启。staging 在 .dev.vars.staging 中以同名键给值
  CACHE_ENABLED?: string;
  // modelcap 档位乘算常数（09-16 kv-ops 档位化；[vars] 渲染烘焙）：cap = BASE × MULT × 档位
  // （src/generated/modelcaps.ts 存档位）；缺省 8192 × 2 = 16384 基准。staging 在 .dev.vars.staging 中以同名键给值
  // （但 render:modelcaps 只读顶层值：档位表两环境共享，不要在此分叉）
  MODELCAP_BASE_TOKENS?: string;
  MODELCAP_MULTIPLIER?: string;
  // 注册赠金 / 邮箱验证赠金金额（USD，09-16-signup-bonus-grant；[vars] 渲染烘焙）：
  // 缺省 5（开箱即送）；显式设 0（或非法值）即不赠（fail-safe 到少发）。
  // staging 在 .dev.vars.staging 中以同名键给值（stg 需显式置 0 才不送）
  SIGNUP_BONUS_AMOUNT?: string;
  EMAIL_VERIFY_BONUS_AMOUNT?: string;
  // 邮箱验证功能总开关（09-16-signup-bonus-grant；[vars] 渲染烘焙）：缺省 false = 整个
  // emailVerification 段不配置（不发验证信、不发验证赠金）；true/1/yes/on 才开启。
  // staging 在 .dev.vars.staging 中以同名键给值
  EMAIL_VERIFICATION_ENABLED?: string;
  // 账户安全总开关（09-21-email-admin-promotion-switch；[vars] 渲染烘焙）：缺省 false =
  // 邮件注册的账户（有 accounts.providerId='credential' 行）**永远不能**提升为 admin ——
  // PATCH /api/users/:id 对该形态显式 403，管理画面的提升操作置灰；true/1/yes/on 才允许。
  // 只拦「新提升」：降级、停用、以及已是 admin 的幂等重写不受影响（不倒查存量）。
  // staging 在 .dev.vars.staging 中以同名键给值
  EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED?: string;
  // Resend 事务邮件 API key（08-27-email-notification；**真实 secret**：本地 .dev.vars，
  // 生产/staging 各自 `wrangler secret put RESEND_API_KEY`）。空/缺失 = **通道未配置**：
  // 不发信、不抛错，只记 email_not_configured（fail-safe，见 src/lib/email.ts）。
  // 可选（`?`）：该键不经 render 烘焙，未被 secret put 的环境里 binding 真的缺席 ——
  // 类型如实反映，且必须与 tests/test-env.d.ts 的声明一致（否则 Cloudflare.Env 不能传给 Env）
  RESEND_API_KEY?: string;
  // 事务邮件收件人白名单（同上；[vars] 渲染烘焙）：逗号分隔、大小写不敏感；**空 = 全放行**（prod 语义）。
  // staging 必须在 .dev.vars.staging 中设同名键，防测试环境向真实用户发信
  EMAIL_ALLOWED_RECIPIENTS?: string;
  // 测试用户批量初始化（dev-only，JSON 数组字符串）：设置后启用 POST /api/seed/users。
  // **纯功能开关，不是安全边界**（09-22-seed-users-dev-only）：注册校验中"放行种子邮箱、
  // 绕过邀请码"的豁免已删除，本变量的唯一读者是 dev-only 路由自身（它自铸一次性邀请码，
  // 种子用户走与真实用户相同的校验 + 消费链路）。生产禁止设置。格式见 src/lib/seed-users.ts
  SEED_USERS?: string;
  // 认证面限流绑定（09-28-auth-rate-limit-fix / security-audit F1；wrangler.toml `[[ratelimits]]`）。
  // 两个绑定的**档位（limit/period）只在配置里** —— workerd 的 `RateLimitOptions` 只有 `key` 字段，
  // 代码侧无法逐调用覆写，故策略不同的类别必须各占一个绑定（namespace_id 即计数命名空间）。
  // ⚠ **声明为可选（`?`）是如实的**：中间件有一条 fail-open 分支专门处理 binding 缺席
  //   （`[[ratelimits]]` 是 wrangler 的 notInheritable key —— `[env.*]` 段漏写不报错，
  //   只是让该环境静默不限流，见 design §2.2）。声明为必填会把这条真实运行时形态挡在类型之外。
  // 与 tests/test-env.d.ts 的 Cloudflare.Env 声明必须一致（那是 cloudflare:test 侧的平行声明）。
  AUTH_CREDENTIAL_LIMIT?: RateLimit;
  AUTH_EMAIL_LIMIT?: RateLimit;
}
