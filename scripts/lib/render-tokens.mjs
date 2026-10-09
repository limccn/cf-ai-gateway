// 渲染白名单 TOKENS + SEED_USERS 结构闸门（AC7，10-08-open-source-release-prep）。
//
// TOKENS 从 scripts/render-wrangler-config.mjs 移至此**纯模块**（零依赖、不 import node:fs）：
// vitest 跑在 Workers pool（workerd）没有 node:fs，只有这种形态的模块能被单测直接 import
// （与 toml-sections.mjs 同一先例）。渲染脚本与单测**共用同一份真源**，白名单不再有两处拷贝。
//
// TOKENS 原注释（与 .trellis/spec/governance/config-inventory.md「RENDER-ENV 移管清单」一一对应，22 键）：
// 计数口径 = 本集合元素个数（非模板 {TOKEN} 出现次数：同名 token 在顶层段与环境段各出现一次）。
// 顶层 [vars] 运行时配置（BETTER_AUTH_URL 等）与 infra 键同策略烘焙——wrangler 4.x 不解析
// {KEY}，值必须在构建期就位。本地默认值（localhost / 占位）来自 .dev.vars，仅用于本地 dev
// （wrangler dev 时 .dev.vars 优先于 [vars]，不受影响）；部署真实值走 shell export 覆盖。
export const TOKENS = new Set([
  // --- infra 结构键（基段与管理段同名共用；值文件各给一份） ---
  "WORKER_NAME",
  "DOMAIN",
  // 双域名分流（09-21-dual-domain-split）：API_DOMAIN = 公开 API 域（基段与 stg 段各一份值）。
  "API_DOMAIN",
  // 旧域转发源（prod = router.lmlh.net / stg = stg-router.lmlh.net）：**两段各一条 routes**，
  // 故两个值文件都必须有该键（缺基段那份 ⇒ 基段第三条 route 无值可烘，fail-fast）。仅用于绑定：
  // 中间件不读它（「host 不属于两类新域 ⇒ 按路径转发」已涵盖）。校验按「模板中实际出现的
  // (token, 段)」逐条判定，**不比对两个值文件的键集合**。
  "LEGACY_DOMAIN",
  "D1_DB_NAME",
  "D1_DB_ID",
  "KV_ID",
  "QUEUE_NAME",
  "BILLING_QUEUE_NAME",
  // --- [vars] 运行时配置（基段 = .dev.vars / 环境段 = .dev.vars.staging） ---
  "API_KEY_PREFIX",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_ALLOWED_EMAILS",
  "REQUEST_LOG_RETENTION_DAYS",
  "CACHE_ENABLED",
  "MODELCAP_BASE_TOKENS",
  "MODELCAP_MULTIPLIER",
  "SIGNUP_BONUS_AMOUNT",
  "EMAIL_VERIFY_BONUS_AMOUNT",
  "EMAIL_VERIFICATION_ENABLED",
  "EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED",
  // 事务邮件收件人白名单（08-27-email-notification）：**空是合法配置**（= 全放行），见 EMPTY_ALLOWED。
  "EMAIL_ALLOWED_RECIPIENTS",
]);

// --- SEED_USERS 结构闸门（AC7；security-audit H3-H1 双保险的渲染侧） ---
//
// SEED_USERS 是本地 dev 造测试用户的环境变量，唯一读者是 dev-only 路由
// （src/routes/seed/router.ts：未设置即路由不注册 → 404 fail-closed）。它**绝不能**进入渲染管道：
// 一旦烘进生产 [vars]，匿名者 POST /api/seed/users 即取得可用 admin 会话（H3-H1 爆炸半径实测）。
//
// 三层判据，任一层命中即 throw —— 渲染脚本在写出前调用，命中即 fail-fast ⇒
// pretest / dev / deploy / check 全被拦（结构性阻断，不依赖有人记得跑测试）：
//   1. 白名单 TOKENS 含 SEED_USERS（防未来误加渲染键）
//   2. wrangler.toml.template 含字面 SEED_USERS（防模板直写）
//   3. 渲染产物含字面 SEED_USERS（终态兜底——即使值从任何旁路透传）
//
// 阳性控制：tests/render-config.unit.test.ts 把 SEED_USERS 塞进任一输入 ⇒ 本函数必须 throw。
export const SEED_USERS_KEY = "SEED_USERS";

export function assertSeedUsersNeverConfigured({ tokens, templateText, renderedText } = {}) {
  const hits = [];
  if (tokens && [...tokens].includes(SEED_USERS_KEY)) hits.push("白名单 TOKENS");
  if (templateText != null && templateText.includes(SEED_USERS_KEY)) hits.push("wrangler.toml.template");
  if (renderedText != null && renderedText.includes(SEED_USERS_KEY)) hits.push("渲染产物");
  if (hits.length > 0) {
    throw new Error(
      `SEED_USERS 泄入渲染管道（${hits.join("、")}）—— 它是 dev-only 变量，绝不允许进入 wrangler 配置（AC7 闸门）`,
    );
  }
}
