import { defineConfig } from "drizzle-kit";

// D1 迁移流程（本地 Miniflare）：
//   npm run db:generate  -> 生成 SQL 迁移到 ./drizzle（wrangler 用 migrations_dir 读取）
//   npm run db:migrate   -> wrangler d1 migrations apply --local（幂等，可重复执行）
// dbCredentials 仅用于 drizzle-kit 校验（generate 为离线操作，不需要连接）；
// 真实 D1 远程操作（push/migrate/studio）需在 M7 部署时填入 accountId/databaseId/token。
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  driver: "d1-http",
  dbCredentials: {
    accountId: "local-dev",
    databaseId: "local-dev",
    token: "local-dev",
  },
});
