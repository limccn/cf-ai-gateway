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
          GITHUB_CLIENT_ID: "test-github-client-id",
          GITHUB_CLIENT_SECRET: "test-github-client-secret",
          GITHUB_ALLOWED_EMAILS: "",
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
