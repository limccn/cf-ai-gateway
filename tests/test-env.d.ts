// 测试环境类型补充（M4）：cloudflare:test 的 `env` 类型为 `Cloudflare.Env`
// （worker-configuration.d.ts 生成，仅含 D1/KV/Queues 绑定）；字符串环境变量与
// TEST_MIGRATIONS 由 vitest.config.ts 以 miniflare bindings 注入，此处合并声明。
declare namespace Cloudflare {
  interface Env {
    GATEWAY_SECRET_KEY: string;
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GITHUB_ALLOWED_EMAILS: string;
    /** request_logs 保留天数（M5 5.4；缺省 30，未注入时按默认处理）。 */
    REQUEST_LOG_RETENTION_DAYS?: string;
    /** 网关 API Key 明文前缀（缺省 "sk-"；空白视为未设置，回退默认）。 */
    API_KEY_PREFIX?: string;
    /** vitest.config.ts 注入的 drizzle 迁移 SQL（applyD1Migrations 用）。 */
    TEST_MIGRATIONS: D1Migration[];
  }
}
