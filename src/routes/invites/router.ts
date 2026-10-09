// 邀请码模块路由（批次 U）：/api/invites/*。
//
// 挂载位置（src/index.ts）：**必须**在 `app.use("/api/*", requireSession())` 之前注册，
// 并先挂 `app.use("/api/invites/validate", authRateLimit())` —— 预校验是注册页的公开端点
// （未登录 200，AC51），限流白名单见 src/middleware/auth-rate-limit.ts（D30）。
//
// 与 users 模块的 `/api/users/invites`（admin 管理面：发码 / 列码）互不冲突：
// 那是 /api/users 前缀下的子路径，这里是独立的 /api/invites 前缀。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { validateInviteRoute } from "./procedures/validate";

const app = new Hono<AppEnv>();

validateInviteRoute(app); // GET /validate

export default app;
