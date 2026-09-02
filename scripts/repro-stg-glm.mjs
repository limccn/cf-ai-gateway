// CC Switch / Claude Code 形态复现：Anthropic 原生入站 → glm-5.3-flash（stg 真实链路）。
// 1) D1 直插 admin + 网关 key（仿 verify-codex-lite-stg.mjs）
// 2) POST /anthropic/v1/messages（x-api-key + anthropic-version，stream true/false 混合：
//    非流式×2 + 流式×3 + CC 增强形态×2（thinking+8k）+ CC 64k 量级×1）
// 3) 输出每次 status / 耗时 / 错误体；末尾查 request_logs 落账
// 前置：stg 已部署（迁移 0009）；glm-5.3-flash max_output_tokens=3000（实测 b.ai 吞吐
//       ~37 t/s：cap=16000 时 64k 请求仍 202s 撞线，3000 = 120s×37×0.68 安全余量）；
//       b.ai providers upstream_timeout_ms=120000；本机 wrangler 已登录。
// 用法：node scripts/repro-stg-glm.mjs
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const BASE = "https://stg-router.lmlh.net";
const DB = "cf-ai-gateway-db-staging";
const ADMIN_EMAIL = "repro-glm-admin@staging.test";
const MODEL = "glm-5.3-flash";
const MAX_TOKENS = 256; // Claude Code 会发大 max_tokens；先小值隔离慢生成因素

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  ok ? passed++ : failed++;
}

const WRANGLER_JS = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const D1 = (...args) => execFileSync(process.execPath,
  [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml", ...args],
  { stdio: "pipe", encoding: "utf8" });
const q = (sql) => JSON.parse(D1("--json", "--command", sql))[0]?.results ?? [];
const exec = (sql) => D1("--command", sql);

const now = Math.floor(Date.now() / 1000);

async function anthropic(path, { key, headers = {}, body, stream } = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.log(`  [retry] ${error.cause?.code ?? error.message}`);
    return { status: 0, ms: Date.now() - t0, text: `fetch failed: ${error.message}` };
  }
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, text: text.slice(0, 500) };
}

async function main() {
  console.log(`=== repro glm-5.3-flash via anthropic-native @ ${BASE} ===`);

  // 0. bootstrap
  let adminId = q(`SELECT id FROM users WHERE email='${ADMIN_EMAIL}' LIMIT 1;`)[0]?.id;
  if (!adminId) {
    exec(`INSERT INTO users (email, name, role, status, balance, email_verified, created_at, updated_at) ` +
      `VALUES ('${ADMIN_EMAIL}', 'Repro GLM Admin', 'admin', 'active', 50, 1, ${now}, ${now});`);
    adminId = q(`SELECT id FROM users WHERE email='${ADMIN_EMAIL}' LIMIT 1;`)[0].id;
  }
  const keyRows = q(`SELECT id FROM api_keys WHERE user_id=${adminId} AND name='repro-glm';`);
  if (keyRows[0]) {
    exec(`DELETE FROM balance_tx WHERE user_id=${adminId}; DELETE FROM usage_daily WHERE key_id=${keyRows[0].id}; ` +
      `DELETE FROM request_logs WHERE key_id=${keyRows[0].id}; DELETE FROM api_keys WHERE id=${keyRows[0].id};`);
  }
  const keyPlain = `sk-e2e-${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(keyPlain).digest("hex");
  exec(`INSERT INTO api_keys (user_id, name, hash, prefix, status, qps_limit, cache_enabled, cache_ttl, created_at) ` +
    `VALUES (${adminId}, 'repro-glm', '${hash}', '${keyPlain.slice(0, 8)}', 'active', 60, 1, 3600, ${now});`);
  console.log(`[0] key ready prefix=${keyPlain.slice(0, 8)}`);

  // 1. 非流式 ×2
  for (let i = 1; i <= 2; i++) {
    const r = await anthropic("/anthropic/v1/messages", {
      key: keyPlain,
      body: {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: `Say hello in one short sentence. (probe ${i})` }],
      },
    });
    report(`非流式 #${i} → ${r.status} in ${r.ms}ms`, r.status === 200,
      r.status === 200 ? "" : JSON.stringify(r.text.slice(0, 220)));
  }

  // 2. 流式 ×3（Claude Code 默认流式）
  for (let i = 1; i <= 3; i++) {
    const r = await anthropic("/anthropic/v1/messages", {
      key: keyPlain,
      body: {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: [{ role: "user", content: `Count from 1 to 3. (stream probe ${i})` }],
      },
    });
    report(`流式 #${i} → ${r.status} in ${r.ms}ms`, r.status === 200,
      r.status === 200 ? "" : JSON.stringify(r.text.slice(0, 220)));
  }

  // 3. Claude Code 增强形态（thinking 字段 + 大 max_tokens + 多轮）——疑似慢生成元凶
  for (let i = 1; i <= 2; i++) {
    const r = await anthropic("/anthropic/v1/messages", {
      key: keyPlain,
      body: {
        model: MODEL,
        max_tokens: 8192,
        stream: true,
        thinking: { type: "enabled", budget_tokens: 2048 },
        messages: [
          { role: "user", content: "Write a short poem about the sea. (cc-switch shape probe)" },
        ],
      },
    });
    report(`增强形态 #${i}（thinking+8k max_tokens 流式）→ ${r.status} in ${r.ms}ms`, r.status === 200,
      r.status === 200 ? "" : JSON.stringify(r.text.slice(0, 220)));
  }

  // 3.5 Claude Code 真实量级：65536 max_tokens（CC 默认 64k）
  // → proxy 层 clamp 到 models.max_output_tokens（stg 已配 glm-5.3-flash=16000），
  //   生成量级可控 + 120s provider 超时兜底（单次低频，b.ai 配额敏感）
  for (let i = 1; i <= 1; i++) {
    const r = await anthropic("/anthropic/v1/messages", {
      key: keyPlain,
      body: {
        model: MODEL,
        max_tokens: 65536,
        stream: true,
        messages: [
          { role: "user", content: "Explain the concept of recursion with detailed examples. (cc 64k probe)" },
        ],
      },
    });
    report(`CC 量级 #${i}（64k max_tokens → clamp 16000 流式）→ ${r.status} in ${r.ms}ms`, r.status === 200,
      r.status === 200 ? "" : JSON.stringify(r.text.slice(0, 260)));
  }

  // 4. 落账
  const rows = q(`SELECT status, latency_ms, provider_id, datetime(created_at,'unixepoch') AS ts FROM request_logs WHERE key_id=(SELECT id FROM api_keys WHERE user_id=${adminId} AND name='repro-glm') ORDER BY id;`);
  console.log(`\n[4] request_logs (${rows.length}):`);
  for (const r of rows) console.log(`  ${r.ts}  ${r.status.padEnd(7)} ${String(r.latency_ms).padStart(6)}ms provider=${r.provider_id}`);

  console.log(`\n=== repro: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("repro crashed:", error);
  process.exitCode = 1;
});
