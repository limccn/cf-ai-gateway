// 编码 Agent 思考深度适配 E2E（09-01-coding-agent-reasoning-support 批次）：
// 真实 HTTP 链路（npm run dev + scripts/mock-upstream.mjs :8788 + 本地 D1 + BILLING_QUEUE 消费者）。
// 场景：
//   R1  /v1/messages anthropic 入站带 thinking → mock 上游收到 → 触发 thinking 流（P2a 直通）
//   R2+R3a  /v1/chat/completions + reasoning_effort=high（anthropic 上游）→ 映射 output_config →
//            mock 触发 thinking 流 → 网关转出 delta.reasoning_content（一条链路双验证）
//   R4  /v1/responses + include:["reasoning.summary_text"] + stream → reasoning 事件序列
//   R4  不带 include → 无 reasoning 事件（缺省零回归）
// 用法：node scripts/mock-upstream.mjs & npm run dev（另一终端）; node scripts/verify-thinking.mjs
// 前置：本地 D1 已迁移（npm run db:migrate -- --local）+ seed 价格表（npm run db:seed -- --local）
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const INVITE_ADMIN = "THINKVERIFY";
const ADMIN_EMAIL = "think-admin@example.com";
const PASSWORD = "testpass123";
const ANTHROPIC_PROVIDER = {
  name: "think-anthropic-mock",
  type: "anthropic",
  baseUrl: "http://127.0.0.1:8788/anthropic/v1",
  apiKey: "sk-mock-anthropic",
  // 模型名含 "thinking" → mock 上游发 thinking 流（R3a 触发条件）
  models: { "claude-4-think": "claude-4-think" },
};
const OPENAI_PROVIDER = {
  name: "think-openai-mock",
  type: "openai",
  baseUrl: "http://127.0.0.1:8788/openai/v1",
  apiKey: "sk-mock-openai",
  // 模型名含 "reasoning" → mock 上游发 reasoning_content 流（R4 触发条件）
  models: { "gpt-reasoning-4o": "gpt-reasoning-4o" },
};
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

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
  // 连接级偶发错误（undici keep-alive 复用竞态 ECONNRESET）重试一次（verify-proto 同款）
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
    body: { email, password: PASSWORD, inviteCode, name: email.split("@")[0] ?? "think" },
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
  console.log(`\n=== coding-agent reasoning verify @ ${BASE} ===`);

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

  const p1 = await api("/api/providers", { method: "POST", ...authApi, body: ANTHROPIC_PROVIDER });
  report("create anthropic provider", p1.status === 200, `status=${p1.status}`);
  const p2 = await api("/api/providers", { method: "POST", ...authApi, body: OPENAI_PROVIDER });
  report("create openai provider", p2.status === 200, `status=${p2.status}`);

  for (const model of ["claude-4-think", "gpt-reasoning-4o"]) {
    const price = await api("/api/models", {
      method: "POST",
      ...authApi,
      body: { model, inputPriceShort: INPUT_PRICE, inputPriceLong: INPUT_PRICE, inputPriceCached: 0, outputPriceShort: OUTPUT_PRICE, outputPriceLong: OUTPUT_PRICE },
    });
    report(`price ${model}`, price.status === 200, `status=${price.status}`);
  }

  const createKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "think-key" } });
  const plaintext = createKey.json?.plaintext ?? "";
  report("create gateway key", createKey.status === 200 && plaintext.startsWith("sk-"), `status=${createKey.status}`);
  const proxyAuth = { Authorization: `Bearer ${plaintext}` };

  // ---------- 2. R1：anthropic 入站 thinking 逐字透传 ----------
  console.log("\n[2] R1 anthropic inbound thinking passthrough");
  const r1 = await api("/v1/messages", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "claude-4-think",
      max_tokens: 64,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "THINK-PASSTHROUGH" }],
      stream: true,
    },
  });
  const r1Events = parseSse(r1.text);
  const thinkingDeltas = r1Events.filter(
    (e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta",
  );
  report(
    "thinking 参数逐字到上游 → mock 触发 thinking 流（P2a 直通，客户端收 thinking_delta）",
    r1.status === 200 &&
      thinkingDeltas.length >= 1 &&
      String(thinkingDeltas[0]?.delta?.thinking ?? "").includes("Let me reason"),
    `status=${r1.status} thinkingDeltas=${thinkingDeltas.length}`,
  );

  // ---------- 3. R2+R3a：reasoning_effort → output_config 映射 → thinking 流 → reasoning_content ----------
  console.log("\n[3] R2 effort mapping + R3a thinking→reasoning_content");
  const b0 = query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
  const r23 = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "claude-4-think",
      reasoning_effort: "high",
      temperature: 0.7,
      max_tokens: 64,
      messages: [{ role: "user", content: "REASON-EFFORT" }],
      stream: true,
    },
  });
  const r23Events = parseSse(r23.text);
  const reasoningDeltas = r23Events.filter(
    (e) => e.choices?.[0]?.delta?.reasoning_content !== undefined,
  );
  report(
    "reasoning_effort=high → R2 映射（mock 收到 thinking → 发 thinking 流）→ R3a 转出 delta.reasoning_content",
    r23.status === 200 &&
      reasoningDeltas.length >= 1 &&
      reasoningDeltas.map((e) => e.choices[0].delta.reasoning_content).join("").includes("Let me reason about the plan"),
    `status=${r23.status} reasoningDeltas=${reasoningDeltas.length}`,
  );
  // 结算顺带验证（R2+R3a 链路：mock usage 10+5 → 4.5e-6）
  const settled = await poll(async () => {
    const rows = query(`SELECT status FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') AND status='success' ORDER BY id;`);
    const balance = query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
    if (rows.length >= 1 && balance !== null && balance < b0) {
      return { balance };
    }
    return null;
  }, 120000);
  report("R2+R3a 链路延迟计费落账", settled !== null, JSON.stringify(settled ?? null));

  // ---------- 4. R4：/v1/responses include → reasoning 事件序列 ----------
  console.log("\n[4] R4 responses include reasoning");
  const r4 = await api("/v1/responses", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "gpt-reasoning-4o",
      input: "REASONING-VIS",
      stream: true,
      include: ["reasoning.summary_text"],
    },
  });
  const r4Events = parseSse(r4.text);
  const r4Deltas = r4Events.filter((e) => e.type === "response.reasoning_summary_text.delta");
  const r4ReasoningDone = r4Events.some(
    (e) => e.type === "response.output_item.done" && e.item?.type === "reasoning",
  );
  report(
    "include: reasoning.summary_text → reasoning_summary_text.delta×2 + output_item.done(reasoning)",
    r4.status === 200 &&
      r4Deltas.length === 2 &&
      r4Deltas.map((e) => e.delta).join("").includes("Let me reason about the plan") &&
      r4ReasoningDone,
    `status=${r4.status} deltas=${r4Deltas.length} reasoningDone=${r4ReasoningDone}`,
  );

  // ---------- 5. R4 缺省零回归：不带 include → 无 reasoning 事件 ----------
  console.log("\n[5] R4 default zero-regression");
  const r4plain = await api("/v1/responses", {
    method: "POST",
    headers: proxyAuth,
    body: {
      model: "gpt-reasoning-4o",
      input: "REASONING-VIS-PLAIN",
      stream: true,
    },
  });
  const r4plainEvents = parseSse(r4plain.text);
  const r4plainReasoning = r4plainEvents.filter((e) => e.type?.includes("reasoning"));
  report(
    "不带 include → 无 reasoning 事件（mock 仍发 reasoning_content，网关按 include 过滤）",
    r4plain.status === 200 &&
      r4plainReasoning.length === 0 &&
      r4plainEvents.some((e) => e.type === "response.completed"),
    `status=${r4plain.status} reasoningEvents=${r4plainReasoning.length}`,
  );

  // ---------- 6. 终局 ----------
  console.log("\n[6] final tally");
  const finalRows = query(`SELECT count(*) AS n FROM request_logs WHERE status='success';`);
  report(
    "request_logs: ≥3 success rows（R1 + R2R3 + R4 + R4plain 均已落账）",
    (finalRows[0]?.n ?? 0) >= 3,
    `rows=${finalRows[0]?.n ?? 0}`,
  );

  console.log(`\n=== coding-agent reasoning verify: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("\nFailed checks:");
    for (const failure of lastFailures) {
      console.log(`  - ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("verify-thinking crashed:", error);
  process.exitCode = 1;
});
