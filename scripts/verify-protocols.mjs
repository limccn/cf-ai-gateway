// 多协议入口本地端到端验证（三协议适配集成验收，PRD AC1-AC7）。
// 覆盖：
//   1. 基线回归：/v1/chat/completions 非流式 + 流式（[DONE] + usage 尾包）
//   2. Anthropic 入站：/v1/messages 与 /anthropic/v1/messages（非流式 + 流式，
//      Anthropic 形态响应/事件序列，usage 换算入账）
//   3. Responses 入口：/v1/responses（非流式 + 流式，无 [DONE]，sequence_number）
//   4. anthropic 上游闭环：claude-sonnet 模型经 /v1/messages（正向适配器）
//   5. 错误形态：错 key 401（Anthropic vs OpenAI 形态）、模型不可路由 404
// 前置：
//   - `node scripts/mock-upstream.mjs` 已启动（8788，openai + anthropic 双面）
//   - `npm run dev` 已启动（http://localhost:5173，可 BASE_URL 覆盖）
// 用法：node scripts/verify-protocols.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const DB_NAME = "cf-ai-gateway-db";
const ADMIN_EMAIL = "proto-admin@example.com";
const PASSWORD = "testpass123";
const INVITE_ADMIN = "PROTOVERIFY01";
const OPENAI_PROVIDER = {
  name: "openai-mock",
  type: "openai",
  baseUrl: "http://127.0.0.1:8788/openai/v1",
  apiKey: "sk-mock-openai",
  models: { "gpt-4o-mini": "gpt-4o-mini", "error-500": "error-500" },
};
const ANTHROPIC_PROVIDER = {
  name: "anthropic-mock",
  type: "anthropic",
  baseUrl: "http://127.0.0.1:8788/anthropic/v1",
  apiKey: "sk-mock-anthropic",
  models: { "claude-sonnet-4-20250514": "claude-sonnet-4-20250514" },
};
// 价格（/1e6 USD）：gpt-4o-mini mock usage 10/5 → cost = 10*0.15 + 5*0.6 = 4.5e-6
// anthropic mock usage 25/15 → cost = 25*0.15 + 15*0.6 = 12.75e-6
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;
const GPT_COST = (10 * INPUT_PRICE + 5 * OUTPUT_PRICE) / 1_000_000;
const CLAUDE_COST = (25 * INPUT_PRICE + 15 * OUTPUT_PRICE) / 1_000_000;

let passed = 0;
let failed = 0;
const lastFailures = [];

function report(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    lastFailures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  <- ${detail}` : ""}`);
  }
}

const WRANGLER_JS = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

function runSql(sql) {
  execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", DB_NAME, "--local", "--command", sql],
    { stdio: "pipe", encoding: "utf8" },
  );
}

function query(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", DB_NAME, "--local", "--command", sql, "--json"],
    { stdio: "pipe", encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
  const finalHeaders = { ...headers };
  if (cookie) finalHeaders.Cookie = cookie;
  if (body !== undefined) finalHeaders["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    console.log(`  [retry] ${method} ${path} failed (${error.cause?.code ?? error.message}), retrying...`);
    await sleep(500);
    res = await fetch(BASE + path, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // SSE 等
  }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookieOut = setCookies.length > 0
    ? setCookies.map((c) => c.split(";")[0]).filter((c) => c.includes("=")).join("; ")
    : null;
  return { status: res.status, json, text, cookie: cookieOut };
}

/** 合并同一帧的 event: 行与 data: 行（Anthropic SSE 为 event+data 两行一帧）。 */
function parseSse(text) {
  const events = [];
  let current = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) {
      current.event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data === "[DONE]") current.done = true;
      else {
        try {
          current.data = JSON.parse(data);
        } catch {
          current.raw = data;
        }
      }
      events.push(current);
      current = {};
    }
  }
  return events;
}

const ORIGIN = new URL(BASE).origin;

async function signup(email, inviteCode) {
  return api("/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: { email, password: PASSWORD, name: email.split("@")[0], inviteCode },
  });
}

async function signin(email) {
  return api("/api/auth/sign-in/email", {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: { email, password: PASSWORD },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`\n=== Multi-protocol verify @ ${BASE} ===`);

  // ---------- 0. 准备本地 D1（幂等可重跑） ----------
  console.log("\n[setup] prepare local D1");
  // 本地测试库整体清理（外键顺序：先删引用方）。幂等可重跑。
  runSql(
    `DELETE FROM balance_tx;` +
      `DELETE FROM request_logs;` +
      `DELETE FROM usage_daily;` +
      `DELETE FROM api_keys;` +
      `DELETE FROM accounts;` +
      `DELETE FROM sessions;` +
      `DELETE FROM invite_codes;` +
      `DELETE FROM providers;` +
      `DELETE FROM models;` +
      `DELETE FROM users;`,
  );
  runSql(
    `INSERT OR IGNORE INTO users (id, email, name, role, status, balance, email_verified, created_at, updated_at) ` +
      `VALUES (1,'bootstrap@example.com','Bootstrap','admin','active',100,1,unixepoch(),unixepoch());`,
  );
  runSql(
    `INSERT OR IGNORE INTO invite_codes (code, created_by, expires_at, created_at) VALUES ` +
      `('${INVITE_ADMIN}',1,unixepoch()+86400,unixepoch());`,
  );

  // ---------- 1. 认证 + 配置（provider / price / key / balance） ----------
  console.log("\n[1] auth + config");
  const signupRes = await signup(ADMIN_EMAIL, INVITE_ADMIN);
  report("admin signup", signupRes.status === 200 || signupRes.status === 201, `status=${signupRes.status}`);
  runSql(`UPDATE users SET role='admin' WHERE email='${ADMIN_EMAIL}';`);
  const signinRes = await signin(ADMIN_EMAIL);
  report("admin signin", signinRes.status === 200 && signinRes.cookie !== null, `status=${signinRes.status}`);
  const authApi = { cookie: signinRes.cookie };

  const userList = await api("/api/users", authApi);
  const adminUserId = (userList.json?.items ?? []).find((u) => u.email === ADMIN_EMAIL)?.id;

  const createOpenai = await api("/api/providers", { method: "POST", ...authApi, body: OPENAI_PROVIDER });
  report("create openai provider", createOpenai.status === 200, `status=${createOpenai.status}`);
  const createAnthropic = await api("/api/providers", { method: "POST", ...authApi, body: ANTHROPIC_PROVIDER });
  report("create anthropic provider", createAnthropic.status === 200, `status=${createAnthropic.status}`);

  for (const model of ["gpt-4o-mini", "claude-sonnet-4-20250514"]) {
    await api("/api/models", {
      method: "POST",
      ...authApi,
      body: { model, inputPriceShort: INPUT_PRICE, inputPriceLong: INPUT_PRICE, inputPriceCached: INPUT_PRICE / 4, outputPriceShort: OUTPUT_PRICE, outputPriceLong: OUTPUT_PRICE },
    });
  }
  const credit = await api(`/api/users/${adminUserId}/balance`, { method: "POST", ...authApi, body: { amount: 10, note: "protocol verify credit" } });
  report("credit +10", credit.status === 200 && credit.json?.balance === 10, `balance=${credit.json?.balance}`);

  const createKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "proto-key" } });
  const plaintext = createKey.json?.plaintext ?? "";
  report("create gateway key", createKey.status === 200 && plaintext.startsWith("sk-"), `status=${createKey.status}`);
  const proxyAuth = { Authorization: `Bearer ${plaintext}` };

  const balanceSql = () =>
    query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
  const approx = (a, b) => Math.abs(a - b) < 1e-9;

  // ---------- 2. 基线回归：/v1/chat/completions ----------
  console.log("\n[2] baseline /v1/chat/completions (zero regression)");
  const chat = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
  });
  report("non-stream 200 + OpenAI form", chat.status === 200 && chat.json?.choices?.[0]?.message?.content?.includes("Hello from OpenAI mock"), `status=${chat.status}`);
  report("chat non-stream charged", approx(balanceSql(), 10 - GPT_COST), `balance=${balanceSql()}`);

  const chatStream = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true },
  });
  const chatEvents = parseSse(chatStream.text);
  report(
    "stream SSE + usage tail + [DONE]",
    chatStream.status === 200 &&
      chatEvents.some((e) => e.data?.usage?.prompt_tokens === 10) &&
      chatEvents.some((e) => e.done),
    `events=${chatEvents.length}`,
  );
  report("chat stream charged", approx(balanceSql(), 10 - 2 * GPT_COST), `balance=${balanceSql()}`);

  // ---------- 3. Anthropic 入站：/v1/messages + /anthropic/v1/messages ----------
  console.log("\n[3] anthropic inbound (/v1/messages + /anthropic/v1/messages)");
  const anthropicBody = {
    model: "gpt-4o-mini",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  };

  const msgV1 = await api("/v1/messages", { method: "POST", headers: proxyAuth, body: anthropicBody });
  report(
    "non-stream Anthropic form (type=message, msg_ id, usage 10/5)",
    msgV1.status === 200 && msgV1.json?.type === "message" && msgV1.json?.id?.startsWith("msg_") &&
      msgV1.json?.usage?.input_tokens === 10 && msgV1.json?.usage?.output_tokens === 5 &&
      msgV1.json?.content?.[0]?.text?.includes("Hello from OpenAI mock"),
    `status=${msgV1.status} ${JSON.stringify(msgV1.json?.usage)}`,
  );

  const msgAnthropic = await api("/anthropic/v1/messages", { method: "POST", headers: proxyAuth, body: anthropicBody });
  report(
    "same via /anthropic/v1/messages",
    msgAnthropic.status === 200 && msgAnthropic.json?.type === "message" && msgAnthropic.json?.usage?.output_tokens === 5,
    `status=${msgAnthropic.status}`,
  );

  // x-api-key 鉴权（Anthropic SDK 方式）+ anthropic-version 头
  const msgXKey = await api("/anthropic/v1/messages", {
    method: "POST",
    headers: { "x-api-key": plaintext, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: anthropicBody,
  });
  report("x-api-key + anthropic-version accepted", msgXKey.status === 200 && msgXKey.json?.type === "message", `status=${msgXKey.status}`);

  const msgStream = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: { ...anthropicBody, stream: true },
  });
  const msgEvents = parseSse(msgStream.text);
  const hasEvent = (type) => msgEvents.some((e) => e.event === type);
  report(
    "stream event sequence (message_start → message_delta → message_stop)",
    msgStream.status === 200 && hasEvent("message_start") && hasEvent("content_block_delta") &&
      hasEvent("message_delta") && hasEvent("message_stop"),
    `events=${msgEvents.length}`,
  );
  const deltaEvent = msgEvents.find((e) => e.event === "message_delta");
  report("message_delta output_tokens=5 (deferred to usage tail)", deltaEvent?.data?.usage?.output_tokens === 5, JSON.stringify(deltaEvent?.data?.usage));
  report("no [DONE] leak into anthropic output", !msgEvents.some((e) => e.done), "");
  // 4 次调用（/v1/messages + /anthropic/v1/messages + x-api-key + 流式）+ 块 2 两次 = 6 次 GPT
  report("anthropic 4 calls charged", approx(balanceSql(), 10 - 6 * GPT_COST), `balance=${balanceSql()}`);

  // ---------- 4. anthropic 上游闭环：claude-sonnet 经 /v1/messages ----------
  console.log("\n[4] anthropic upstream closed loop (claude-sonnet via /v1/messages)");
  const claudeMsg = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "claude-sonnet-4-20250514", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
  });
  report(
    "anthropic upstream → Anthropic form (usage 25/15)",
    claudeMsg.status === 200 && claudeMsg.json?.type === "message" &&
      claudeMsg.json?.content?.[0]?.text?.includes("Hello from Anthropic mock") &&
      claudeMsg.json?.usage?.input_tokens === 25 && claudeMsg.json?.usage?.output_tokens === 15,
    `status=${claudeMsg.status}`,
  );
  // 6 次 GPT + 1 次 CLAUDE
  report("claude charged", approx(balanceSql(), 10 - 6 * GPT_COST - CLAUDE_COST), `balance=${balanceSql()}`);

  // 带 tools 触发 mock 上游 tool_use 事件序列
  const claudeStream = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "claude-sonnet-4-20250514",
      max_tokens: 64,
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      stream: true,
    },
  });
  const claudeStreamEvents = parseSse(claudeStream.text);
  const hasToolUse = claudeStreamEvents.some((e) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use") ||
    claudeStreamEvents.some((e) => e.event === "content_block_delta" && e.data?.delta?.type === "input_json_delta");
  report("anthropic upstream tool_use path", claudeStream.status === 200 && hasToolUse, `events=${claudeStreamEvents.length}`);
  const claudeDelta = claudeStreamEvents.find((e) => e.event === "message_delta");
  report("anthropic upstream message_delta usage=20", claudeDelta?.data?.usage?.output_tokens === 20, JSON.stringify(claudeDelta?.data?.usage));

  // ---------- 5. Responses 入口：/v1/responses ----------
  console.log("\n[5] /v1/responses");
  const respBody = { model: "gpt-4o-mini", input: "hello" };
  const resp = await api("/v1/responses", { method: "POST", headers: proxyAuth, body: respBody });
  report(
    "non-stream Response form (resp_ id, output_text, usage 10/5)",
    resp.status === 200 && resp.json?.object === "response" && resp.json?.id?.startsWith("resp_") &&
      resp.json?.status === "completed" && resp.json?.output_text?.includes("Hello from OpenAI mock") &&
      resp.json?.usage?.input_tokens === 10 && resp.json?.usage?.output_tokens === 5,
    `status=${resp.status} ${JSON.stringify(resp.json?.usage)}`,
  );

  const respStream = await api("/v1/responses", { method: "POST", headers: proxyAuth, body: { ...respBody, stream: true } });
  const respEvents = parseSse(respStream.text);
  const respType = (t) => respEvents.some((e) => e.data?.type === t);
  report(
    "stream events (created/in_progress/delta/completed, no [DONE])",
    respStream.status === 200 && respType("response.created") && respType("response.in_progress") &&
      respType("response.output_text.delta") && respType("response.completed") && !respEvents.some((e) => e.done),
    `events=${respEvents.length}`,
  );
  const completedEvent = respEvents.find((e) => e.data?.type === "response.completed");
  report("completed carries usage 10/5 + status", completedEvent?.data?.response?.status === "completed" &&
    completedEvent?.data?.response?.usage?.input_tokens === 10 && completedEvent?.data?.response?.usage?.output_tokens === 5,
  JSON.stringify(completedEvent?.data?.response?.usage));
  const seqs = respEvents.filter((e) => e.data?.sequence_number !== undefined).map((e) => e.data.sequence_number);
  const seqOk = seqs.length > 0 && seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
  report("sequence_number monotonic", seqOk, seqs.join(","));

  // ---------- 6. 错误形态 ----------
  console.log("\n[6] error shapes (401/404)");
  const badAuth = { Authorization: "Bearer sk-wrong-key" };
  const err401Chat = await api("/v1/chat/completions", { method: "POST", headers: badAuth, body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] } });
  report("401 OpenAI form", err401Chat.status === 401 && err401Chat.json?.error?.message?.length > 0, `status=${err401Chat.status}`);
  const err401Msg = await api("/v1/messages", { method: "POST", headers: badAuth, body: anthropicBody });
  report("401 Anthropic form (type=error, authentication_error)", err401Msg.status === 401 &&
    err401Msg.json?.type === "error" && err401Msg.json?.error?.type === "authentication_error", JSON.stringify(err401Msg.json));
  const err401Resp = await api("/v1/responses", { method: "POST", headers: badAuth, body: respBody });
  report("401 Responses OpenAI form", err401Resp.status === 401 && err401Resp.json?.error?.message?.length > 0, `status=${err401Resp.status}`);

  const err404Msg = await api("/v1/messages", { method: "POST", headers: proxyAuth, body: { ...anthropicBody, model: "no-such-model" } });
  report("404 Anthropic form (not_found_error)", err404Msg.status === 404 &&
    err404Msg.json?.type === "error" && err404Msg.json?.error?.type === "not_found_error", JSON.stringify(err404Msg.json));

  // ---------- 7. 官方 SDK 直连（真实 HTTP 层） ----------
  console.log("\n[7] official SDK direct-connect");
  // authToken: null 显式隔离本机 ANTHROPIC_AUTH_TOKEN 环境变量
  // （否则 SDK 会同时发 authorization Bearer <env token>，网关 Bearer 优先 → 401）
  const anthropic = new Anthropic({ apiKey: plaintext, baseURL: `${BASE}/anthropic`, authToken: null });
  const sdkMsg = await anthropic.messages.create({
    model: "gpt-4o-mini",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  });
  report(
    "Anthropic SDK non-stream (x-api-key auth + usage 10/5)",
    sdkMsg.type === "message" && sdkMsg.usage.input_tokens === 10 && sdkMsg.usage.output_tokens === 5 &&
      sdkMsg.content.some((b) => b.type === "text" && b.text.includes("Hello from OpenAI mock")),
    `id=${sdkMsg.id}`,
  );

  const sdkStream = await anthropic.messages.stream({
    model: "gpt-4o-mini",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  });
  const sdkSeen = new Set();
  for await (const event of sdkStream) {
    sdkSeen.add(event.type);
  }
  report(
    "Anthropic SDK stream (message_start→message_stop)",
    sdkSeen.has("message_start") && sdkSeen.has("content_block_delta") && sdkSeen.has("message_stop"),
    [...sdkSeen].join(","),
  );

  const openai = new OpenAI({ apiKey: plaintext, baseURL: `${BASE}/v1` });
  const sdkResp = await openai.responses.create({ model: "gpt-4o-mini", input: "hello" });
  report(
    "OpenAI SDK responses.create (resp_ id + output_text)",
    sdkResp.object === "response" && sdkResp.id.startsWith("resp_") && sdkResp.output_text.includes("Hello from OpenAI mock"),
    `id=${sdkResp.id}`,
  );
  const sdkRespStream = await openai.responses.create({ model: "gpt-4o-mini", input: "hello", stream: true });
  let sawCompleted = false;
  let sawText = false;
  for await (const event of sdkRespStream) {
    if (event.type === "response.completed") sawCompleted = true;
    if (event.type === "response.output_text.delta") sawText = true;
  }
  report("OpenAI SDK responses stream (delta + completed)", sawText && sawCompleted, "");
  const sdkChat = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
  });
  report("OpenAI SDK chat.completions (regression)", sdkChat.choices[0]?.message?.content?.includes("Hello from OpenAI mock"), `id=${sdkChat.id}`);

  // ---------- 汇总 ----------
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failed:", lastFailures.join(" | "));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Script error:", error);
  process.exitCode = 1;
});
