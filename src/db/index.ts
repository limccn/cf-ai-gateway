// D1 数据库访问入口。
// Cloudflare Workers 环境：每个请求创建实例（env 通过 c.env 传入，禁止模块级缓存）。
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

export function createDb(env: { DB: D1Database }): Db {
  return drizzle(env.DB, { schema });
}
