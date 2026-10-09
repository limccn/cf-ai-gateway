// stg 环境 E2E 自举（D1 直插，绕过认证流程）：
// 创建 admin 测试用户 + member 测试用户 + 网关 API Key（明文仅本脚本内存，落库 sha256）。
// 幂等：按 email 查重跳过。用法：node scripts/stg-e2e-bootstrap.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const DB = "cf-ai-gateway-db-staging";
const WRANGLER_JS = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
// 双域名分流（09-21-dual-domain-split）：管理面与公开 API 面各走自己的域。
// 本脚本只直插 D1、不发请求，BASE/API_BASE 仅用于打印给后续 verify 脚本用。
const BASE = process.env.BASE_URL ?? "https://stg-platform.lmlh.net";
// 由 BASE 派生（`replace` 无匹配时原样返回）⇒ 传 localhost 时不会指到线上。
const API_BASE = process.env.API_BASE_URL ?? BASE.replace("stg-platform.lmlh.net", "stg-api.lmlh.net");

const ADMIN = { email: "e2e-admin@staging.test", name: "E2E Admin", role: "admin", balance: 50 };
const MEMBER = { email: "e2e-user@staging.test", name: "E2E User", role: "member", balance: 20 };

const q = (sql) => JSON.parse(execFileSync(process.execPath,
  [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml",
    "--command", sql, "--json"], { encoding: "utf8" }))[0]?.results ?? [];

const now = Math.floor(Date.now() / 1000);

function ensureUser(u) {
  const existing = q(`SELECT id FROM users WHERE email='${u.email}' LIMIT 1;`);
  if (existing[0]) { console.log(`[bootstrap] user exists: ${u.email} id=${existing[0].id}`); return existing[0].id; }
  const sql = `INSERT INTO users (email, name, role, status, balance, email_verified, created_at, updated_at)
    VALUES ('${u.email}', '${u.name}', '${u.role}', 'active', ${u.balance}, 1, ${now}, ${now});`;
  execFileSync(process.execPath, [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml", "--command", sql], { stdio: "inherit" });
  const row = q(`SELECT id FROM users WHERE email='${u.email}' LIMIT 1;`)[0];
  console.log(`[bootstrap] user created: ${u.email} id=${row.id} role=${u.role} balance=${u.balance}`);
  return row.id;
}

const adminId = ensureUser(ADMIN);
const memberId = ensureUser(MEMBER);

// 网关 API Key（member 所有）：明文 sk-e2e-... 仅本进程内存，落库 sha256 hex。
let keyPlain = null;
const keyRows = q(`SELECT id, hash FROM api_keys WHERE user_id=${memberId} AND name='e2e-test';`);
if (keyRows[0]) {
  console.log(`[bootstrap] api key exists id=${keyRows[0].id}（明文不可恢复，重新生成）`);
  // 外键依赖链：balance_tx.ref_request_id → request_logs；usage_daily.key_id / request_logs.key_id → api_keys。
  // 按依赖序清理该 member 的 E2E 残留（balance_tx → usage_daily → request_logs → api_keys）。
  execFileSync(process.execPath, [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml",
    "--command",
    `DELETE FROM balance_tx WHERE user_id=${memberId}; DELETE FROM usage_daily WHERE key_id=${keyRows[0].id}; ` +
    `DELETE FROM request_logs WHERE key_id=${keyRows[0].id}; DELETE FROM api_keys WHERE id=${keyRows[0].id};`],
    { stdio: "inherit" });
}
keyPlain = `sk-e2e-${randomBytes(16).toString("hex")}`;
const hash = createHash("sha256").update(keyPlain).digest("hex");
const prefix = keyPlain.slice(0, 8);
// cache_enabled=1：E2E 需验证缓存命中链路（miss 计数/写缓存/命中不扣费）；
// 曾为 0 导致 stg-e2e-verify 的缓存部分断言全部无效（命中永不发生）。
execFileSync(process.execPath, [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml",
  "--command", `INSERT INTO api_keys (user_id, name, hash, prefix, status, qps_limit, cache_enabled, cache_ttl, created_at)
    VALUES (${memberId}, 'e2e-test', '${hash}', '${prefix}', 'active', 60, 1, 3600, ${now});`], { stdio: "inherit" });

console.log(`[bootstrap] api key created for member id=${memberId}`);
console.log(`KEY=${keyPlain}`);
console.log(`ADMIN_ID=${adminId}`);
console.log(`MEMBER_ID=${memberId}`);
console.log(`BASE=${BASE}`);
console.log(`API_BASE=${API_BASE}`);
