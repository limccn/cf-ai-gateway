// 计费流水模块路由（M8）：/api/me/transactions（member 自己）、/api/admin/transactions（admin）。
// requireSession 已在 index.ts 对 /api/* 全局挂载；/admin 子应用内再挂 adminOnly。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { meTransactionsRoute } from "./procedures/me-transactions";
import { adminTransactionsRoute } from "./procedures/admin-transactions";

const admin = new Hono<AppEnv>();
admin.use("*", adminOnly());
adminTransactionsRoute(admin);

const app = new Hono<AppEnv>();
meTransactionsRoute(app);
app.route("/admin", admin);

export default app;
