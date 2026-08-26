// M4 端到端验证脚本（本地 dev + mock 上游）：计费 + 限流 + 缓存。
// 覆盖（PRD 4.1-4.6）：
//   4.1 价格表 admin CRUD（/api/models）+ 非流式条件 UPDATE 原子扣费 + balance_tx usage 流水
//   4.2 流式 SSE 尾包 usage 结算
//   4.3 失败语义：上游 500 不扣费，request_logs 记 error
//   4.4 限流：KV 固定窗口计数器，qpsLimit 可配置，超限 429
//   4.5 缓存：命中直接返回（不转发、不扣费），明细记 cached
//   4.6 admin 余额调整 API（/api/users/:id/balance，±）
// 前置：
//   - `node scripts/mock-upstream.mjs` 已启动（8788）
//   - `npm run dev` 已启动（http://localhost:5173，可 BASE_URL 覆盖）
// 用法：node scripts/verify-m4.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const DB_NAME = "cf-ai-gateway-db";
const ADMIN_EMAIL = "admin@example.com";
const MEMBER_EMAIL = "member@example.com";
const PASSWORD = "testpass123";
const INVITE_ADMIN = "M4VERIFY01";
const INVITE_MEMBER = "M4VERIFY02";
const OPENAI_PROVIDER = {
  name: "openai-mock",
  type: "openai",
  baseUrl: "http://127.0.0.1:8788/openai/v1",
  apiKey: "sk-mock-openai",
  models: {
    "gpt-4o-mini": "gpt-4o-mini",
    "error-500": "error-500",
  },
};

// gpt-4o-mini 价格（POST /api/models 写入）：short/long/cached 输入 + short/long 输出 USD/1e6
// 非流式/流式 mock usage = 10 prompt + 5 completion（无缓存命中）→ short 档：
//   cost = 10*0.15/1e6 + 5*0.6/1e6 = 4.5e-6
const INPUT_PRICE_SHORT = 0.15;
const INPUT_PRICE_LONG = 0.15;
const INPUT_PRICE_CACHED = 0.0375;
const OUTPUT_PRICE_SHORT = 0.6;
const OUTPUT_PRICE_LONG = 0.6;
const CHAT_COST = (10 * INPUT_PRICE_SHORT + 5 * OUTPUT_PRICE_SHORT) / 1_000_000;

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

// Windows 下 spawnSync 无法直接解析 npx.cmd 等 shim，改用 node 直跑 wrangler 的 JS 入口
const WRANGLER_JS = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

/** 写/清理 SQL（无需返回）。 */
function runSql(sql) {
  execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", DB_NAME, "--local", "--command", sql],
    { stdio: "pipe", encoding: "utf8" },
  );
}

/** 读 SQL（--json），返回 results 行数组。 */
function query(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", DB_NAME, "--local", "--command", sql, "--json"],
    { stdio: "pipe", encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
  const finalHeaders = { ...headers };
  if (cookie) {
    finalHeaders.Cookie = cookie;
  }
  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }
  // 连接级偶发错误（undici keep-alive 复用竞态 ECONNRESET）重试一次
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
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        events.push({ done: true });
      } else {
        try {
          events.push({ data: JSON.parse(data) });
        } catch {
          events.push({ raw: data });
        }
      }
    }
  }
  return events;
}

// Better Auth 校验 Origin（CSRF 防护）：API 调用需带与 baseURL 同源的 Origin 头
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
  console.log(`\n=== M4 verify @ ${BASE} ===`);

  // ---------- 0. 准备本地 D1（幂等可重跑） ----------
  console.log("\n[setup] prepare local D1");
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
      `DELETE FROM providers;` +
      `DELETE FROM models;`,
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
  runSql(`UPDATE users SET role='admin', balance=0 WHERE email='${ADMIN_EMAIL}';`);
  const signinAdmin = await signin(ADMIN_EMAIL);
  report("admin signin", signinAdmin.status === 200 && signinAdmin.cookie !== null, `status=${signinAdmin.status}`);
  const adminCookie = signinAdmin.cookie;
  const signupMember = await signup(MEMBER_EMAIL, INVITE_MEMBER);
  report("member signup", signupMember.status === 200 || signupMember.status === 201, `status=${signupMember.status}`);
  const signinMember = await signin(MEMBER_EMAIL);
  const memberCookie = signinMember.cookie;

  const authApi = { cookie: adminCookie };

  // 取 admin 用户 id（响应中 id 为字符串）
  const userList = await api("/api/users", authApi);
  const adminUserId = (userList.json?.items ?? []).find((u) => u.email === ADMIN_EMAIL)?.id;
  report("locate admin user id", adminUserId !== undefined, `id=${adminUserId}`);

  // ---------- 2. 价格表 admin CRUD（4.1） ----------
  console.log("\n[2] price table CRUD (/api/models, admin)");
  const createPrice = await api("/api/models", { method: "POST", ...authApi, body: { model: "gpt-4o-mini", inputPriceShort: INPUT_PRICE_SHORT, inputPriceLong: INPUT_PRICE_LONG, inputPriceCached: INPUT_PRICE_CACHED, outputPriceShort: OUTPUT_PRICE_SHORT, outputPriceLong: OUTPUT_PRICE_LONG } });
  const priceModelId = createPrice.json?.model?.id;
  report("create model price", createPrice.status === 200 && createPrice.json?.model?.model === "gpt-4o-mini" && createPrice.json?.model?.inputPriceShort === INPUT_PRICE_SHORT, `status=${createPrice.status}`);

  const dupPrice = await api("/api/models", { method: "POST", ...authApi, body: { model: "gpt-4o-mini", inputPriceShort: 1, inputPriceLong: 1, inputPriceCached: 0.1, outputPriceShort: 1, outputPriceLong: 1 } });
  report("duplicate model price → 409", dupPrice.status === 409, `status=${dupPrice.status}`);

  const createTmp = await api("/api/models", { method: "POST", ...authApi, body: { model: "tmp-custom", inputPriceShort: 1.5, inputPriceLong: 1.5, inputPriceCached: 0.15, outputPriceShort: 3, outputPriceLong: 3 } });
  const tmpModelId = createTmp.json?.model?.id;
  report("create tmp price", createTmp.status === 200, `status=${createTmp.status}`);

  // PATCH 单字段（long 档）→ 验证 partial 更新 + “至少一个价格字段” refine 通过
  const updatePrice = await api(`/api/models/${tmpModelId}`, { method: "PATCH", ...authApi, body: { inputPriceLong: 2.5 } });
  report("update price (PATCH)", updatePrice.status === 200 && updatePrice.json?.model?.inputPriceLong === 2.5, `status=${updatePrice.status}`);

  const listPrices = await api("/api/models", authApi);
  report("list prices (2 items)", listPrices.status === 200 && (listPrices.json?.items ?? []).length === 2, `status=${listPrices.status}`);

  const memberCreatePrice = await api("/api/models", { method: "POST", cookie: memberCookie, body: { model: "hack", inputPriceShort: 1, inputPriceLong: 1, inputPriceCached: 0.1, outputPriceShort: 1, outputPriceLong: 1 } });
  report("member create price → 403", memberCreatePrice.status === 403, `status=${memberCreatePrice.status}`);

  const deletePrice = await api(`/api/models/${tmpModelId}`, { method: "DELETE", ...authApi });
  report("delete price (DELETE)", deletePrice.status === 200, `status=${deletePrice.status}`);
  const listAfterDelete = await api("/api/models", authApi);
  report("list after delete (1 item)", (listAfterDelete.json?.items ?? []).length === 1, `status=${listAfterDelete.status}`);

  // ---------- 3. 余额调整（4.6） ----------
  console.log("\n[3] admin balance adjust (/api/users/:id/balance)");
  const credit1 = await api(`/api/users/${adminUserId}/balance`, { method: "POST", ...authApi, body: { amount: 50, note: "M4 verify credit" } });
  report("credit +50", credit1.status === 200 && credit1.json?.balance === 50 && credit1.json?.tx?.type === "adjust" && credit1.json?.tx?.amount === 50, `status=${credit1.status} balance=${credit1.json?.balance}`);

  const credit2 = await api(`/api/users/${adminUserId}/balance`, { method: "POST", ...authApi, body: { amount: 30, note: "M4 verify credit 2" } });
  report("credit +30", credit2.status === 200 && credit2.json?.balance === 80, `balance=${credit2.json?.balance}`);

  const debit = await api(`/api/users/${adminUserId}/balance`, { method: "POST", ...authApi, body: { amount: -20, note: "M4 verify debit" } });
  report("debit -20", debit.status === 200 && debit.json?.balance === 60 && debit.json?.tx?.amount === -20, `balance=${debit.json?.balance}`);

  const memberAdjust = await api(`/api/users/${adminUserId}/balance`, { method: "POST", cookie: memberCookie, body: { amount: 100 } });
  report("member adjust → 403", memberAdjust.status === 403, `status=${memberAdjust.status}`);

  const adjustTxs = query(`SELECT amount, note FROM balance_tx WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') AND type='adjust' ORDER BY id;`);
  report("D1: 3 adjust txs, sum=60", adjustTxs.length === 3 && adjustTxs.reduce((s, r) => s + r.amount, 0) === 60, `rows=${adjustTxs.length}`);

  const balanceSql = () =>
    query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
  const approx = (a, b) => Math.abs(a - b) < 1e-9;

  // ---------- 4. 非流式扣费（4.1） ----------
  console.log("\n[4] non-stream billing (conditional UPDATE + usage tx)");
  const createProvider = await api("/api/providers", { method: "POST", ...authApi, body: OPENAI_PROVIDER });
  report("create openai provider", createProvider.status === 200, `status=${createProvider.status}`);

  const createKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "m4-key" } });
  const plaintext = createKey.json?.plaintext ?? "";
  report("create gateway key", createKey.status === 200 && plaintext.startsWith("sk-"), `status=${createKey.status}`);
  const proxyAuth = { Authorization: `Bearer ${plaintext}` };

  const chat = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
  });
  report("non-stream chat 200", chat.status === 200, `status=${chat.status}`);
  const balanceAfterChat = balanceSql();
  report("non-stream cost=4.5e-6 charged", approx(balanceAfterChat, 60 - CHAT_COST), `balance=${balanceAfterChat}`);

  const usageTx = query(
    `SELECT amount, ref_request_id FROM balance_tx WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') AND type='usage' ORDER BY id DESC LIMIT 1;`,
  );
  report("D1: usage tx amount=-4.5e-6 + ref_request_id", usageTx.length === 1 && approx(usageTx[0].amount, -CHAT_COST) && usageTx[0].ref_request_id !== null, `amount=${usageTx[0]?.amount}`);

  const successLog = query(
    `SELECT status, cost, model FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') ORDER BY id DESC LIMIT 1;`,
  );
  report("D1: request_logs success + cost", successLog.length === 1 && successLog[0].status === "success" && approx(successLog[0].cost, CHAT_COST) && successLog[0].model === "gpt-4o-mini", JSON.stringify(successLog[0]));

  // ---------- 5. 流式尾包结算（4.2） ----------
  console.log("\n[5] stream settlement (SSE usage tail)");
  const chatStream = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true },
  });
  const streamEvents = parseSse(chatStream.text);
  const usageTail = streamEvents.find((e) => e.data?.usage);
  report("stream SSE + usage tail (10/5) + [DONE]", chatStream.status === 200 && usageTail?.data?.usage?.prompt_tokens === 10 && usageTail?.data?.usage?.completion_tokens === 5 && streamEvents.some((e) => e.done), `events=${streamEvents.length}`);
  const balanceAfterStream = balanceSql();
  report("stream cost=4.5e-6 charged", approx(balanceAfterStream, 60 - 2 * CHAT_COST), `balance=${balanceAfterStream}`);

  // ---------- 6. 失败语义（4.3） ----------
  console.log("\n[6] failure semantics (upstream 500 → no charge)");
  const balanceBefore500 = balanceSql();
  const error500 = await api("/v1/chat/completions", {
    method: "POST",
    headers: proxyAuth,
    body: { model: "error-500", messages: [{ role: "user", content: "hi" }] },
  });
  report("upstream 500 passthrough", error500.status === 500 && error500.json?.error?.message?.includes("simulated"), `status=${error500.status}`);
  const balanceAfter500 = balanceSql();
  report("500 not charged", approx(balanceAfter500, balanceBefore500), `balance=${balanceAfter500}`);

  const errorLog = query(
    `SELECT status FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') AND model='error-500' ORDER BY id DESC LIMIT 1;`,
  );
  report("D1: request_logs error", errorLog.length === 1 && errorLog[0].status === "error", JSON.stringify(errorLog[0]));

  // ---------- 7. 缓存（4.5） ----------
  console.log("\n[7] response cache (hit → no charge, log cached)");
  const createCacheKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "m4-cache-key", cacheEnabled: true, cacheTtl: 3600 } });
  const cachePlaintext = createCacheKey.json?.plaintext ?? "";
  report("create cache-enabled key", createCacheKey.status === 200 && createCacheKey.json?.key?.cacheEnabled === true, `status=${createCacheKey.status}`);
  const cacheAuth = { Authorization: `Bearer ${cachePlaintext}` };

  const cacheBody = { model: "gpt-4o-mini", messages: [{ role: "user", content: "cache me" }] };
  const cacheMiss = await api("/v1/chat/completions", { method: "POST", headers: cacheAuth, body: cacheBody });
  report("cache miss → 200", cacheMiss.status === 200 && cacheMiss.json?.choices?.[0]?.message?.content?.includes("Hello from OpenAI mock"), `status=${cacheMiss.status}`);
  const balanceAfterCacheMiss = balanceSql();
  report("cache miss charged (4.5e-6)", approx(balanceAfterCacheMiss, 60 - 3 * CHAT_COST), `balance=${balanceAfterCacheMiss}`);

  await sleep(1000); // 等待 waitUntil 缓存写完成

  const balanceBeforeCacheHit = balanceSql();
  const cacheHit = await api("/v1/chat/completions", { method: "POST", headers: cacheAuth, body: cacheBody });
  report("cache hit → 200 (same content)", cacheHit.status === 200 && cacheHit.json?.choices?.[0]?.message?.content === cacheMiss.json?.choices?.[0]?.message?.content, `status=${cacheHit.status}`);
  const balanceAfterCacheHit = balanceSql();
  report("cache hit not charged", approx(balanceAfterCacheHit, balanceBeforeCacheHit), `balance=${balanceAfterCacheHit}`);

  const cachedLog = query(
    `SELECT status FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') ORDER BY id DESC LIMIT 1;`,
  );
  report("D1: request_logs cached", cachedLog.length === 1 && cachedLog[0].status === "cached", JSON.stringify(cachedLog[0]));

  // ---------- 8. 限流（4.4） ----------
  console.log("\n[8] rate limit (KV fixed window, qpsLimit=2)");
  const createLimitedKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "m4-limited", qpsLimit: 2 } });
  const limitedKey = createLimitedKey.json?.plaintext ?? "";
  report("create key qpsLimit=2", createLimitedKey.status === 200 && createLimitedKey.json?.key?.qpsLimit === 2, `status=${createLimitedKey.status}`);
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
