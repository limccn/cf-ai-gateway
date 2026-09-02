// Codex Responses Lite 全量适配 stg 真实链路模拟（09-01-codex-responses-lite-full 批次）：
// stg（https://stg-router.lmlh.net）无法访问本地 mock，字节级断言（扁平 tools 上游收到）
// 由本地 verify-codex-lite.mjs（16/16）与单测覆盖；本脚本验证真实环境行为：
//   1) D1 直插 auth（仿 stg-e2e-bootstrap）+ 价格 + bravo.b.ai provider 模型映射
//   2) lite 请求（additional_tools[functions namespace] + tool_search/web + reasoning 回放
//      + function_call 往返 + 40k 上下文）→ 200 + output_text（真实 b.ai 上游）
//   3) reasoning_roundtrip=1（D1 直改，与 PATCH 语义一致）→ 再发 → 200
//   4) 结算：request_logs success ×2 + balance 下降
// 用法：node scripts/verify-codex-lite-stg.mjs
// 前置：stg 已部署最新代码（含迁移 0008）；本机 wrangler 已登录
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const BASE = "https://stg-router.lmlh.net";
const DB = "cf-ai-gateway-db-staging";
const ADMIN_EMAIL = "e2e-codex-admin@staging.test";
const PROVIDER_NAME = "bravo.b.ai";
const INTERNAL_MODEL = "gpt-5.6-codex";
const UPSTREAM_MODEL = "gpt-5.6-sol"; // b.ai 已验证可服务的模型名（verify-stg-models 矩阵）
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
const D1 = (...args) => execFileSync(process.execPath,
  [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml", ...args],
  { stdio: "pipe", encoding: "utf8" });
const q = (sql) => JSON.parse(D1("--json", "--command", sql))[0]?.results ?? [];
const exec = (sql) => D1("--command", sql);

const now = Math.floor(Date.now() / 1000);

async function api(path, { method = "GET", headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    console.log(`  [retry] ${method} ${path} failed (${error.cause?.code ?? error.message}), retrying...`);
    await sleep(1500);
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function poll(fn, timeoutMs = 180000, intervalMs = 1000) {
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

/** Codex lite 请求体（与本地 verify-codex-lite 同构）。 */
function codexLiteBody(nonce) {
  const bigContext = `${nonce}|` + "x".repeat(40_000);
  return {
    model: INTERNAL_MODEL,
    instructions: [
      { type: "message", role: "developer", content: "You are a coding agent." },
    ],
    input: [
      {
        type: "additional_tools",
        id: "at_1",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              {
                type: "function",
                name: "exec",
                description: "run a command",
                parameters: { type: "object", properties: { cmd: { type: "string" } } },
              },
              {
                type: "function",
                name: "lookup",
                description: "look up info",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
          { type: "namespace", name: "tool_search", tools: [{ type: "tool_search", name: "tool_search" }] },
          { type: "namespace", name: "web", tools: [{ type: "web_search", name: "web" }] },
        ],
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "previous round thinking" }],
      },
      { role: "assistant", content: "I checked the code." },
      { type: "function_call", call_id: "call_1", name: "exec", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "src/" },
      { role: "user", content: bigContext },
    ],
  };
}

async function main() {
  console.log(`\n=== codex responses-lite stg verify @ ${BASE} ===`);

  // ---------- 0. D1 直插 auth（仿 stg-e2e-bootstrap） ----------
  console.log("\n[0] bootstrap admin + key");
  let adminId = q(`SELECT id FROM users WHERE email='${ADMIN_EMAIL}' LIMIT 1;`)[0]?.id;
  if (!adminId) {
    exec(
      `INSERT INTO users (email, name, role, status, balance, email_verified, created_at, updated_at) ` +
        `VALUES ('${ADMIN_EMAIL}', 'Codex E2E Admin', 'admin', 'active', 50, 1, ${now}, ${now});`,
    );
    adminId = q(`SELECT id FROM users WHERE email='${ADMIN_EMAIL}' LIMIT 1;`)[0].id;
    console.log(`[0] admin created id=${adminId}`);
  } else {
    console.log(`[0] admin exists id=${adminId}`);
  }
  report("admin 直插就绪", adminId !== undefined, `id=${adminId}`);

  const keyRows = q(`SELECT id FROM api_keys WHERE user_id=${adminId} AND name='codex-lite-e2e';`);
  if (keyRows[0]) {
    exec(
      `DELETE FROM balance_tx WHERE user_id=${adminId}; DELETE FROM usage_daily WHERE key_id=${keyRows[0].id}; ` +
        `DELETE FROM request_logs WHERE key_id=${keyRows[0].id}; DELETE FROM api_keys WHERE id=${keyRows[0].id};`,
    );
  }
  const keyPlain = `sk-e2e-${randomBytes(16).toString("hex")}`;
  const hash = createHash("sha256").update(keyPlain).digest("hex");
  exec(
    `INSERT INTO api_keys (user_id, name, hash, prefix, status, qps_limit, cache_enabled, cache_ttl, created_at) ` +
      `VALUES (${adminId}, 'codex-lite-e2e', '${hash}', '${keyPlain.slice(0, 8)}', 'active', 60, 1, 3600, ${now});`,
  );
  report("网关 key 直插就绪", q(`SELECT id FROM api_keys WHERE hash='${hash}' AND status='active';`)[0] !== undefined, `prefix=${keyPlain.slice(0, 8)}`);

  // ---------- 1. 价格 + provider 映射 ----------
  console.log("\n[1] price + provider model mapping");
  exec(
    `INSERT OR IGNORE INTO models (model, input_price_short, input_price_long, input_price_cached, output_price_short, output_price_long, created_at, updated_at) ` +
      `VALUES ('${INTERNAL_MODEL}', ${INPUT_PRICE}, ${INPUT_PRICE}, 0, ${OUTPUT_PRICE}, ${OUTPUT_PRICE}, ${now}, ${now});`,
  );
  report(`price ${INTERNAL_MODEL} 直插`, q(`SELECT id FROM models WHERE model='${INTERNAL_MODEL}';`)[0] !== undefined, "");

  const provider = q(`SELECT id, models FROM providers WHERE name='${PROVIDER_NAME}' LIMIT 1;`)[0];
  report(`provider ${PROVIDER_NAME} 存在`, provider !== undefined, JSON.stringify(provider ?? null));
  if (provider) {
    const mapping = JSON.parse(provider.models ?? "{}");
    mapping[INTERNAL_MODEL] = UPSTREAM_MODEL;
    exec(`UPDATE providers SET models='${JSON.stringify(mapping)}' WHERE id=${provider.id};`);
    const updated = JSON.parse(q(`SELECT models FROM providers WHERE id=${provider.id};`)[0].models);
    report(
      `模型映射 ${INTERNAL_MODEL} → ${UPSTREAM_MODEL} 已注册`,
      updated[INTERNAL_MODEL] === UPSTREAM_MODEL,
      `mapping=${JSON.stringify(updated)}`,
    );
  }

  // ---------- 2. lite 请求（flag off 默认）→ 真实 b.ai 上游 ----------
  console.log("\n[2] lite request (flag off)");
  const b0 = q(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
  const r1 = await api("/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${keyPlain}` },
    body: codexLiteBody("STGROUND1"),
  });
  // 40k 上下文 + exec/lookup 工具 → 模型可能选择工具调用（output 含 function_call，output_text 为空）
  // 或输出文本（output_text 非空）——两者都是合法完成，仅断言 200 + completed + 有输出
  const r1Completed =
    r1.status === 200 &&
    r1.json?.status === "completed" &&
    (Array.isArray(r1.json?.output) && r1.json.output.length > 0);
  const r1Kind = r1.json?.output?.[0]?.type ?? null;
  report(
    "lite 请求 → 200 + completed + 有输出（文本或 function_call）",
    r1Completed,
    `status=${r1.status} output_type=${r1Kind} output_text=${JSON.stringify(r1.json?.output_text ?? null).slice(0, 60)}`,
  );

  // ---------- 3. flag on：D1 直改 reasoning_roundtrip（与 PATCH 语义一致） ----------
  console.log("\n[3] lite request (flag on)");
  if (provider) {
    exec(`UPDATE providers SET reasoning_roundtrip=1 WHERE id=${provider.id};`);
    const flag = q(`SELECT reasoning_roundtrip FROM providers WHERE id=${provider.id};`)[0].reasoning_roundtrip;
    report("reasoning_roundtrip=1 生效", flag === 1, `flag=${flag}`);
  }
  const r2 = await api("/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${keyPlain}` },
    body: codexLiteBody("STGROUND2"),
  });
  report(
    "lite 请求（flag on）→ 200 + completed",
    r2.status === 200 && r2.json?.status === "completed" && Array.isArray(r2.json?.output) && r2.json.output.length > 0,
    `status=${r2.status} output_type=${r2.json?.output?.[0]?.type ?? null}`,
  );
  if (provider) {
    exec(`UPDATE providers SET reasoning_roundtrip=0 WHERE id=${provider.id};`);
    console.log("[3] reasoning_roundtrip 已复位 0");
  }

  // ---------- 4. 结算 ----------
  console.log("\n[4] settlement");
  const settled = await poll(async () => {
    const rows = q(`SELECT status FROM request_logs WHERE key_id=(SELECT id FROM api_keys WHERE user_id=${adminId} AND name='codex-lite-e2e') AND status='success' ORDER BY id;`);
    const balance = q(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
    if (rows.length >= 2 && balance !== null && balance < b0) {
      return { rows: rows.length, balance };
    }
    return null;
  }, 180000);
  report("两条 lite 请求均落账（success ×2 + balance 下降）", settled !== null, JSON.stringify(settled ?? null));

  console.log(`\n=== codex responses-lite stg verify: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("\nFailed checks:");
    for (const failure of lastFailures) {
      console.log(`  - ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("verify-codex-lite-stg crashed:", error);
  process.exitCode = 1;
});
