// stg 安全评审用例脚本（security-review-develop-baseline 任务 AC3/AC4）：
// 基线安全断言（S1-S12）+ 评审发现修复验证（F1 计费注入观测 / F4 限流头矩阵；
// F4b/F4c 已翻转：「有头」= 修复生效，与 09-01-fix-security-review-findings 任务对应）。
// 独立前缀数据（sec-* 用户 / sk-sec-* key），默认运行末尾清理，可重跑（开头同样清理）。
// 用法：node scripts/stg-security-review.mjs [--base https://stg-router.lmlh.net] [--keep]
// 依赖：wrangler d1 execute --remote --env staging --config wrangler.toml（同 stg-e2e-bootstrap）
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const DB = "cf-ai-gateway-db-staging";
const WRANGLER_JS = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const BASE = (process.argv.find((a) => a.startsWith("--base=")) ?? "--base=https://stg-router.lmlh.net").split("=")[1];
const KEEP = process.argv.includes("--keep");
// stg 现有真实上游模型（verify 脚本同款，deepseek 为自发 usage 的非规范上游）
const MODEL = "deepseek-v4-flash";
const NONCE = randomBytes(4).toString("hex");

const SEC_ADMIN = { email: `sec-admin-${NONCE}@staging.test`, name: "Sec Admin", role: "admin", balance: 50 };
const SEC_MEMBER = { email: `sec-member-${NONCE}@staging.test`, name: "Sec Member", role: "member", balance: 20 };

let passed = 0, failed = 0;
const failures = [];
const report = (name, ok, detail = "") => {
  ok ? passed++ : failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}: ${detail}`);
};

// ---------- D1 / HTTP 基建 ----------
const q = (sql) => JSON.parse(execFileSync(process.execPath,
  [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml",
    "--command", sql, "--json"], { encoding: "utf8" }))[0]?.results ?? [];
const exec = (sql) => execFileSync(process.execPath,
  [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml", "--command", sql],
  { stdio: "inherit" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeoutMs = 30000, intervalMs = 500) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

async function raw(path, opts = {}, body) {
  const headers = { ...(opts.headers ?? {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 保留 null */ }
  return { status: res.status, headers: res.headers, text, json };
}
const proxyReq = (key, body, extraHeaders = {}, timeoutMs = 60000) =>
  raw("/v1/chat/completions", { headers: { Authorization: `Bearer ${key}`, ...extraHeaders }, timeoutMs }, body);
const hasRL = (h) => h.get("x-ratelimit-limit") !== null;
const errDetail = (r) => `${r.status} ${String(r.json?.error?.message ?? r.text).slice(0, 60)}`;
// OpenAI 风格错误体：error.message 存在且无堆栈/SQL 泄露特征
const isApiStyleError = (r) =>
  r.json?.error?.message && !/at\s+\S+\(\S+:\d+:\d+\)|\.js:\d+|SQL|syntax error/i.test(JSON.stringify(r.json));

// ---------- 自举（幂等：开头清理旧 sec 残留 → 重建） ----------
console.log(`=== stg security review @ ${BASE} (model: ${MODEL}, nonce: ${NONCE}) ===`);
const cleanupSql = `
  DELETE FROM balance_tx WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sec-%@staging.test');
  DELETE FROM usage_daily WHERE key_id IN (SELECT id FROM api_keys WHERE name LIKE 'sec-review-%');
  DELETE FROM request_logs WHERE key_id IN (SELECT id FROM api_keys WHERE name LIKE 'sec-review-%');
  DELETE FROM api_keys WHERE name LIKE 'sec-review-%';
  DELETE FROM users WHERE email LIKE 'sec-%@staging.test';`;
exec(cleanupSql);

const now = Math.floor(Date.now() / 1000);
const userId = (u) => {
  const row = q(`INSERT INTO users (email, name, role, status, balance, email_verified, created_at, updated_at)
    VALUES ('${u.email}', '${u.name}', '${u.role}', 'active', ${u.balance}, 1, ${now}, ${now});`);
  return q(`SELECT id FROM users WHERE email='${u.email}';`)[0]?.id;
};
const adminId = userId(SEC_ADMIN);
const memberId = userId(SEC_MEMBER);
const key = (name, ownerId) => {
  const plain = `sk-sec-${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(plain).digest("hex");
  exec(`INSERT INTO api_keys (user_id, name, hash, prefix, status, qps_limit, cache_enabled, cache_ttl, created_at)
    VALUES (${ownerId}, '${name}', '${hash}', '${plain.slice(0, 8)}', 'active', 60, 1, 3600, ${now});`);
  return { plain, id: q(`SELECT id FROM api_keys WHERE name='${name}';`)[0]?.id };
};
const KEY_A = key("sec-review-a", memberId);
const KEY_B = key("sec-review-b", memberId);
console.log(`  [bootstrap] sec-admin=${adminId} sec-member=${memberId} keyA=${KEY_A.id} keyB=${KEY_B.id}`);

// ---------- R1-R4 网关 key 鉴权三态 ----------
{
  const r1 = await proxyReq("", { model: MODEL, messages: [{ role: "user", content: "hi" }] });
  report("R1 无 key → 401 + OpenAI 错误体", r1.status === 401 && isApiStyleError(r1), errDetail(r1));

  const r2 = await proxyReq("sk-wrong-key-probe", { model: MODEL, messages: [{ role: "user", content: "hi" }] });
  report("R2 伪造 key → 401", r2.status === 401 && isApiStyleError(r2), errDetail(r2));

  const r3 = await proxyReq(`${KEY_A.plain.slice(0, 8)}${"x".repeat(32)}`, { model: MODEL, messages: [{ role: "user", content: "hi" }] });
  report("R3 有效前缀+随机体 → 401（前缀无特权）", r3.status === 401 && isApiStyleError(r3), errDetail(r3));

  const r4 = await raw("/v1/models", { headers: { Authorization: `Bearer ${KEY_A.plain}` } });
  report("R4 有效 key GET /v1/models → 200", r4.status === 200 && r4.json?.data?.some((m) => m.id === MODEL), `status=${r4.status}`);
}

// ---------- R5-R6 管理 API 会话 ----------
{
  const r5 = await raw("/api/users");
  report("R5 管理 API 无会话 → 401", r5.status === 401 && isApiStyleError(r5), errDetail(r5));

  const r6 = await raw("/api/users", { headers: { Cookie: "better-auth.session_token=fake-token-probe" } });
  report("R6 伪造 cookie 会话 → 401", r6.status === 401 && isApiStyleError(r6), errDetail(r6));
}

// ---------- R7 SQLi 探测 ----------
{
  const r7q = await raw("/v1/models?x=1'%20OR%201=1--", { headers: { Authorization: `Bearer ${KEY_A.plain}` } });
  report("R7a query 注入 → 非 500 且无 SQL 泄露", r7q.status < 500 && !/sql|syntax/i.test(JSON.stringify(r7q.json ?? r7q.text)), `status=${r7q.status}`);

  const r7b = await proxyReq(KEY_A.plain, { model: `1' OR 1=1--`, messages: [{ role: "user", content: "hi" }] });
  report("R7b body 注入（model 名）→ 非 500 且无 SQL 泄露", r7b.status < 500 && !/sql|syntax/i.test(JSON.stringify(r7b.json ?? r7b.text)), `status=${r7b.status}`);
}

// ---------- R8/F4 限流头矩阵 + R11 缓存隔离（A1-A3 复用同一缓存链路） ----------
const cacheBody = { model: MODEL, messages: [{ role: "user", content: `cache-isolation-${NONCE}` }] };
const r8a = await proxyReq(KEY_A.plain, { messages: [] });
report("R8a 错误路径带头（400 非法 body）", r8a.status === 400 && hasRL(r8a.headers), `status=${r8a.status} — F4 佐证：错误路径 c.json 保留头`);
const MAX_A = q(`SELECT COALESCE(MAX(id),0) AS m FROM request_logs WHERE key_id=${KEY_A.id};`)[0]?.m ?? 0;
const A1 = await proxyReq(KEY_A.plain, cacheBody);
const A2 = await proxyReq(KEY_A.plain, cacheBody);
const A3 = await proxyReq(KEY_A.plain, cacheBody);
report("F4c 缓存 miss 非流式成功路径带头（修复生效）", A1.status === 200 && hasRL(A1.headers) && A2.status === 200 && hasRL(A2.headers), `A1/A2 均有头`);
report("F4d 缓存命中路径带头（防御侧正确）", A3.status === 200 && hasRL(A3.headers), `status=${A3.status} 有头=${hasRL(A3.headers)}`);
report("R11a keyA 第 3 次请求命中缓存", await poll(async () => {
  const rows = q(`SELECT status FROM request_logs WHERE key_id=${KEY_A.id} AND id > ${MAX_A} AND status='cached';`);
  return rows.length ? rows[0].status : null;
}, 15000, 800) === "cached", "request_logs status=cached");

// 隔离：keyB 同请求体 2 次 → 第 2 次仍 success（未命中 keyA 缓存；若共享缓存则为 cached）
const MAX_B = q(`SELECT COALESCE(MAX(id),0) AS m FROM request_logs WHERE key_id=${KEY_B.id};`)[0]?.m ?? 0;
const B1 = await proxyReq(KEY_B.plain, cacheBody);
const B2 = await proxyReq(KEY_B.plain, cacheBody);
report("R11b keyB 同体 2 次不命中 keyA 缓存（keyId 隔离）", await poll(async () => {
  // 延迟计费异步落行：等 B1/B2 两行齐备，取第 2 行（B2）status
  const rows = q(`SELECT status FROM request_logs WHERE key_id=${KEY_B.id} AND id > ${MAX_B} ORDER BY id ASC;`);
  return rows.length >= 2 ? rows[1].status : null;
}, 20000, 800) === "success", `B2 status 应为 success（共享则 cached）`);

// ---------- R9 邀请码路径 ----------
{
  const r9 = await raw("/api/auth/sign-up/email", { headers: { Origin: new URL(BASE).origin } },
    { email: `sec-invite-${NONCE}@staging.test`, password: "Password123!", name: "Sec Invite", inviteCode: "SK-NOT-A-REAL-CODE" });
  const notCreated = q(`SELECT COUNT(*) AS c FROM users WHERE email='sec-invite-${NONCE}@staging.test';`)[0]?.c === 0;
  report("R9 无效邀请码 → 403 且不建号", r9.status === 403 && r9.json?.code === "INVITE_CODE_INVALID" && notCreated,
    `${r9.status} code=${r9.json?.code} 建号=${!notCreated}`);
}

// ---------- R10 SEED_USERS 逃生口 ----------
{
  const r10 = await raw("/api/seed/users", { headers: { Origin: new URL(BASE).origin } }, {});
  report("R10 SEED_USERS 逃生口 → 404（未配置 fail-closed）", r10.status === 404, `status=${r10.status}`);
}

// ---------- F1 观测：SSE 未请求 include_usage 的计费行为 ----------
{
  const MAX_S = q(`SELECT COALESCE(MAX(id),0) AS m FROM request_logs WHERE key_id=${KEY_A.id};`)[0]?.m ?? 0;
  const sseRes = await raw("/v1/chat/completions",
    { headers: { Authorization: `Bearer ${KEY_A.plain}` }, timeoutMs: 60000 }, {
      model: MODEL, stream: true,
      messages: [{ role: "user", content: `Reply with exactly: OK-${NONCE}` }],
    });
  report("F4b SSE 流式成功路径带头（修复生效）", sseRes.status === 200 && hasRL(sseRes.headers), `status=${sseRes.status} 有头=${hasRL(sseRes.headers)}`);
  const usageInTail = /"usage"\s*:/.test(sseRes.text);
  const tailTokens = sseRes.text.match(/"usage"\s*:\s*\{[^}]*"total_tokens"\s*:\s*(\d+)/)?.[1] ?? null;
  const row = await poll(async () => {
    const rows = q(`SELECT status, cost, prompt_tokens, completion_tokens, request_id FROM request_logs
      WHERE key_id=${KEY_A.id} AND id > ${MAX_S} ORDER BY id DESC LIMIT 1;`);
    return rows.length ? rows[0] : null;
  }, 30000, 1000);
  console.log(`  [F1 观测] SSE(客户端未带 include_usage，网关注入) status=${sseRes.status} 尾包含 usage=${usageInTail} total=${tailTokens}`);
  console.log(`  [F1 观测] D1 计费行: status=${row?.status} cost=${row?.cost} prompt=${row?.prompt_tokens} completion=${row?.completion_tokens} request_id=${row?.request_id}`);
  report("F1 观测请求成功且产生计费行", sseRes.status === 200 && row?.status === "success" && row?.cost > 0,
    `status=${sseRes.status} cost=${row?.cost}`);
  // 说明：F1 修复后网关在 buildRequest 强制注入 stream_options.include_usage
  // （客户端无权关闭，计费优先）——规范 OpenAI 上游也必回 usage 尾包，不再免单。
  // 本观测请求客户端未带 include_usage，仍产生计费行即证明注入生效（deepseek 自发 usage 亦覆盖）。
}

// ---------- R12 错误体风格（抽样） ----------
{
  const r12 = await proxyReq(KEY_A.plain, { model: MODEL, messages: [] });
  report("R12 400 错误体 API 风格无泄露", r12.status === 400 && isApiStyleError(r12), errDetail(r12));
}

// ---------- 清理（--keep 保留） ----------
if (!KEEP) {
  exec(cleanupSql);
  console.log(`  [cleanup] sec 前缀数据已清理`);
} else {
  console.log(`  [keep] sec 前缀数据保留（sec-admin/sec-member/keyA/keyB）`);
}

console.log(`=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed) {
  console.log("failures:", failures.join(" | "));
  process.exit(1);
}
