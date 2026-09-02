// Anthropic Messages（原生）协议验证 E2E（09-01-cc-switch-forwarding-audit 批次）：
// Claude Code 原生协议链路在两种 base_url 形态下端到端验证（think/effort 适配之上）。
// 自包含：内嵌双上游 mock（anthropic /openai），不依赖/不修改 mock-upstream.mjs。
// 形态矩阵：
//   A1  /anthropic/v1/messages（显式）— 流式+thinking 直通 + 非流式 output_config 直通
//   A2  /anthropic/messages（别名）— 与 A1 等价
//   A1t tool_use 往返（流式）：入站 tool_use/tool_result → 响应含 tool_use 块
//   A1a 鉴权：Bearer 与 x-api-key 各一发；错误 key → 401 authentication_error（Anthropic shape）
//   B1  /v1/messages + anthropic-version 硬信号 + thinking → anthropic 链路
//   B2  /v1/chat/completions openai 体 → chat.completion + [DONE]（openai 兜底）
//   终局：request_logs ≥5 success 行
// 用法：npm run dev（另一终端）; node scripts/verify-anthropic-native.mjs
// 前置：本地 D1 已迁移（npm run db:migrate -- --local）+ seed 价格表（npm run db:seed -- --local）
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const INVITE_ADMIN = "CCSWITCH";
const ADMIN_EMAIL = "cc-switch-admin@example.com";
const PASSWORD = "testpass123";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;
const ANTHROPIC_PROVIDER_BODY = {
  name: "cc-switch-anthropic-mock",
  type: "anthropic",
  baseUrl: null, // 内嵌 mock 端口就绪后填入
  apiKey: "sk-mock-anthropic",
  models: { "claude-native-4": "claude-native-4" },
};
const OPENAI_PROVIDER_BODY = {
  name: "cc-switch-openai-mock",
  type: "openai",
  baseUrl: null,
  apiKey: "sk-mock-openai",
  models: { "gpt-native-4o": "gpt-native-4o" },
};

let passed = 0;
let failed = 0;
const lastFailures = [];

function report(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    lastFailures.push({ name, detail });
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

// ============ 内嵌双上游 mock（自包含） ============

const captured = []; // { path, method, body }

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendSse(res, events, delayMs = 25) {
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

function anthropicThinkingSse(model) {
  const startEvent = {
    type: "message_start",
    message: {
      id: "msg_native_anthropic",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 1 },
    },
  };
  return [
    ["message_start", startEvent],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " about the plan" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_native_01" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello from native Anthropic mock" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " (streamed)" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

function anthropicToolUseSse(model) {
  const startEvent = {
    type: "message_start",
    message: {
      id: "msg_native_tool",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 1 },
    },
  };
  return [
    ["message_start", startEvent],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_native1", name: "get_weather", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city": "Bei' } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'jing"}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

async function startMock() {
  const mock = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    if (method === "GET" && path === "/__captured") {
      return sendJson(res, 200, { captured });
    }

    try {
      if (path.startsWith("/anthropic/v1/") || path.startsWith("/anthropic/")) {
        if (method === "POST" && (path === "/anthropic/v1/messages" || path === "/anthropic/messages")) {
          const body = await readJson(req);
          captured.push({ path, method, body });
          const model = body?.model ?? "claude-sonnet-4-20250514";
          const stream = body?.stream === true;
          // 请求带 thinking（或模型含 thinking）→ thinking SSE 流
          if (stream && (body?.thinking !== undefined || model.includes("thinking"))) {
            return sendSse(res, anthropicThinkingSse(model));
          }
          // 请求 messages 含 tool_result → tool_use 流
          const hasToolResult = (body?.messages ?? []).some((m) =>
            Array.isArray(m?.content) && m.content.some((c) => c?.type === "tool_result"),
          );
          if (stream && hasToolResult) {
            return sendSse(res, anthropicToolUseSse(model));
          }
          if (stream) {
            return sendSse(res, [
              ["message_start", { type: "message_start", message: { id: "msg_native_plain", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } }],
              ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from native Anthropic mock" } }],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
              ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }],
              ["message_stop", { type: "message_stop" }],
            ]);
          }
          return sendJson(res, 200, {
            id: "msg_native_nonstream",
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: "Hello from native Anthropic mock (non-stream)" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 25, output_tokens: 15 },
          });
        }
        return sendJson(res, 404, { error: { message: `Mock: not found ${method} ${path}` } });
      }

      if (path.startsWith("/openai/v1/")) {
        if (method === "POST" && path === "/openai/v1/chat/completions") {
          const body = await readJson(req);
          captured.push({ path, method, body });
          const model = body?.model ?? "gpt-4o-mini";
          if (body?.stream === true) {
            const chunk = (choices, extra) => ({
              id: "chatcmpl-native-openai",
              object: "chat.completion.chunk",
              created: nowSeconds(),
              model,
              choices,
              ...extra,
            });
            return sendSse(res, [
              ["message", chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }], {})],
              ["message", chunk([{ index: 0, delta: { content: "Hello from native OpenAI mock" }, finish_reason: null }], {})],
              ["message", chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {})],
              ["message", chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })],
              ["message", null], // data: [DONE]
            ], 20);
          }
          return sendJson(res, 200, {
            id: "chatcmpl-native-openai",
            object: "chat.completion",
            created: nowSeconds(),
            model,
            choices: [{ index: 0, message: { role: "assistant", content: "Hello from native OpenAI mock" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        return sendJson(res, 404, { error: { message: `Mock: not found ${method} ${path}` } });
      }

      return sendJson(res, 404, { error: { message: `Mock: not found ${method} ${path}` } });
    } catch (error) {
      return sendJson(res, 500, { error: { message: `Mock internal error: ${String(error)}` } });
    }
  });

  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const port = mock.address().port;
  console.log(`[verify-anthropic-native] mock upstream on http://127.0.0.1:${port}`);
  return { port, mock };
}

// ============ D1 / API helpers（复用 verify-thinking 模式） ============

const WRANGLER_JS = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

function runSql(sql) {
  execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", "cf-ai-gateway-db", "--local", "--command", sql],
    { stdio: "pipe", encoding: "utf8" },
  );
}

function query(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", "cf-ai-gateway-db", "--local", "--json", "--command", sql],
    { stdio: "pipe", encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
  const requestHeaders = {
    "Content-Type": "application/json",
    Origin: new URL(BASE).origin,
    ...(cookie ? { Cookie: cookie } : {}),
    ...headers,
  };
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    console.log(`  [retry] ${method} ${path} failed (${error.cause?.code ?? error.message}), retrying...`);
    await sleep(500);
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // 非 JSON（如 SSE 原样）→ json 保持 null
  }
  return { status: res.status, headers: res.headers, text, json };
}

function parseSse(text) {
  return text
    .split("\n\n")
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
      return dataLine ? dataLine.slice(6).trim() : null;
    })
    .filter((data) => data !== null && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

async function signup(email, inviteCode) {
  return api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, inviteCode, name: email.split("@")[0] ?? "ccsw" },
  });
}

async function signin(email) {
  const res = await api("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? null;
  return { status: res.status, cookie };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function poll(fn, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      const result = await fn();
      if (result !== null) {
        resolve(result);
        return;
      }
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** 取 mock 上游最近一次匹配 path 的 anthropic/openai 请求体。 */
async function lastCaptured(matchPath) {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/__captured`);
  const { captured: list } = await res.json();
  const hit = list.findLast((r) => r.path === matchPath && r.method === "POST");
  return hit?.body ?? null;
}

// ============ 场景体构造 ============

function anthropicBody({ stream, thinking, outputConfig, withToolRoundtrip, suffix }) {
  const messages = [];
  if (withToolRoundtrip) {
    messages.push(
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_ccsw1", content: "晴，26°C" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_ccsw1", name: "get_weather", input: { city: "Beijing" } },
        ],
      },
    );
  }
  messages.push({ role: "user", content: `NATIVE-CCSWITCH-${suffix}` });
  const body = {
    model: "claude-native-4",
    max_tokens: 64,
    system: "You are a helpful assistant.",
    messages,
    stream,
  };
  if (thinking) {
    body.thinking = { type: "enabled", budget_tokens: 2048 };
  }
  if (outputConfig) {
    body.output_config = outputConfig;
  }
  return body;
}

let MOCK_PORT = 0;
let mockServer = null;

async function main() {
  console.log(`\n=== anthropic-native verify @ ${BASE} ===`);

  // ---------- 0. 内嵌 mock + 本地 D1 准备 ----------
  console.log("\n[setup] start embedded mock + prepare local D1");
  const { port, mock } = await startMock();
  MOCK_PORT = port;
  mockServer = mock;
  ANTHROPIC_PROVIDER_BODY.baseUrl = `http://127.0.0.1:${port}/anthropic/v1`;
  OPENAI_PROVIDER_BODY.baseUrl = `http://127.0.0.1:${port}/openai/v1`;

  runSql(
    `DELETE FROM invite_codes;` +
      `DELETE FROM accounts;` +
      `DELETE FROM sessions;` +
      `DELETE FROM balance_tx;` +
      `DELETE FROM usage_daily;` +
      `DELETE FROM request_logs;` +
      `DELETE FROM api_keys;` +
      `DELETE FROM providers;` +
      `DELETE FROM models;` +
      `DELETE FROM users WHERE email <> 'bootstrap@example.com';`,
  );
  runSql(
    `INSERT OR IGNORE INTO users (id, email, name, role, status, balance, email_verified, created_at, updated_at) ` +
      `VALUES (1,'bootstrap@example.com','Bootstrap','admin','active',100,1,unixepoch(),unixepoch());`,
  );
  runSql(
    `INSERT OR IGNORE INTO invite_codes (code, created_by, expires_at, created_at) VALUES ` +
      `('${INVITE_ADMIN}',1,unixepoch()+86400,unixepoch());`,
  );

  // ---------- 1. auth + 资源 ----------
  console.log("\n[1] auth + providers + key");
  const signupAdmin = await signup(ADMIN_EMAIL, INVITE_ADMIN);
  report("admin signup", signupAdmin.status === 200 || signupAdmin.status === 201, `status=${signupAdmin.status}`);
  runSql(`UPDATE users SET role='admin', balance=100 WHERE email='${ADMIN_EMAIL}';`);
  const signinAdmin = await signin(ADMIN_EMAIL);
  report("admin signin", signinAdmin.status === 200 && signinAdmin.cookie !== null, `status=${signinAdmin.status}`);
  const authApi = { cookie: signinAdmin.cookie };

  const p1 = await api("/api/providers", { method: "POST", ...authApi, body: ANTHROPIC_PROVIDER_BODY });
  report("create anthropic provider", p1.status === 200, `status=${p1.status}`);
  const p2 = await api("/api/providers", { method: "POST", ...authApi, body: OPENAI_PROVIDER_BODY });
  report("create openai provider", p2.status === 200, `status=${p2.status}`);

  for (const model of ["claude-native-4", "gpt-native-4o"]) {
    const price = await api("/api/models", {
      method: "POST",
      ...authApi,
      body: { model, inputPriceShort: INPUT_PRICE, inputPriceLong: INPUT_PRICE, inputPriceCached: 0, outputPriceShort: OUTPUT_PRICE, outputPriceLong: OUTPUT_PRICE },
    });
    report(`price ${model}`, price.status === 200, `status=${price.status}`);
  }

  const createKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "cc-switch-key" } });
  const plaintext = createKey.json?.plaintext ?? "";
  report("create gateway key", createKey.status === 200 && plaintext.startsWith("sk-"), `status=${createKey.status}`);

  // ---------- 2. 形态 A1：/anthropic/v1/messages 流式 + thinking 直通 ----------
  console.log("\n[2] A1 /anthropic/v1/messages (stream + thinking passthrough)");
  const a1 = await api("/anthropic/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${plaintext}` },
    body: anthropicBody({ stream: true, thinking: true, suffix: "A1" }),
  });
  const a1Events = parseSse(a1.text);
  const a1ThinkingDeltas = a1Events.filter(
    (e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta",
  );
  report(
    "A1 流式 200 + SSE（thinking_delta ≥1 + message_stop）",
    a1.status === 200 &&
      a1.headers.get("content-type")?.includes("text/event-stream") &&
      a1ThinkingDeltas.length >= 1 &&
      a1Events.some((e) => e.type === "message_stop"),
    `status=${a1.status} thinkingDeltas=${a1ThinkingDeltas.length}`,
  );
  const a1Upstream = await lastCaptured("/anthropic/v1/messages");
  report(
    "A1 thinking 逐字直通上游（入站 = 上游收到）",
    JSON.stringify(a1Upstream?.thinking) === JSON.stringify({ type: "enabled", budget_tokens: 2048 }),
    `thinking=${JSON.stringify(a1Upstream?.thinking)}`,
  );

  // ---------- 3. 形态 A1 非流式 + output_config 直通 ----------
  console.log("\n[3] A1 non-stream + output_config passthrough");
  const outputConfig = { reasoning: { effort: "high" } };
  const a1ns = await api("/anthropic/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${plaintext}` },
    body: anthropicBody({ stream: false, outputConfig, suffix: "A1NS" }),
  });
  report(
    "A1 非流式 200 + message 形态",
    a1ns.status === 200 && a1ns.json?.type === "message" && a1ns.json?.content?.[0]?.type === "text",
    `status=${a1ns.status} type=${a1ns.json?.type}`,
  );
  const a1nsUpstream = await lastCaptured("/anthropic/v1/messages");
  report(
    "A1 output_config 逐字直通上游",
    JSON.stringify(a1nsUpstream?.output_config) === JSON.stringify(outputConfig),
    `output_config=${JSON.stringify(a1nsUpstream?.output_config)}`,
  );

  // ---------- 4. 形态 A2：/anthropic/messages 别名等价 ----------
  console.log("\n[4] A2 /anthropic/messages alias");
  const a2 = await api("/anthropic/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${plaintext}` },
    body: anthropicBody({ stream: true, thinking: true, suffix: "A2" }),
  });
  const a2Events = parseSse(a2.text);
  const a2ThinkingDeltas = a2Events.filter(
    (e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta",
  );
  report(
    "A2 别名与 A1 等价（200 + thinking_delta ≥1 + message_stop）",
    a2.status === 200 &&
      a2ThinkingDeltas.length >= 1 &&
      a2Events.some((e) => e.type === "message_stop"),
    `status=${a2.status} thinkingDeltas=${a2ThinkingDeltas.length}`,
  );

  // ---------- 5. A1 tool_use 往返（流式） ----------
  console.log("\n[5] A1 tool_use roundtrip");
  const at = await api("/anthropic/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${plaintext}` },
    body: anthropicBody({ stream: true, withToolRoundtrip: true, suffix: "TOOL" }),
  });
  const atEvents = parseSse(at.text);
  const atToolUse = atEvents.filter(
    (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use",
  );
  report(
    "tool_use 往返（入站 tool_use/tool_result → 响应含 content_block_start(tool_use)）",
    at.status === 200 &&
      atToolUse.length >= 1 &&
      atEvents.some((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"),
    `status=${at.status} toolUseBlocks=${atToolUse.length}`,
  );

  // ---------- 6. 鉴权：x-api-key 与 Bearer 等价 + 错误 key 401 ----------
  console.log("\n[6] auth (x-api-key / bearer / wrong key)");
  const xk = await api("/anthropic/v1/messages", {
    method: "POST",
    headers: { "x-api-key": plaintext },
    body: anthropicBody({ stream: false, suffix: "XAPIKEY" }),
  });
  report(
    "x-api-key 鉴权（Anthropic SDK 默认头）→ 200",
    xk.status === 200 && xk.json?.type === "message",
    `status=${xk.status}`,
  );
  const bad = await api("/anthropic/v1/messages", {
    method: "POST",
    headers: { Authorization: "Bearer sk-wrong-key" },
    body: anthropicBody({ stream: false, suffix: "BAD" }),
  });
  const badError = bad.json?.error ?? null;
  report(
    // Anthropic 官方 401 是扁平形态：{"type":"authentication_error","message":"..."}（区别于 envelope 内错误）
    "错误 key → 401 + Anthropic shape（authentication_error）",
    bad.status === 401 && badError?.type === "authentication_error" && typeof badError?.message === "string",
    `status=${bad.status} error=${JSON.stringify(badError)}`,
  );

  // ---------- 7. 形态 B1：/v1/messages + anthropic-version 硬信号 + thinking ----------
  console.log("\n[7] B1 /v1/messages (anthropic-version + thinking)");
  const b0 = query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
  const b1 = await api("/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${plaintext}`,
      "anthropic-version": "2023-06-01",
    },
    body: anthropicBody({ stream: true, thinking: true, suffix: "B1" }),
  });
  const b1Events = parseSse(b1.text);
  const b1ThinkingDeltas = b1Events.filter(
    (e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta",
  );
  report(
    "B1 双协议感知 → anthropic 链路（200 + thinking_delta ≥1 + message_stop）",
    b1.status === 200 &&
      b1ThinkingDeltas.length >= 1 &&
      b1Events.some((e) => e.type === "message_stop"),
    `status=${b1.status} thinkingDeltas=${b1ThinkingDeltas.length}`,
  );

  // ---------- 8. 形态 B2：/v1/chat/completions openai 兜底 ----------
  console.log("\n[8] B2 /v1/chat/completions (openai fallback)");
  const b2 = await api("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${plaintext}` },
    body: {
      model: "gpt-native-4o",
      messages: [{ role: "user", content: "NATIVE-CCSWITCH-B2" }],
      stream: true,
    },
  });
  const b2Events = parseSse(b2.text);
  report(
    "B2 openai 体 → chat.completion 形态 + [DONE]",
    b2.status === 200 &&
      b2.headers.get("content-type")?.includes("text/event-stream") &&
      b2Events.some((e) => e.choices?.[0]?.delta?.content !== undefined) &&
      b2.text.includes("[DONE]"),
    `status=${b2.status} events=${b2Events.length} hasDONE=${b2.text.includes("[DONE]")}`,
  );
  const b2Upstream = await lastCaptured("/openai/v1/chat/completions");
  report(
    "B2 落 openai 上游（mock 收到 chat body）",
    b2Upstream !== null && b2Upstream.model === "gpt-native-4o",
    `model=${JSON.stringify(b2Upstream?.model)}`,
  );

  // ---------- 9. 结算：request_logs ≥5 success + balance 下降 ----------
  console.log("\n[9] settlement");
  const settled = await poll(async () => {
    const rows = query(`SELECT status FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') AND status='success' ORDER BY id;`);
    const balance = query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
    if (rows.length >= 5 && balance !== null && balance < b0) {
      return { rows: rows.length, balance };
    }
    return null;
  }, 120000);
  report(
    "结算：request_logs ≥5 success（A1×2 + A2 + tool + x-api-key + B1 + B2）+ balance 下降",
    settled !== null,
    JSON.stringify(settled ?? null),
  );

  mockServer.close();
  console.log(`\n=== anthropic-native verify: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("\nFailed checks:");
    for (const failure of lastFailures) {
      console.log(`  - ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("verify-anthropic-native crashed:", error);
  mockServer?.close();
  process.exitCode = 1;
});
