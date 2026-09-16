// 引导模块路由（09-16-first-login-welcome）：
//   GET  /api/me/onboarding                 —— 首登欢迎状态（是否弹窗 + 展示金额）
//   POST /api/me/onboarding/welcome-seen    —— 标记欢迎弹窗已读（幂等）
//
// 挂载位置：src/index.ts 的 `app.route("/api", onboardingRouter)`，**必须在
// `app.use("/api/*", requireSession())` 之后**注册，否则未登录访问不会返回 401。
//
// 路由归属：沿用「member 端点由所属**域模块**承载」的既有惯例（/api/me/usage 在 usage/、
// /api/me/transactions 在 billing/ 下），而非建集中式 me 模块 —— 该惯例让各子任务独占目录，
// 并行开发互不踩文件。本模块只承载 onboarding 端点，不搬迁既有路由。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getOnboardingRoute } from "./procedures/get-onboarding";
import { markWelcomeSeenRoute } from "./procedures/mark-welcome-seen";

const app = new Hono<AppEnv>();
getOnboardingRoute(app);
markWelcomeSeenRoute(app);

export default app;
