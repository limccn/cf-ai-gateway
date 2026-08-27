// M3 端到端验证脚本（本地 dev + mock 上游）：
//   1) 清理/准备本地 D1（bootstrap admin + 邀请码）
//   2) 注册/登录 → 创建 Provider（openai/anthropic mock）→ 创建网关 Key
//   3) /v1/* 全链路：鉴权 → 限流 → 余额 → 路由 → 转发（非流式 + 流式 + 错误映射）
// 前置：
//   - `node scripts/mock-upstream.mjs` 已启动（8788）
//   - `npm run dev` 已启动（http://localhost:5173，可 BASE_URL 覆盖）
// 用法：node scripts/verify-m3.mjs
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const DB_NAME = "cf-ai-gateway-db";
const ADMIN_EMAIL = "admin@example.com";
const MEMBER_EMAIL = "member@example.com";
const PASSWORD = "testpass123";
const INVITE_ADMIN = "M3VERIFY01";
const INVITE_MEMBER = "M3VERIFY02";
const OPENAI_PROVIDER = {
  name: "openai-mock",
  type: "openai",
  baseUrl: "http://127.0.0.1:8788/openai/v1",
  apiKey: "sk-mock-openai",
  models: {
    "gpt-4o-mini": "gpt-4o-mini",
    "text-embedding-3-small": "text-embedding-3-small",
    "error-500": "error-500",
  },
};
const ANTHROPIC_PROVIDER = {
  name: "anthropic-mock",
  type: "anthropic",
  baseUrl: "http://127.0.0.1:8788/anthropic/v1",
  apiKey: "sk-mock-anthropic",
  models: { "claude-sonnet-4-20250514": "claude-sonnet-4-20250514" },
};

let passed = 0;
let failed = 0;
let lastFailures = [];

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

// Windows 下 spawnSync 无法直接解析 npx.cmd 等 shim，改用 node 直跑 wrangler 的 JS 入口
import { fileURLToPath } from "node:url";
const WRANGLER_JS = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

function runSql(sql) {
  execFileSync(process.execPath, [WRANGLER_JS, "d1", "execute", DB_NAME, "--local", "--command", sql], {
    stdio: "pipe",
    encoding: "utf8",
  });
}

async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
  const finalHeaders = { ...headers };
  if (cookie) {
    finalHeaders.Cookie = cookie;
  }
  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }
  const res = await fetch(BASE + path, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON（SSE 等）
  }
  let cookieOut = null;
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    cookieOut = setCookies
      .map((c) => c.split(";")[0])
      .filter((c) => c.includes("="))
      .join("; ");
  }
  return { status: res.status, json, text, cookie: cookieOut };
}

function parseSse(text) {
  const events = [];
  let eventName = "message";
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        events.push({ event: eventName, done: true });
      } else {
        try {
          events.push({ event: eventName, data: JSON.parse(data) });
        } catch {
          events.push({ event: eventName, raw: data });
        }
      }
      eventName = "message";
    }
  }
  return events;
}

// Better Auth 校验 Origin（CSRF 防护）：API 调用需带与 baseURL 同源的 Origin 头
const ORIGIN = new URL(BASE).origin;

async function signup(email, inviteCode) {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: { email, password: PASSWORD, name: email.split("@")[0], inviteCode },
  });
  return res;
}

async function signin(email) {
  const res = await api("/api/auth/sign-in/email", {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: { email, password: PASSWORD },
  });
  return res;
}

async function main() {
  console.log(`\n=== M3 verify @ ${BASE} ===`);

  // ---------- 0. 准备本地 D1（幂等可重跑） ----------
  console.log("\n[setup] prepare local D1");
  // 按 FK 依赖顺序清理（D1 local 开启外键约束）：先删引用 users/api_keys 的行，再删用户
  runSql(
    `DELETE FROM invite_codes WHERE created_by IN (SELECT id FROM users WHERE email IN ('${ADMIN_EMAIL}','${MEMBER_EMAIL}'));` +
      `DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN_EMAIL}','${MEMBER_EMAIL}'));` +
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN_EMAIL}','${MEMBER_EMAIL}'));` +
      `DELETE FROM balance_tx WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN_EMAIL}','${MEMBER_EMAIL}'));` +
      `DELETE FROM request_logs WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN_EMAIL}','${MEMBER_EMAIL}'));` +
      `DELETE FROM usage_daily WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN_EMAIL}','${MEMBER_EMAIL}'));` +
      `DELETE FROM api_keys WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN_EMAIL}','${MEMBER_EMAIL}'));` +
      `DELETE FROM users WHERE email IN ('${ADMIN_EMAIL}','${MEMBER_EMAIL}');` +
      `DELETE FROM invite_codes WHERE code IN ('${INVITE_ADMIN}','${INVITE_MEMBER}');` +
      `DELETE FROM providers;`,
  );
  runSql(
    `INSERT OR IGNORE INTO users (id, email, name, role, status, balance, email_verified, created_at, updated_at) ` +
      `VALUES (1,'bootstrap@example.com','Bootstrap','admin','active',100,1,unixepoch(),unixepoch());`,
  );
  runSql(
    `INSERT OR IGNORE INTO invite_codes (code, created_by, expires_at, created_at) VALUES ` +
      `('${INVITE_ADMIN}',1,unixepoch()+86400,unixepoch()),` +
      `('${INVITE_MEMBER}',1,unixepoch()+86400,unixepoch());`,
  );

  // ---------- 1. 注册 + 登录 ----------
  console.log("\n[1] auth (email/password + invite)");
  const signupAdmin = await signup(ADMIN_EMAIL, INVITE_ADMIN);
  report("admin signup", signupAdmin.status === 200 || signupAdmin.status === 201, `status=${signupAdmin.status}`);
  runSql(`UPDATE users SET role='admin', balance=100 WHERE email='${ADMIN_EMAIL}';`);
  const signinAdmin = await signin(ADMIN_EMAIL);
  report("admin signin", signinAdmin.status === 200 && signinAdmin.cookie !== null, `status=${signinAdmin.status}`);
  const adminCookie = signinAdmin.cookie;

  // ---------- 2. 管理面：providers CRUD（含 mask 与 AES-GCM 加密） ----------
  console.log("\n[2] providers CRUD (admin)");
  const authApi = { cookie: adminCookie };
  const createOpenai = await api("/api/providers", { method: "POST", ...authApi, body: OPENAI_PROVIDER });
  report("create openai provider", createOpenai.status === 200 && createOpenai.json?.provider?.apiKeyMasked?.startsWith("sk-"), `status=${createOpenai.status}`);
  const createAnthropic = await api("/api/providers", { method: "POST", ...authApi, body: ANTHROPIC_PROVIDER });
  report("create anthropic provider", createAnthropic.status === 200, `status=${createAnthropic.status}`);

  const listProviders = await api("/api/providers", authApi);
  const providerList = listProviders.json?.items ?? [];
  report("list providers (2, masked)", listProviders.status === 200 && providerList.length === 2 && providerList.every((p) => p.apiKeyMasked.includes("****")), `status=${listProviders.status}`);
  const openaiProviderId = providerList.find((p) => p.type === "openai")?.id;

  const updateProvider = await api(`/api/providers/${openaiProviderId}`, {
    method: "PATCH",
    ...authApi,
    body: { name: "openai-mock-renamed" },
  });
  report("update provider", updateProvider.status === 200 && updateProvider.json?.provider?.name === "openai-mock-renamed", `status=${updateProvider.status}`);

  const memberDenied = await api("/api/providers", { cookie: null, headers: {} });
  report("providers require session (401)", memberDenied.status === 401, `status=${memberDenied.status}`);

  // ---------- 3. 网关 API Key 创建 ----------
  console.log("\n[3] gateway API key create");
  const createKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "m3-test-key" } });
  const plaintext = createKey.json?.plaintext ?? "";
  report("create key returns plaintext once", createKey.status === 200 && plaintext.startsWith("sk-") && plaintext.length > 10, `status=${createKey.status}`);
  const keyId = createKey.json?.key?.id;

  const listKeys = await api("/api/keys", authApi);
  report("list keys (masked prefix)", listKeys.status === 200 && (listKeys.json?.items ?? []).some((k) => k.id === keyId && k.prefix.includes("****")), `status=${listKeys.status}`);

  const proxyAuth = { Authorization: `Bearer ${plaintext}` };

  // ---------- 4. 代理面：models + OpenAI 非流式/流式 ----------
  console.log("\n[4] proxy /v1 (openai)");
  const models = await api("/v1/models", { headers: proxyAuth });
  const modelIds = (models.json?.data ?? []).map((m) => m.id);
  report("GET /v1/models lists configured models", models.status === 200 && ["gpt-4o-mini", "text-embedding-3-small", "claude-sonnet-4-20250514"].every((m) => modelIds.includes(m)), `status=${models.status} ids=${modelIds.join(",")}`);

  const chat = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
  });
  report("chat non-stream", chat.status === 200 && chat.json?.choices?.[0]?.message?.content?.includes("Hello from OpenAI mock"), `status=${chat.status}`);

  const chatStream = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true },
  });
  const chatStreamEvents = parseSse(chatStream.text);
  const hasDone = chatStreamEvents.some((e) => e.done);
  const hasUsage = chatStreamEvents.some((e) => e.data?.usage?.prompt_tokens === 10);
  report("chat stream (SSE passthrough + usage + [DONE])", chatStream.status === 200 && hasDone && hasUsage, `status=${chatStream.status} events=${chatStreamEvents.length}`);

  const completions = await api("/v1/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "gpt-4o-mini", prompt: "hello" },
  });
  report("completions", completions.status === 200 && (completions.json?.choices?.[0]?.text ?? "").includes("Hello from OpenAI completions mock"), `status=${completions.status}`);

  const embeddings = await api("/v1/embeddings", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "text-embedding-3-small", input: "hello" },
  });
  report("embeddings", embeddings.status === 200 && (embeddings.json?.data ?? []).length === 1, `status=${embeddings.status}`);

  // ---------- 5. 代理面：Anthropic 转换 ----------
  console.log("\n[5] proxy /v1 (anthropic conversion)");
  const anthropicChat = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 2048,
    },
  });
  const anthropicContent = anthropicChat.json?.choices?.[0]?.message?.content ?? "";
  report("anthropic non-stream converted", anthropicChat.status === 200 && anthropicContent.includes("Hello from Anthropic mock") && anthropicContent.includes("system=You are helpful") && anthropicContent.includes("max_tokens=2048"), `status=${anthropicChat.status}`);
  const anthropicUsage = anthropicChat.json?.usage;
  report("anthropic usage mapped", anthropicChat.status === 200 && anthropicUsage?.prompt_tokens === 25 && anthropicUsage?.completion_tokens === 15, `status=${anthropicChat.status}`);

  const anthropicStream = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
  });
  const anthropicEvents = parseSse(anthropicStream.text);
  const firstDelta = anthropicEvents[0]?.data;
  const contentDeltas = anthropicEvents.filter((e) => e.data?.choices?.[0]?.delta?.content).map((e) => e.data.choices[0].delta.content).join("");
  const finishChunk = anthropicEvents.find((e) => e.data?.choices?.[0]?.finish_reason !== undefined && e.data?.choices?.[0]?.finish_reason !== null);
  const usageTail = anthropicEvents.find((e) => e.data?.usage);
  report("anthropic stream: message_start → role delta", anthropicStream.status === 200 && firstDelta?.choices?.[0]?.delta?.role === "assistant", `status=${anthropicStream.status}`);
  report("anthropic stream: content deltas joined", contentDeltas === "Hello from Anthropic mock (streamed)", `content="${contentDeltas}"`);
  report("anthropic stream: finish_reason=stop", finishChunk?.data?.choices?.[0]?.finish_reason === "stop", JSON.stringify(finishChunk?.data?.choices?.[0]));
  report("anthropic stream: usage tail (25/15) + [DONE]", usageTail?.data?.usage?.prompt_tokens === 25 && usageTail?.data?.usage?.completion_tokens === 15 && anthropicEvents.some((e) => e.done), JSON.stringify(usageTail?.data?.usage));

  const anthropicTools = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "weather in Beijing?" }],
      stream: true,
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
        },
      ],
    },
  });
  const toolEvents = parseSse(anthropicTools.text);
  const toolStart = toolEvents.find((e) => e.data?.choices?.[0]?.delta?.tool_calls);
  const toolArgs = toolEvents.filter((e) => e.data?.choices?.[0]?.delta?.tool_calls?.some((tc) => tc.function?.arguments)).map((e) => e.data.choices[0].delta.tool_calls.map((tc) => tc.function.arguments).join("")).join("");
  const toolFinish = toolEvents.find((e) => e.data?.choices?.[0]?.finish_reason === "tool_calls");
  report("anthropic tools stream: tool_calls delta (name)", toolStart?.data?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "get_weather", JSON.stringify(toolStart?.data?.choices?.[0]?.delta?.tool_calls));
  report("anthropic tools stream: arguments joined + finish=tool_calls", toolArgs === '{"city": "Beijing"}' && toolFinish !== undefined, `args="${toolArgs}"`);

  // ---------- 6. 错误映射 ----------
  console.log("\n[6] error mapping");
  const invalidKey = await api("/v1/models", { headers: { Authorization: "Bearer sk-invalidkey000000000000000000000000" } });
  report("invalid key → 401 {error.message}", invalidKey.status === 401 && invalidKey.json?.error?.message === "Invalid API key", `status=${invalidKey.status}`);
  const noAuth = await api("/v1/models", {});
  report("missing key → 401", noAuth.status === 401, `status=${noAuth.status}`);
  const notRouted = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "no-such-model", messages: [{ role: "user", content: "hi" }] },
  });
  report("model not routed → 404", notRouted.status === 404 && notRouted.json?.error?.message?.includes("no-such-model"), `status=${notRouted.status}`);
  const upstream500 = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "error-500", messages: [{ role: "user", content: "hi" }] },
  });
  report("upstream 5xx passthrough (500 + message)", upstream500.status === 500 && upstream500.json?.error?.message?.includes("Mock upstream simulated failure"), `status=${upstream500.status}`);
  const anthropicCompletions = await api("/v1/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "claude-sonnet-4-20250514", prompt: "hi" },
  });
  report("anthropic + /v1/completions → 400", anthropicCompletions.status === 400 && anthropicCompletions.json?.error?.message?.includes("does not support"), `status=${anthropicCompletions.status}`);
  const invalidBody = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "gpt-4o-mini" },
  });
  report("invalid body → 400", invalidBody.status === 400 && invalidBody.json?.error?.message?.includes("Validation failed"), `status=${invalidBody.status}`);

  // ---------- 7. 限流 429（qpsLimit=2） ----------
  console.log("\n[7] rate limit (qpsLimit=2)");
  const createLimitedKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "limited", qpsLimit: 2 } });
  const limitedKey = createLimitedKey.json?.plaintext ?? "";
  const limitedAuth = { Authorization: `Bearer ${limitedKey}` };
  const statuses = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await api("/v1/chat/completions", {
      method: "POST",
      headers: limitedAuth,
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: `n${i}` }] },
    });
    statuses.push(r.status);
  }
  report("3 calls with limit 2 → [200,200,429]", statuses[0] === 200 && statuses[1] === 200 && statuses[2] === 429, statuses.join(","));

  // ---------- 8. 余额不足 402（member 余额 0） ----------
  console.log("\n[8] insufficient balance → 402");
  const signupMember = await signup(MEMBER_EMAIL, INVITE_MEMBER);
  report("member signup", signupMember.status === 200 || signupMember.status === 201, `status=${signupMember.status}`);
  const signinMember = await signin(MEMBER_EMAIL);
  const memberCookie = signinMember.cookie;
  const createMemberKey = await api("/api/keys", { method: "POST", cookie: memberCookie, body: { name: "member-key" } });
  const memberKey = createMemberKey.json?.plaintext ?? "";
  const balanceRes = await api("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${memberKey}` },
    body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
  });
  report("zero balance → 402 {error.message}", balanceRes.status === 402 && balanceRes.json?.error?.message?.includes("Insufficient balance"), `status=${balanceRes.status}`);

  // ---------- 9. revoke 后 401 ----------
  console.log("\n[9] revoke key → 401");
  const revoke = await api(`/api/keys/${keyId}/revoke`, { method: "POST", ...authApi });
  report("revoke api key", revoke.status === 200 && revoke.json?.key?.status === "revoked", `status=${revoke.status}`);
  const revokedCall = await api("/v1/models", { headers: proxyAuth });
  report("revoked key → 401", revokedCall.status === 401 && revokedCall.json?.error?.message?.includes("revoked"), `status=${revokedCall.status}`);

  // ---------- 10. provider 停用/删除 ----------
  console.log("\n[10] provider disable/delete");
  const disable = await api(`/api/providers/${openaiProviderId}`, { method: "PATCH", ...authApi, body: { enabled: false } });
  const modelsAfterDisable = await api("/v1/models", { headers: proxyAuth });
  const idsAfter = (modelsAfterDisable.json?.data ?? []).map((m) => m.id);
  report("disable provider removes model from /v1/models", disable.status === 200 && !idsAfter.includes("gpt-4o-mini"), `status=${disable.status}`);
  const del = await api(`/api/providers/${openaiProviderId}`, { method: "DELETE", ...authApi });
  report("delete provider", del.status === 200, `status=${del.status}`);

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
