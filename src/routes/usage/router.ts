// 用量报表模块路由（M5 5.3）：/api/me/usage（member 自己）、/api/admin/usage（admin 全局）。
// requireSession 已在 index.ts 对 /api/* 全局挂载；/admin 子应用内再挂 adminOnly。
// /api/me/usage/lifetime（累计消费，批次 J 2026-09-18）是独立端点，不并进 /api/me/usage 的响应。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { meUsageRoute } from "./procedures/me-usage";
import { meLifetimeCostRoute } from "./procedures/me-lifetime-cost";
import { adminUsageRoute } from "./procedures/admin-usage";

const admin = new Hono<AppEnv>();
admin.use("*", adminOnly());
adminUsageRoute(admin);

const app = new Hono<AppEnv>();
meUsageRoute(app);
meLifetimeCostRoute(app);
app.route("/admin", admin);

export default app;
