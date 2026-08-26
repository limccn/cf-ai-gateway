// Better Auth 挂载（M2 2.1）：/api/auth/* 全部委托给 auth.handler。
// 注册顺序（index.ts）：requestContext → 本路由（public）→ requireSession(/api/*)，
// 因此 /api/auth/* 请求不会经过 requireSession。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { createAuth } from "../../lib/auth";
import { createDb } from "../../db";

const app = new Hono<AppEnv>();

// Better Auth 处理全部方法（含 OPTIONS 预检与 404）
app.on(["POST", "GET", "OPTIONS"], "*", async (c) => {
  const auth = createAuth(c.env, createDb(c.env));
  return auth.handler(c.req.raw);
});

export default app;
