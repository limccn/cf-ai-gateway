// 用量报表模块路由（M5 5.3）：/api/me/usage（member 自己）、/api/admin/usage（admin 全局）。
// requireSession 已在 index.ts 对 /api/* 全局挂载；/admin 子应用内再挂 adminOnly。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { meUsageRoute } from "./procedures/me-usage";
import { adminUsageRoute } from "./procedures/admin-usage";

const admin = new Hono<AppEnv>();
admin.use("*", adminOnly());
adminUsageRoute(admin);

const app = new Hono<AppEnv>();
meUsageRoute(app);
app.route("/admin", admin);

export default app;
