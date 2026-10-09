// P2 入站协议错误适配中间件单测：createErrorAdaptMiddleware({format:"anthropic"})。
// 用临时 Hono app 直接挂载中间件 + 各错误形态路由验证后置重写：
// 状态码映射（400/401/402/403/404/429/500/502/504）、message 原文保留、
// zod-validator 400 形态归一、豁免（2xx、SSE 非 JSON、已带 type:"error"、非 OpenAI 形态 body）。
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createErrorAdaptMiddleware } from "../src/lib/error-adapt";
import type { AppEnv } from "../src/types";

/** 临时 app：先挂错误适配中间件，再注册返回各种错误形态的路由（真实挂载顺序：auth → 适配 → handler）。 */
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", createErrorAdaptMiddleware({ format: "anthropic" }));

  app.get("/openai-400", (c) => c.json({ error: { message: "bad request" } }, 400));
  app.get("/openai-401", (c) => c.json({ error: { message: "Invalid API key" } }, 401));
  app.get("/openai-402", (c) => c.json({ error: { message: "Insufficient balance" } }, 402));
  app.get("/openai-403", (c) => c.json({ error: { message: "Account disabled" } }, 403));
  app.get("/openai-404", (c) => c.json({ error: { message: "model not found" } }, 404));
  app.get("/openai-429", (c) => c.json({ error: { message: "rate limited" } }, 429));
  app.get("/openai-500", (c) => c.json({ error: { message: "boom" } }, 500));
  app.get("/openai-502", (c) => c.json({ error: { message: "upstream down" } }, 502));
  app.get("/openai-504", (c) => c.json({ error: { message: "upstream timeout" } }, 504));
  // 529 不在 Hono ContentfulStatusCode 注册表（非标准码，Cloudflare/Anthropic 语义），用 Response 构造
  app.get(
    "/openai-529",
    () =>
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 529,
        headers: { "Content-Type": "application/json" },
      }),
  );
  app.get("/openai-418", (c) => c.json({ error: { message: "teapot" } }, 418));
  // zod-validator 400 形态（@hono/zod-validator 校验失败体，M8）
  app.get(
    "/zod-400",
    (c) =>
      c.json(
        { success: false, error: { issues: [{ path: ["model"], message: "Required" }] } },
        400,
      ),
  );
  // 豁免：2xx 的 OpenAI 形态 body 不重写
  app.get("/ok", (c) => c.json({ error: { message: "not an error" } }));
  // 豁免：SSE 错误响应（text/event-stream，非 JSON）
  app.get(
    "/sse-502",
    () =>
      new Response('data: {"error":{"message":"x"}}', {
        status: 502,
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  // 豁免：已带协议错误标记（顶层 type:"error"）→ 透传
  app.get(
    "/already-anthropic",
    (c) =>
      c.json({ type: "error", error: { type: "api_error", message: "keep me" } }, 500),
  );
  // 豁免：非 OpenAI 形态 JSON 错误体
  app.get("/other-shape", (c) => c.json({ detail: "not an openai error" }, 500));
  return app;
}

interface AnthropicErrorBody {
  type?: string;
  error?: { type?: string; message?: string };
}

describe("createErrorAdaptMiddleware（anthropic）", () => {
  it("状态码 → error.type 映射（400/401/402/403/404/429/500/502/504）", async () => {
    const app = buildApp();
    const cases: Array<[string, number, string]> = [
      ["/openai-400", 400, "invalid_request_error"],
      ["/openai-401", 401, "authentication_error"],
      ["/openai-402", 402, "permission_error"],
      ["/openai-403", 403, "permission_error"],
      ["/openai-404", 404, "not_found_error"],
      ["/openai-429", 429, "rate_limit_error"],
      ["/openai-500", 500, "api_error"],
      ["/openai-502", 502, "api_error"],
      ["/openai-504", 504, "overloaded_error"],
      ["/openai-529", 529, "overloaded_error"],
    ];
    for (const [path, status, type] of cases) {
      const res = await app.request(path);
      expect(res.status).toBe(status);
      const body = (await res.json()) as AnthropicErrorBody;
      expect(body["type"]).toBe("error");
      expect(body["error"]?.["type"]).toBe(type);
      expect(body["error"]?.["message"]).toBeTruthy();
    }
  });

  it("message 原文保留", async () => {
    const app = buildApp();
    const res = await app.request("/openai-429");
    const body = (await res.json()) as AnthropicErrorBody;
    expect(body["error"]?.["message"]).toBe("rate limited");
  });

  it("未列入映射的状态码：4xx → invalid_request_error，5xx → api_error", async () => {
    const app = buildApp();
    const res = await app.request("/openai-418");
    const body = (await res.json()) as AnthropicErrorBody;
    expect(res.status).toBe(418);
    expect(body["error"]?.["type"]).toBe("invalid_request_error");
  });

  it("zod-validator 400 形态 → 归一为 Anthropic invalid_request_error", async () => {
    const app = buildApp();
    const res = await app.request("/zod-400");
    expect(res.status).toBe(400);
    const body = (await res.json()) as AnthropicErrorBody;
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("invalid_request_error");
    expect(body["error"]?.["message"]).toBe("Validation failed: model: Required");
  });

  it("豁免：2xx OpenAI 形态 body 原样返回", async () => {
    const app = buildApp();
    const res = await app.request("/ok");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body["error"]?.["message"]).toBe("not an error");
    expect(JSON.stringify(body)).not.toContain('"type":"error"');
  });

  it("豁免：SSE 错误响应（text/event-stream）原样返回", async () => {
    const app = buildApp();
    const res = await app.request("/sse-502");
    expect(res.status).toBe(502);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await res.text()).toBe('data: {"error":{"message":"x"}}');
  });

  it("豁免：已带协议错误标记（顶层 type:'error'）透传", async () => {
    const app = buildApp();
    const res = await app.request("/already-anthropic");
    expect(res.status).toBe(500);
    const body = (await res.json()) as AnthropicErrorBody;
    expect(body).toEqual({ type: "error", error: { type: "api_error", message: "keep me" } });
  });

  it("豁免：非 OpenAI 形态 JSON 错误体原样返回", async () => {
    const app = buildApp();
    const res = await app.request("/other-shape");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail?: string };
    expect(body["detail"]).toBe("not an openai error");
    expect(JSON.stringify(body)).not.toContain('"type":"error"');
  });
});
