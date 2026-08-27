// Anthropic 入站路由（R1/D1）：POST /v1/messages（主）+ POST /messages（别名）。
// 中间件顺序（D3/D4）：错误重写必须最外层 —— gatewayAuth 失败（401/403）、
// proxyRoute 管道内错误（400/404/429/402/502/504）都需改写为 Anthropic 错误形态；
// 若 error-adapt 注册在 gatewayAuth 之后，鉴权失败会短路跳过改写。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { gatewayAuth } from "../../middleware/gateway-auth";
import { createErrorAdaptMiddleware } from "../../lib/error-adapt";
import { proxyRouteWithOptions } from "../v1/proxy";
import { anthropicProxyOptions } from "./options";

const app = new Hono<AppEnv>();

app.use("*", createErrorAdaptMiddleware({ format: "anthropic" }));
app.use("*", gatewayAuth());

proxyRouteWithOptions(app, "/v1/messages", anthropicProxyOptions);
proxyRouteWithOptions(app, "/messages", anthropicProxyOptions);

export default app;
