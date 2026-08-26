// 系统设置模块路由（M8）：GET /api/admin/settings（admin 只读）。
// requireSession 已在 index.ts 对 /api/* 全局挂载；本模块再挂 adminOnly。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { adminSettingsRoute } from "./procedures/admin-settings";

const admin = new Hono<AppEnv>();
admin.use("*", adminOnly());
adminSettingsRoute(admin); // GET /settings

const app = new Hono<AppEnv>();
app.route("/admin", admin);

export default app;
