// 代理面路由（M3 3.3）：/v1/*。
// 中间件链（design §3 请求生命周期 1-6）：
//   1. gatewayAuth（Bearer 网关 Key）→ 失败 401
//   2. gatewayRateLimit（KV 固定窗口）→ 超限 429（proxyRoute 内挂载）
//   3. gatewayBalanceCheck（余额 > 0 占位）→ 不足 402（proxyRoute 内挂载）
//   4. 路由 + 适配器转发（proxyRoute）
// GET /v1/models 仅鉴权（OpenAI 惯例：模型列表不消耗配额）。
// POST /messages（统一入口，08-31-protocol-auto-detect）：Anthropic Messages / OpenAI Chat
//   双协议自动感知（protocolDetectMiddleware 先行注入 detectedProtocol；error-adapt 按检测结果
//   动态决定错误形态；proxy 按检测结果切换协议变体）。anthropic 语义请求（SDK 头/硬信号/
//   claude-* 模型名）行为与现状一致（含缓存前缀、错误形态、入站面偏好 inboundFace）；openai 语义请求
//   按 OpenAI Chat 形态处理。检测中间件与错误重写中间件必须注册在全局 gatewayAuth 之前
//   （仅匹配 /messages 路径，对 /chat/completions 等现有端点零影响），否则鉴权 401 会短路跳过改写。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { gatewayAuth } from "../../middleware/gateway-auth";
import { protocolDetectMiddleware } from "../../middleware/protocol-detect";
import { createErrorAdaptMiddleware } from "../../lib/error-adapt";
import { proxyRoute, proxyRouteWithOptions } from "./proxy";
import { unifiedMessagesProxyOptions } from "./unified-messages";
import { responsesProxyOptions } from "./responses";
import { modelsRoute } from "./models";

const app = new Hono<AppEnv>();

app.use("/messages", protocolDetectMiddleware());
// 动态格式：检测为 openai → 不改写（OpenAI 统一错误形态）；anthropic / 未检测（非 JSON、401 空请求）→ 现状 Anthropic 形态
app.use(
  "/messages",
  createErrorAdaptMiddleware({
    format: "anthropic",
    resolveFormat: (c) => (c.get("detectedProtocol") === "openai" ? null : "anthropic"),
  }),
);
app.use("*", gatewayAuth());

modelsRoute(app); // GET /models（仅鉴权）

proxyRoute(app, "chat"); // POST /chat/completions
proxyRoute(app, "completions"); // POST /completions
proxyRoute(app, "embeddings"); // POST /embeddings
proxyRouteWithOptions(app, "/messages", unifiedMessagesProxyOptions); // POST /messages（双协议自动感知）
proxyRouteWithOptions(app, "/responses", responsesProxyOptions); // POST /responses（OpenAI Responses API）

export default app;
