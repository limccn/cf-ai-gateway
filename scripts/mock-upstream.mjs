// 本地 mock 上游（M3 验证用，无第三方依赖）：OpenAI 兼容 + Anthropic Messages API 双端点。
// 用法：node scripts/mock-upstream.mjs  （默认端口 8788，可用 MOCK_PORT 覆盖）
// 用途：
//   - OpenAI 兼容面：/openai/v1/{chat/completions,completions,embeddings,models}
//   - Anthropic 面：/anthropic/v1/messages（非流式 + 流式 SSE，含 text 与 tool_use 两种样例）
// 鉴权校验（验证网关正确解密并注入上游密钥）：
//   - OpenAI 面要求 `Authorization: Bearer sk-mock-openai`
//   - Anthropic 面要求 `x-api-key: sk-mock-anthropic`
// 特殊模型：model=error-500 → 恒返回 500（验证网关错误映射）。
// 落点指纹：非流式响应携带 system_fingerprint="mock:<model>"（disguise 层只重写 model/error.message，
// 不触碰该字段）——多上游 E2E 用它在 disguise 生效时区分落点 provider。
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
const OPENAI_KEY = "sk-mock-openai";
const ANTHROPIC_KEY = "sk-mock-anthropic";

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendSse(res, events, delayMs = 30) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let i = 0;
  const timer = setInterval(() => {
    if (i >= events.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    const [event, data] = events[i++];
    if (data === null) {
      // 约定：data 为 null 表示发送裸 [DONE] 终止符（OpenAI SSE 结尾）
      res.write("data: [DONE]\n\n");
      return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }, delayMs);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ============ OpenAI 兼容面样例 ============

function openaiChatResponse(body, model) {
  return {
    id: "chatcmpl-mock-openai",
    object: "chat.completion",
    created: nowSeconds(),
    model,
    system_fingerprint: `mock:${model}`,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `Hello from OpenAI mock (model=${model})`,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const path = url.pathname;

  try {
    // ---------- OpenAI 兼容面 ----------
    if (path.startsWith("/openai/v1/")) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${OPENAI_KEY}`) {
        return sendJson(res, 401, { error: { message: "Mock upstream: invalid API key" } });
      }
      if (method === "POST" && path === "/openai/v1/chat/completions") {
        const body = await readJson(req);
        const model = body?.model ?? "gpt-4o-mini";
        if (model === "error-500") {
          return sendJson(res, 500, { error: { message: "Mock upstream simulated failure" } });
        }
        if (body?.stream === true) {
          const chunk = (choices, extra) => ({
            id: "chatcmpl-mock-openai",
            object: "chat.completion.chunk",
            created: nowSeconds(),
            model,
            choices,
            ...extra,
          });
          return sendSse(
            res,
            [
              ["message", chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }], {})],
              ["message", chunk([{ index: 0, delta: { content: "Hello from OpenAI mock" }, finish_reason: null }], {})],
              ["message", chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {})],
              ["message", chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })],
              ["message", null], // data: [DONE]
            ],
            20,
          );
        }
        return sendJson(res, 200, openaiChatResponse(body, model));
      }
      if (method === "POST" && path === "/openai/v1/completions") {
        const body = await readJson(req);
        return sendJson(res, 200, {
          id: "cmpl-mock-openai",
          object: "text_completion",
          created: nowSeconds(),
          model: body?.model ?? "gpt-4o-mini",
          choices: [
            {
              text: `Hello from OpenAI completions mock (prompt=${String(body?.prompt ?? "").slice(0, 20)})`,
              index: 0,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        });
      }
      if (method === "POST" && path === "/openai/v1/embeddings") {
        const body = await readJson(req);
        return sendJson(res, 200, {
          object: "list",
          data: [
            {
              object: "embedding",
              index: 0,
              embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
            },
          ],
          model: body?.model ?? "text-embedding-3-small",
          usage: { prompt_tokens: 3, total_tokens: 3 },
        });
      }
      if (method === "GET" && path === "/openai/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: [
            { id: "gpt-4o-mini", object: "model", created: nowSeconds(), owned_by: "mock" },
            { id: "text-embedding-3-small", object: "model", created: nowSeconds(), owned_by: "mock" },
          ],
        });
      }
      return sendJson(res, 404, { error: { message: `Mock upstream: not found ${method} ${path}` } });
    }

    // ---------- Anthropic 面 ----------
    if (path.startsWith("/anthropic/v1/")) {
      if (req.headers["x-api-key"] !== ANTHROPIC_KEY) {
        return sendJson(res, 401, { error: { message: "Mock upstream: invalid x-api-key" } });
      }
      if (method === "POST" && path === "/anthropic/v1/messages") {
        const body = await readJson(req);
        const model = body?.model ?? "claude-sonnet-4-20250514";
        const stream = body?.stream === true;
        const system = typeof body?.system === "string" ? body.system : "";
        const maxTokens = body?.max_tokens ?? 0;
        const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;

        if (!stream) {
          return sendJson(res, 200, {
            id: "msg_mock_anthropic",
            type: "message",
            role: "assistant",
            model,
            content: [
              {
                type: "text",
                text: `Hello from Anthropic mock (system=${system}, max_tokens=${maxTokens})`,
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 25, output_tokens: 15 },
          });
        }

        // 流式样例：有 tools 时走 tool_use 事件序列，否则走纯文本事件序列
        const startEvent = {
          type: "message_start",
          message: {
            id: "msg_mock_anthropic",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 25, output_tokens: 1 },
          },
        };
        if (hasTools) {
          return sendSse(
            res,
            [
              ["message_start", startEvent],
              ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_mock1", name: "get_weather", input: {} } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city": "Bei' } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'jing"}' } }],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
              ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
              ["message_stop", { type: "message_stop" }],
            ],
            25,
          );
        }
        return sendSse(
          res,
          [
            ["message_start", startEvent],
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
            ["ping", { type: "ping" }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Anthropic mock" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " (streamed)" } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }],
            ["message_stop", { type: "message_stop" }],
          ],
          25,
        );
      }
      return sendJson(res, 404, { error: { message: `Mock upstream: not found ${method} ${path}` } });
    }

    return sendJson(res, 404, { error: { message: `Mock upstream: not found ${method} ${path}` } });
  } catch (error) {
    return sendJson(res, 500, { error: { message: `Mock upstream internal error: ${String(error)}` } });
  }
});

server.listen(PORT, () => {
  console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-upstream] openai:  /openai/v1  (Bearer ${OPENAI_KEY})`);
  console.log(`[mock-upstream] anthropic: /anthropic/v1 (x-api-key ${ANTHROPIC_KEY})`);
});
