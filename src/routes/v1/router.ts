// 代理面路由（M3 3.3）：/v1/*。
// 中间件链（design §3 请求生命周期 1-6）：
//   1. gatewayAuth（Bearer 网关 Key）→ 失败 401
//   2. gatewayRateLimit（KV 固定窗口）→ 超限 429（proxyRoute 内挂载）
//   3. gatewayBalanceCheck（余额 > 0 占位）→ 不足 402（proxyRoute 内挂载）
//   4. 路由 + 适配器转发（proxyRoute）
// GET /v1/models 仅鉴权（OpenAI 惯例：模型列表不消耗配额）。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { gatewayAuth } from "../../middleware/gateway-auth";
import { proxyRoute } from "./proxy";
import { modelsRoute } from "./models";

const app = new Hono<AppEnv>();

app.use("*", gatewayAuth());

modelsRoute(app); // GET /models（仅鉴权）

proxyRoute(app, "chat"); // POST /chat/completions
proxyRoute(app, "completions"); // POST /completions
proxyRoute(app, "embeddings"); // POST /embeddings

export default app;
