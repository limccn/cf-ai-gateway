// Vitest + Miniflare 测试配置（M4 4.x 单测环境）。
// - cloudflareTest 插件在 vitest v4 下注册 Workers pool（@cloudflare/vitest-pool-workers 0.22+）。
// - wrangler.toml 提供 D1/KV 绑定与 main 入口；TEST_MIGRATIONS 由 Node 侧读取 drizzle/*.sql，
//   测试运行时用 applyD1Migrations 建表（miniflare 测试 D1 不会自动应用迁移）。
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  fileURLToPath(new URL("./drizzle", import.meta.url)),
);

export default defineConfig({
  test: {
    // miniflare 内不可达上游约 2s 才报错（Network connection lost），多次请求的用例需更宽超时
    testTimeout: 30_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // .dev.vars 之外的测试固定值（src/env.d.ts 声明的字符串环境变量）
          GATEWAY_SECRET_KEY: "test-gateway-secret-key-0123456789abcdef",
          BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
          BETTER_AUTH_URL: "http://localhost:5173",
          // 双域名分流（09-21-dual-domain-split）：pin **空 = 未配置 ⇒ 分流整体关闭**，既有用例
          // 的行为与今日完全一致（AND 与 prod 缺省形态同源）。domain-split.test.ts 用 helpers 的
          // withSwitch 逐用例翻成真实域名 —— 故这里必须 pin 一个值（未 pin 的键不保证可写）。
          API_DOMAIN: "",
          GITHUB_CLIENT_ID: "test-github-client-id",
          GITHUB_CLIENT_SECRET: "test-github-client-secret",
          GITHUB_ALLOWED_EMAILS: "",
          // 全局缓存总开关（09-03-stg-cache-investigation）：测试固定开启（cache.test.ts 依赖缓存生效）
          CACHE_ENABLED: "true",
          // modelcap 档位乘算常数：测试固定缺省基准（8192 × 2 → 档位 1 = 16384）
          MODELCAP_BASE_TOKENS: "8192",
          MODELCAP_MULTIPLIER: "2",
          // 赠金（09-16-signup-bonus-grant）：金额固定缺省 5（金额分支矩阵在 bonus.unit.test.ts
          // 与「直接调用 grantSignupBonus（传入自定义 env）」里覆盖 —— miniflare bindings
          // 在测试进程内固定，无法逐用例改）。邮箱验证显式开启：否则 emailVerification 段
          // 整段不配置，verify-email 链路（AC5/AC6）不可测。
          SIGNUP_BONUS_AMOUNT: "5",
          EMAIL_VERIFY_BONUS_AMOUNT: "5",
          EMAIL_VERIFICATION_ENABLED: "true",
          // 账户安全总开关（09-21-email-admin-promotion-switch）：显式 pin 成**部署缺省**（关闭）。
          // 被拦分支（403 门控）的路由测试就跑在这一态。bindings 在 miniflare 进程内不可逐用例翻转，
          // 开启态由 tests/helpers.ts 的 withSwitch 在运行时改写 —— 步骤 3 实测**生效**（同一 isolate
          // 内对主 worker 可见，与 countKvOps 改写 env.CACHE_KV 同一机制）。
          EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED: "false",
          // 事务邮件通道（08-27-email-notification）：**空 key = 通道未配置**（src/lib/email.ts 短路，
          // 只记 email_not_configured）。EMAIL_VERIFICATION_ENABLED 在这里是 "true"，注册/验证用例
          // 会走真发送路径 —— 空 key 让它们零网络、行为不变；要验发送的用例自己 stub fetch 并用
          // tests/helpers.ts 的 withSwitch 注入 key。白名单 pin ""（= 全放行，与 prod 缺省同形态）。
          RESEND_API_KEY: "",
          EMAIL_ALLOWED_RECIPIENTS: "",
          // seed 路由测试固定种子（dev-only）：安全密码仅存在于测试绑定，不落盘
          SEED_USERS: JSON.stringify([
            {
              email: "seed-admin@test.dev",
              password: "test-seed-pass-123",
              name: "Seed Admin",
              role: "admin",
            },
            {
              email: "seed-member@test.dev",
              password: "test-seed-pass-123",
              name: "Seed Member",
              role: "member",
            },
          ]),
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
});
