// /v1/messages 双协议自动感知 E2E（08-31-protocol-auto-detect，design §10）：
// 真实 HTTP 链路（npm run dev + scripts/mock-upstream.mjs :8788 + 本地 D1 + BILLING_QUEUE 消费者）。
// 场景：anthropic 体（claude-* 模型名兜底 + max_tokens）→ Anthropic 响应 + 结算；
//        openai 体（gpt-* 模型名兜底）→ OpenAI 响应 + 结算；两协议各一非流式 + 流式；冲突 400 Anthropic 形态；
//        缺 max_tokens + claude-* → 400；gpt-* 无 max_tokens → 200；request_logs 落 provider 正确。
// 用法：node scripts/mock-upstream.mjs & npm run dev（另一终端）; node scripts/verify-proto.mjs
// 前置：本地 D1 已迁移（npm run db:migrate -- --local）+ seed 价格表（npm run db:seed -- --local）
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const INVITE_ADMIN = "PROTOVERIFY";
const ADMIN_EMAIL = "proto-admin@example.com";
const PASSWORD = "testpass123";
const OPENAI_PROVIDER = {
  name: "proto-openai-mock",
  type: "openai",
  baseUrl: "http://127.0.0.1:8788/openai/v1",
  apiKey: "sk-mock-openai",
  models: { "mock-gpt-4o": "mock-gpt-4o" },
};
const ANTHROPIC_PROVIDER = {
  name: "proto-anthropic-mock",
  type: "anthropic",
  baseUrl: "http://127.0.0.1:8788/anthropic/v1",
  apiKey: "sk-mock-anthropic",
  models: { "claude-4-proto": "claude-4-proto" },
};
// mock 上游 usage：openai 面 10+5、anthropic 面 25+15 → 价格同 verify-m4（short 档）
const INPUT_PRICE_SHORT = 0.15;
const OUTPUT_PRICE_SHORT = 0.6;
const COST_OPENAI = (10 * INPUT_PRICE_SHORT + 5 * OUTPUT_PRICE_SHORT) / 1_000_000; // 4.5e-6
const COST_ANTHROPIC = (25 * INPUT_PRICE_SHORT + 15 * OUTPUT_PRICE_SHORT) / 1_000_000; // 12.75e-6

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
    // Better Auth CSRF 检查（浏览器同源 POST 自动带；node fetch 不带 → 显式补）
    Origin: new URL(BASE).origin,
    ...(cookie ? { Cookie: cookie } : {}),
    ...headers,
  };
  // 连接级偶发错误（undici keep-alive 复用竞态 ECONNRESET）重试一次（verify-m4 同款）
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
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, inviteCode, name: email.split("@")[0] ?? "proto" },
  });
  return res;
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

async function poll(fn, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    await sleep(intervalMs);
  }
  return null;
}

async function main() {
  console.log(`\n=== protocol auto-detect verify @ ${BASE} ===`);

  // ---------- 0. 准备本地 D1（幂等可重跑） ----------
  console.log("\n[setup] prepare local D1");
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

  const p1 = await api("/api/providers", { method: "POST", ...authApi, body: OPENAI_PROVIDER });
  report("create openai provider", p1.status === 200, `status=${p1.status}`);
  const p2 = await api("/api/providers", { method: "POST", ...authApi, body: ANTHROPIC_PROVIDER });
  report("create anthropic provider", p2.status === 200, `status=${p2.status}`);

  const price1 = await api("/api/models", {
    method: "POST",
    ...authApi,
    body: { model: "mock-gpt-4o", inputPriceShort: INPUT_PRICE_SHORT, inputPriceLong: INPUT_PRICE_SHORT, inputPriceCached: 0, outputPriceShort: OUTPUT_PRICE_SHORT, outputPriceLong: OUTPUT_PRICE_SHORT },
  });
  const price2 = await api("/api/models", {
    method: "POST",
    ...authApi,
    body: { model: "claude-4-proto", inputPriceShort: INPUT_PRICE_SHORT, inputPriceLong: INPUT_PRICE_SHORT, inputPriceCached: 0, outputPriceShort: OUTPUT_PRICE_SHORT, outputPriceLong: OUTPUT_PRICE_SHORT },
  });
  report("price gpt+claude", price1.status === 200 && price2.status === 200, `status=${price1.status}/${price2.status}`);

  const createKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "proto-key" } });
  const plaintext = createKey.json?.plaintext ?? "";
  report("create gateway key", createKey.status === 200 && plaintext.startsWith("sk-"), `status=${createKey.status}`);
  const proxyAuth = { Authorization: `Bearer ${plaintext}` };
  const balanceSql = () =>
    query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
  const approx = (a, b) => Math.abs(a - b) < 1e-9;
  const successRows = () =>
    query(`SELECT status, cost, provider_id, request_id FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') AND status='success' ORDER BY id;`);

  // ---------- 2. anthropic 分支 ----------
  console.log("\n[2] anthropic branch (/v1/messages)");
  const b0 = balanceSql();
  const anthroBody = {
    model: "claude-4-proto",
    max_tokens: 64,
    messages: [{ role: "user", content: "PROTO-ANTHRO" }],
  };
  const anthroRes = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: anthroBody,
  });
  const anthroJson = anthroRes.json ?? {};
  report(
    "non-stream anthropic body → Anthropic response",
    anthroRes.status === 200 && anthroJson.type === "message" &&
      Array.isArray(anthroJson.content) && anthroJson.content[0]?.type === "text" &&
      String(anthroJson.content[0]?.text ?? "").includes("Anthropic mock"),
    `status=${anthroRes.status} type=${anthroJson.type} content0=${JSON.stringify(anthroJson.content?.[0]?.text ?? null)}`,
  );

  const anthroSettled = await poll(async () => {
    const rows = successRows();
    const balance = balanceSql();
    if (rows.length >= 1 && approx(balance, b0 - COST_ANTHROPIC)) {
      return { rows, balance };
    }
    return null;
  }, 120000);
  report("anthropic settled: success log + cost=12.75e-6", anthroSettled !== null, JSON.stringify(anthroSettled ?? null));
  report(
    "anthropic log lands on anthropic provider",
    anthroSettled !== null && anthroSettled.rows[0]?.provider_id === p2.json?.provider?.id,
    `provider_id=${anthroSettled?.rows?.[0]?.provider_id ?? null} expect=${p2.json?.provider?.id ?? "?"}`,
  );

  const anthroStream = await api("/v1/messages", {
    method: "POST",
    headers: { ...proxyAuth, "Content-Type": "application/json" },
    body: { ...anthroBody, stream: true, messages: [{ role: "user", content: "PROTO-ANTHRO-STREAM" }] },
  });
  const anthroEvents = parseSse(anthroStream.text);
  report(
    "stream anthropic body → SSE with text deltas",
    anthroStream.status === 200 &&
      anthroStream.headers.get("Content-Type")?.includes("text/event-stream") &&
      anthroEvents.some((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta") &&
      anthroEvents.some((e) => e.type === "message_stop"),
    `status=${anthroStream.status} events=${anthroEvents.length}`,
  );

  // ---------- 3. openai 分支 ----------
  console.log("\n[3] openai branch (/v1/messages)");
  const b1 = balanceSql();
  const openaiRes = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "mock-gpt-4o",
      messages: [{ role: "user", content: "PROTO-OPENAI" }],
    },
  });
  const openaiJson = openaiRes.json ?? {};
  report(
    "non-stream openai body → OpenAI response",
    openaiRes.status === 200 && openaiJson.object === "chat.completion" &&
      openaiJson.choices?.[0]?.message?.content?.includes("OpenAI mock"),
    `status=${openaiRes.status} object=${openaiJson.object} content=${JSON.stringify(openaiJson.choices?.[0]?.message?.content ?? null)}`,
  );

  const openaiSettled = await poll(async () => {
    const rows = successRows();
    const balance = balanceSql();
    // 延迟计费队列近似 FIFO 但批处理可能乱序 → 不用行索引/精确余额，判据放宽为
    // 「≥3 笔（anthro-ns + anthro-stream + openai-ns）已 settle 且余额确实下降」
    if (rows.length >= 3 && balance !== null && balance < b1) {
      return { rows, balance };
    }
    return null;
  }, 120000);
  report("openai settled: success log + balance decreased", openaiSettled !== null, JSON.stringify(openaiSettled ?? null));
  const openaiRows = openaiSettled?.rows.filter((r) => r.provider_id === p1.json?.provider?.id) ?? [];
  report(
    "openai log lands on openai provider",
    openaiRows.length >= 1,
    `openai-provider rows=${openaiRows.length} expect=${p1.json?.provider?.id ?? "?"}`,
  );

  const openaiStream = await api("/v1/messages", {
    method: "POST",
    headers: { ...proxyAuth, "Content-Type": "application/json" },
    body: { model: "mock-gpt-4o", stream: true, messages: [{ role: "user", content: "PROTO-OPENAI-STREAM" }] },
  });
  const openaiEvents = parseSse(openaiStream.text);
  report(
    "stream openai body → SSE + [DONE]",
    openaiStream.status === 200 &&
      openaiStream.headers.get("Content-Type")?.includes("text/event-stream") &&
      openaiStream.text.includes("[DONE]") &&
      openaiEvents.some((e) => e.object === "chat.completion.chunk" && e.choices?.[0]?.delta?.content),
    `status=${openaiStream.status} events=${openaiEvents.length}`,
  );

  // ---------- 4. 错误形态与冲突 ----------
  console.log("\n[4] error shapes & conflicts");
  const conflict = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "mock-gpt-4o", system: "sys", n: 2, messages: [{ role: "user", content: "x" }] },
  });
  report(
    "conflict (system + n) → 400 Anthropic shape",
    conflict.status === 400 && conflict.json?.type === "error" &&
      conflict.json?.error?.message?.includes("mixes OpenAI and Anthropic"),
    `status=${conflict.status} body=${JSON.stringify(conflict.json)}`,
  );

  const noMaxTokens = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "claude-4-proto", messages: [{ role: "user", content: "x" }] },
  });
  report(
    "claude-* without max_tokens → 400 invalid_request_error",
    noMaxTokens.status === 400 && noMaxTokens.json?.type === "error" &&
      noMaxTokens.json?.error?.type === "invalid_request_error" &&
      String(noMaxTokens.json?.error?.message ?? "").includes("max_tokens"),
    `status=${noMaxTokens.status} body=${JSON.stringify(noMaxTokens.json)}`,
  );

  const noMaxTokensGpt = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "mock-gpt-4o", messages: [{ role: "user", content: "ok-without-max" }] },
  });
  report(
    "gpt-* without max_tokens → 200 (OpenAI semantics)",
    noMaxTokensGpt.status === 200 && noMaxTokensGpt.json?.object === "chat.completion",
    `status=${noMaxTokensGpt.status}`,
  );

  const badKey = await api("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-invalid-proto" },
    body: { model: "claude-4-proto", max_tokens: 64, messages: [{ role: "user", content: "x" }] },
  });
  report(
    "401 + anthropic body → Anthropic shape (zero-regression)",
    badKey.status === 401 && badKey.json?.type === "error" &&
      badKey.json?.error?.type === "authentication_error",
    `status=${badKey.status} body=${JSON.stringify(badKey.json)}`,
  );

  // ---------- 5. 终局 ----------
  console.log("\n[5] final tally");
  const finalRows = successRows();
  report(
    "request_logs: 5 success rows (2 anthropic + 2 openai + 1 gpt-no-max_tokens)",
    finalRows.length === 5,
    `rows=${finalRows.length}`,
  );

  console.log(`\n=== protocol auto-detect verify: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("\nFailed checks:");
    for (const failure of lastFailures) {
      console.log(`  - ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("verify-proto crashed:", error);
  process.exitCode = 1;
});
