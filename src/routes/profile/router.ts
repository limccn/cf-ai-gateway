// 账户 Profile 模块路由（09-16-account-menu）：GET /api/me/profile（member 自己，只读）。
//
// 挂载位置：src/index.ts 的 `app.route("/api", profileRouter)`，**必须在
// `app.use("/api/*", requireSession())` 之后**注册，否则未登录访问不会返回 401。
//
// 路由归属：沿用「member 端点由所属**域模块**承载」的既有惯例（/api/me/usage 在 usage/、
// /api/me/transactions 在 billing/、/api/me/onboarding 在 onboarding/ 下），而非建集中式
// me 模块 —— 各任务独占目录，并行开发互不踩文件。本模块只承载 profile 端点，不搬迁既有路由。
//
// 为什么没有写端点：改 name 复用 Better Auth 内置 POST /api/auth/update-user（design §2.2）。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getProfileRoute } from "./procedures/get-profile";

const app = new Hono<AppEnv>();
getProfileRoute(app);

export default app;
