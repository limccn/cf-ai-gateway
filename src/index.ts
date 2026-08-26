// AI API Gateway - Worker 入口。
// 中间件/路由注册顺序（Hono 按注册顺序匹配）：
//   1. requestContext（MUST 最先挂载，注入 requestId + logger）
//   2. zod 校验错误统一中间件（M8：@hono/zod-validator 400 响应统一为 {error:{message}}）
//   3. GET /api/health（public）
//   4. /api/auth/*（Better Auth，public）—— 必须先于 requireSession 注册
//   5. requireSession 挂载 /api/*（未登录 401）
//   6. 管理面模块路由（/api/users、/api/keys、/api/providers 等）
//   7. notFound 兜底：/api/* 与 /v1/* 返回 JSON 404；其余路径交给 env.ASSETS 托管
//      （M6 前端：SPA index.html + 构建产物；wrangler.toml assets run_worker_first=true）
// 代理面 /v1/*（M3）：网关 Key 鉴权，独立于会话鉴权，在 requireSession 之前注册（互不冲突）。
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { requestContext } from "./middleware/request-context";
import { requireSession } from "./middleware/auth";
import authRouter from "./routes/auth/router";
import seedRouter from "./routes/seed/router";
import usersRouter from "./routes/users/router";
import keysRouter from "./routes/keys/router";
import providersRouter from "./routes/providers/router";
import modelsRouter from "./routes/models/router";
import v1Router from "./routes/v1/router";
import usageRouter from "./routes/usage/router";
import settingsRouter from "./routes/settings/router";
import billingRouter from "./routes/billing/router";
import { toUnifiedErrorBody } from "./lib/error-format";
import { logger } from "./lib/logger";
import { consumeUsageBatch } from "./lib/usage-aggregation";
import { parseRetentionDays, runRequestLogCleanup } from "./lib/cleanup";
import { createDb } from "./db";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

// MUST be first — 提供 requestId + 结构化 logger
app.use("*", requestContext());

// M8 全局 zod 校验错误统一（journal 延期项 1）：
// @hono/zod-validator 校验失败返回 `{success:false, error: <ZodError 序列化>}`（400，直接返回、
// 不抛错，onError 收不到），与项目统一格式 `{error:{message}}` 不一致。
// 此处对所有 400 JSON 响应做一次检测并重写为统一格式，覆盖 /api/* 与 /v1/*，
// 不逐调用点修改。消息格式与下方 onError 的 ZodError 分支保持一致；
// ZodError 序列化形态见 src/lib/error-format.ts（zod v3 `{issues:[...]}` / zod v4 `{name,message}`）。
app.use("*", async (c, next) => {
  await next();
  const res = c.res;
  if (res.status !== 400) {
    return;
  }
  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return;
  }
  const cloned = res.clone();
  const body: unknown = await cloned.json().catch(() => null);
  const unified = toUnifiedErrorBody(body);
  if (unified !== null) {
    c.get("logger").warn("validation_error", { path: c.req.path });
    c.res = c.json(unified, 400);
  }
});

// GET /api/health —— 存活探针；不触达 DB（database.md Pitfall 4：避免冷启动叠加）
app.get("/api/health", (c) =>
  c.json({ ok: true, service: "cf-ai-gateway", ts: new Date().toISOString() }),
);

// Better Auth（public）：必须先于 requireSession 注册
app.route("/api/auth", authRouter);

// 测试用户初始化（dev-only）：POST /api/seed/users —— 必须先于 requireSession 注册；
// 路由内部按 env.SEED_USERS 存在与否 gating（未配置 → 404，生产零暴露）
app.route("/api/seed", seedRouter);

// 代理面（M3）：/v1/* —— 网关 Key 鉴权（与 /api/* 会话鉴权并存），独立挂载
app.route("/v1", v1Router);

// 管理面 API：全部要求会话
app.use("/api/*", requireSession());

// 管理面模块路由
app.route("/api/users", usersRouter);
app.route("/api/keys", keysRouter);
app.route("/api/providers", providersRouter);
app.route("/api/models", modelsRouter);
app.route("/api", usageRouter); // /api/me/usage（member）、/api/admin/usage（admin）
app.route("/api", settingsRouter); // /api/admin/settings（admin 只读）
app.route("/api", billingRouter); // /api/me/transactions（member）、/api/admin/transactions（admin）

// notFound 兜底（M6）：API 路径保持 JSON 404；其余路径（SPA 深链/静态资源）交给 Workers Assets。
// run_worker_first=true 下 Worker 先收到全部请求，这里对非 API 路径回落到 env.ASSETS.fetch，
// html_handling=spa 会将无扩展名路径回退到 index.html（React Router 客户端路由）。
app.notFound((c) => {
  const path = c.req.path;
  if (path.startsWith("/api/") || path.startsWith("/v1/")) {
    return c.json({ error: { message: "Not Found" } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  // requestContext 已挂载时使用请求级 logger；否则退回模块级 logger
  const requestLogger = c.get("logger") ?? logger;
  if (err instanceof HTTPException) {
    // 业务/鉴权错误：透传状态码与消息（401/403/404/400 等）
    requestLogger.warn("request_error", {
      status: err.status,
      message: err.message,
      path: c.req.path,
    });
    return c.json({ error: { message: err.message } }, err.status);
  }

  if (err instanceof ZodError) {
    // 输入校验失败：统一 400（error-logging spec：validation_error）
    const firstIssue = err.issues[0];
    const detail =
      firstIssue !== undefined
        ? `${firstIssue.path.join(".") || "body"}: ${firstIssue.message}`
        : err.message;
    requestLogger.warn("validation_error", {
      path: c.req.path,
      issues: err.issues,
    });
    return c.json({ error: { message: `Validation failed: ${detail}` } }, 400);
  }
  requestLogger.error("unhandled_error", {
    message: err.message,
    path: c.req.path,
  });
  return c.json({ error: { message: "Internal Server Error" } }, 500);
});

// 默认导出为模块 Worker 风格对象（M5 起）：fetch + queue + scheduled 统一挂在 default 上。
// 注意：Hono 实例的 fetch 是原型方法，展开运算符不会拷贝，需显式 bind；否则 wrangler/vitest-pool
// 按 `default.fetch` 派发时会拿到 undefined（M5 验证时曾出现 "Expected default export ... fetch" 错误）。
// 同时保留同名具名导出（测试直接 import 调用；vitest-pool 对 queue/scheduled 事件按 default 派发）。
export async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  await consumeUsageBatch(batch, env);
}

// Scheduled cron（M5 5.4）：按保留期清理过期 request_logs（默认 30 天，env REQUEST_LOG_RETENTION_DAYS 可配置）。
// wrangler.toml [triggers] crons 声明；本地 wrangler dev 不自动触发（用 --test-scheduled 或直接调用本函数验证）。
export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const retentionDays = parseRetentionDays(env.REQUEST_LOG_RETENTION_DAYS);
  await runRequestLogCleanup(createDb(env), retentionDays, logger);
}

export default {
  fetch: app.fetch.bind(app),
  queue,
  scheduled,
};
