// stg 环境 range 快捷维度真实 E2E（08-31-usage-stats-dimensions）：
// 1. D1 直插历史 request_logs（昨天/3 天前/29 天前/30 天前窗口外）——模拟结算产物
// 2. 直插 Better Auth credential 账号（scrypt 与 Better Auth 同参）→ POST sign-in/email 拿 session cookie
// 3. 对 /api/me/usage 断言 4 个 range 窗口 + 时区桶键 + 明细边界
// 4. 清理全部自插数据（历史行 + 账号 + session），stg 保持干净
// 前置：stg-e2e-bootstrap + stg-e2e-verify 已跑（member key 有今天真实请求）。
// 用法：node scripts/stg-e2e-usage-ranges.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, scryptSync } from "node:crypto";

const DB = "cf-ai-gateway-db-staging";
const WRANGLER_JS = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const BASE = process.env.BASE_URL ?? "https://stg-router.lmlh.net";
const TZ = 480; // 本机 UTC+8，与浏览器 getTzOffsetMin() 一致

const q = (sql) => JSON.parse(execFileSync(process.execPath,
  [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml",
    "--command", sql, "--json"], { encoding: "utf8" }))[0]?.results ?? [];
const run = (sql) => execFileSync(process.execPath,
  [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml",
    "--command", sql], { stdio: "inherit" });

let passed = 0, failed = 0;
const report = (name, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
  ok ? passed++ : failed++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 夹具：member key + 历史行 =====
const keyRows = q(`SELECT id FROM api_keys WHERE user_id=26 AND name='e2e-test';`);
if (!keyRows[0]) throw new Error("e2e-test key not found — run stg-e2e-bootstrap first");
const KEY_ID = keyRows[0].id;
const MEMBER_ID = 26;

const DAY = 86_400_000;
const offsetMs = TZ * 60_000;
const todayStartUtc = Math.floor((Date.now() + offsetMs) / DAY) * DAY - offsetMs;
const t = (daysBack, hourLocal) => Math.floor((todayStartUtc - daysBack * DAY + hourLocal * 3600_000) / 1000);
const HIST = [
  { label: "yesterday-12h", ts: t(1, 12), model: "hy3", status: "success", cost: 0.0031 },
  { label: "d3-09h",        ts: t(3, 9),  model: "qwen3.8-flash", status: "cached", cost: 0.0008 },
  { label: "d29-09h",       ts: t(29, 9), model: "glm-5.3-flash", status: "success", cost: 0.0015 },
  { label: "d30-09h",       ts: t(30, 9), model: "deepseek-v4-flash", status: "success", cost: 0.0011 }, // last30 窗口外
];
const insertSql = HIST.map((h) =>
  `(${MEMBER_ID}, ${KEY_ID}, '${h.model}', 100, 80, ${h.cost}, '${h.status}', 200, ${h.ts})`
).join(", ");
run(`INSERT INTO request_logs (user_id, key_id, model, prompt_tokens, completion_tokens, cost, status, latency_ms, created_at) VALUES ${insertSql};`);
console.log(`[ranges] seeded ${HIST.length} history rows (key_id=${KEY_ID})`);

// ===== 夹具：credential 账号（scrypt 与 Better Auth 同参）+ sign-in =====
const PW = `e2e-ranges-${randomBytes(8).toString("hex")}`;
const salt = randomBytes(16).toString("hex");
// Better Auth 1.7 用 @noble/hashes scrypt：N=16384, r=16, p=1, dkLen=64 + 密码 NFKC 归一化
// （node 默认 r=8 —— 必须显式对齐，否则 verify 失败）
const pwHash = `${salt}:${scryptSync(PW.normalize("NFKC"), salt, 64, {
  N: 16384,
  r: 16,
  p: 1,
  maxmem: 128 * 16384 * 16 * 2,
}).toString("hex")}`;
const now = Math.floor(Date.now() / 1000);
// 先清可能残留的同账号行，再插入（幂等）
run(`DELETE FROM accounts WHERE user_id=${MEMBER_ID} AND provider_id='credential';`);
// issuer 必须为 'local:credential'（Better Auth credential provider 的 issuer 格式；'better-auth' 会导致 sign-in 查不到账号）
run(`INSERT INTO accounts (issuer, account_id, provider_id, user_id, password, created_at, updated_at)
  VALUES ('local:credential', '${MEMBER_ID}', 'credential', ${MEMBER_ID}, '${pwHash}', ${now}, ${now});`);
const acctCheck = q(`SELECT id, provider_id, account_id, user_id, substr(password,1,20) AS pw FROM accounts WHERE user_id=${MEMBER_ID} AND provider_id='credential';`);
console.log(`[ranges] credential account seeded:`, JSON.stringify(acctCheck[0] ?? null));

const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: BASE },
  body: JSON.stringify({ email: "e2e-user@staging.test", password: PW }),
});
// Node 24 getSetCookie() 返回全部 Set-Cookie 头（get() 只取第一个，可能丢 cookie）
const setCookie = signIn.headers.getSetCookie().join("; ");
// HTTPS 站点 cookie 带 __Secure- 前缀（本地 http 则无）——正则整体捕获名字+值
const m = setCookie.match(/(?:__Secure-)?better-auth\.session_token=[^;]+/);
if (!m) throw new Error(`sign-in failed status=${signIn.status} body=${await signIn.text()}`);
const COOKIE = m[0];
console.log(`[ranges] set-cookie: ${setCookie.slice(0, 80)}…`);
console.log(`[ranges] signed in as e2e-user@staging.test (cookie ok)`);

const usage = async (range, tz) => {
  const res = await fetch(`${BASE}/api/me/usage?range=${range}&tzOffsetMin=${tz}&limit=50`, {
    headers: { Cookie: COOKIE },
  });
  if (!res.ok) {
    throw new Error(`usage ${range} tz=${tz} status=${res.status} body=${await res.text()}`);
  }
  return res.json();
};

try {
  console.log(`=== stg range E2E @ ${BASE} (tz=${TZ}) ===`);

  // 1. today：verify 真实请求在窗口（今天小时桶），昨天直插行不在
  const today = await usage("today", TZ);
  report("today 200 + aggregates", today.success === true && Array.isArray(today.aggregates));
  const todayKeys = today.aggregates.map((a) => a.group);
  const todayTotal = today.aggregates.reduce((s, a) => s + a.requests, 0);
  report("today contains verify rows (≥7)", todayTotal >= 7, `total=${todayTotal}`);
  report("today excludes yesterday-12h", !todayKeys.includes("yesterday-12h") && !todayKeys.some((k) => k.startsWith("2026-08-30T")), `buckets=${todayKeys.length}`);
  const hourShape = todayKeys.every((k) => /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(k));
  report("today hour bucket shape", hourShape, todayKeys.slice(0, 3).join(","));
  // tz 差异：480 时 today 首桶 = 本地 00:00；0 时首桶 = UTC 00:00（本地 08:00）——两者不同键
  const todayUtc = await usage("today", 0);
  const utcKeys = todayUtc.aggregates.map((a) => a.group);
  report("tzOffsetMin changes bucket keys", JSON.stringify(todayKeys) !== JSON.stringify(utcKeys),
    `480:${todayKeys[0]} vs 0:${utcKeys[0]}`);

  // 2. yesterday：仅昨天直插行
  const yesterday = await usage("yesterday", TZ);
  const yKeys = yesterday.aggregates.map((a) => a.group);
  const yTotal = yesterday.aggregates.reduce((s, a) => s + a.requests, 0);
  report("yesterday = 1 row", yTotal === 1 && yKeys.some((k) => k.startsWith("2026-08-30T12")), `total=${yTotal} buckets=${yKeys.join(",")}`);

  // 3. last14：昨天 + 3 天前（29 天前不在）
  const last14 = await usage("last14", TZ);
  const d14Keys = last14.aggregates.map((a) => a.group);
  const d14Total = last14.aggregates.reduce((s, a) => s + a.requests, 0);
  const dayShape = d14Keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
  report("last14 includes d1+d3, excludes d29", d14Keys.includes("2026-08-30") && d14Keys.includes("2026-08-28") && !d14Keys.includes("2026-08-02"), d14Keys.join(","));
  report("last14 day bucket shape + total", dayShape && d14Total >= 2, `total=${d14Total}`);

  // 4. last30：昨天 + 3 天前 + 29 天前（30 天前不在）
  const last30 = await usage("last30", TZ);
  const d30Keys = last30.aggregates.map((a) => a.group);
  const d30Total = last30.aggregates.reduce((s, a) => s + a.requests, 0);
  report("last30 includes d1+d3+d29", ["2026-08-30", "2026-08-28", "2026-08-02"].every((k) => d30Keys.includes(k)), d30Keys.join(","));
  report("last30 excludes d30", !d30Keys.includes("2026-08-01"), `total=${d30Total}`);

  // 5. 明细窗口边界：last30 details 含直插 3 条 + verify 行，不含 d30-09h
  const last30Details = await usage("last30", TZ);
  const detailModels = last30Details.details.map((d) => `${d.model}:${d.createdAt}`);
  const d30Ts = t(30, 9) * 1000;
  const d30Iso = new Date(d30Ts).toISOString();
  report("details exclude d30-09h", !detailModels.some((dm) => dm.endsWith(d30Iso)), `details=${last30Details.details.length}`);
  report("details include d29 row", detailModels.some((dm) => dm.startsWith("glm-5.3-flash:")), "");

  // 6. 响应形态：today 明细 total ≥ 聚合 total（今日 verify + 无直插今日行）
  report("today details.total ≥ aggregates sum", last30Details.total >= d30Total, `total=${last30Details.total}`);

  console.log(`=== RESULT: ${passed} passed, ${failed} failed ===`);
} finally {
  // ===== 清理：自插历史行 + 账号 + session =====
  const tsList = HIST.map((h) => h.ts).join(", ");
  run(`DELETE FROM request_logs WHERE created_at IN (${tsList});`);
  run(`DELETE FROM accounts WHERE user_id=${MEMBER_ID} AND provider_id='credential';`);
  run(`DELETE FROM sessions WHERE user_id=${MEMBER_ID} AND token IN (SELECT token FROM sessions WHERE user_id=${MEMBER_ID} AND expires_at > ${now});`);
  console.log(`[ranges] cleaned seeded history + credential account + sessions`);
}
process.exit(failed > 0 ? 1 : 0);
