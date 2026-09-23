// stg 环境（https://stg-api.lmlh.net）任务③ 真实 E2E：/v1/messages 双协议自动感知。
// 前置：scripts/stg-e2e-bootstrap.mjs 已运行（KEY 输出）；E2E_KEY=<网关key>。
// 场景（上游限定 4 模型：deepseek-v4-flash / qwen3.8-flash / glm-5.3-flash / hy3）：
//   anthropic 体（anthropic-version 头 + max_tokens）→ Anthropic 响应（零回归）；
//   openai 体（无头无信号 → 模型名兜底）→ OpenAI 响应（行为变化 1：无 max_tokens 也 200）；
//   两协议各一流式；冲突 → 400 Anthropic 形态；延迟计费结算（request_logs + 余额）。
// 用法：E2E_KEY=<key> node scripts/stg-e2e-proto.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const BASE = "https://stg-api.lmlh.net";
const KEY = process.env.E2E_KEY;
const DB = "cf-ai-gateway-db-staging";
const WRANGLER_JS = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

if (!KEY) { console.error("E2E_KEY env var required (gateway key from bootstrap)"); process.exit(1); }

const KEY_HASH = createHash("sha256").update(KEY).digest("hex");
const owner = query(`SELECT k.user_id, u.email FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.hash='${KEY_HASH}' LIMIT 1;`)[0];
if (!owner) { console.error("cannot resolve key owner from api_keys (hash match failed)"); process.exit(1); }
const MEMBER_EMAIL = owner.email;
console.log(`[verify] key owner: ${MEMBER_EMAIL} (user_id=${owner.user_id})`);

let passed = 0, failed = 0;
const failures = [];
function report(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  <- ${detail}` : ""}`); }
}

async function api(path, { method = "GET", headers = {}, body } = {}) {
  const finalHeaders = { Authorization: `Bearer ${KEY}`, ...headers };
  if (body !== undefined) finalHeaders["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: finalHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (error) {
    console.log(`  [retry] ${method} ${path} (${error.cause?.code ?? error.message})`);
    await new Promise((r) => setTimeout(r, 800));
    res = await fetch(BASE + path, { method, headers: finalHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, json, text };
}

const parseSse = (text) => text.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
const hasDone = (text) => text.split("\n").some((l) => l.trim() === "data: [DONE]");

function query(sql) {
  return JSON.parse(execFileSync(process.execPath,
    [WRANGLER_JS, "d1", "execute", DB, "--remote", "--env", "staging", "--config", "wrangler.toml", "--command", sql, "--json"],
    { encoding: "utf8" }))[0]?.results ?? [];
}
const balanceOf = () => query(`SELECT balance FROM users WHERE email='${MEMBER_EMAIL}';`)[0]?.balance;
const MAX_ID_BEFORE = query(`SELECT COALESCE(MAX(id),0) AS m FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${MEMBER_EMAIL}');`)[0]?.m ?? 0;
const logs = () => query(`SELECT status, model, provider_id, cost, prompt_tokens, completion_tokens FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${MEMBER_EMAIL}') AND id > ${MAX_ID_BEFORE} ORDER BY id DESC LIMIT 10;`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, timeoutMs = 120000, intervalMs = 400) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

const D = "deepseek-v4-flash";
const Q = "qwen3.8-flash";
const G = "glm-5.3-flash";
const H = "hy3";
// run nonce：请求体跨 run 唯一（防 R2 缓存跨 run 命中 → 无计费事件）
const NONCE = Date.now().toString(36);

console.log(`=== stg E2E protocol auto-detect @ ${BASE} ===`);

// [1] 健康
const health = await api("/api/health", { headers: {} });
report("health ok", health.status === 200 && health.json?.ok === true, `status=${health.status}`);

const balanceBefore = balanceOf();
report("member balance seed > 0", balanceBefore > 0, `balance=${balanceBefore}`);

// [2] anthropic 体非流式（anthropic-version 头硬信号 + max_tokens）→ Anthropic 形态（零回归）
// max_tokens=128：b.ai 在 64 下随机空流（reasoning 吃掉预算），128+ 稳定（实测 6/6）
const msg = await api("/v1/messages", {
  method: "POST",
  headers: { "anthropic-version": "2023-06-01" },
  body: { model: D, max_tokens: 128, messages: [{ role: "user", content: `Reply with exactly: ANTHRO-${NONCE}` }] },
});
const msgText = msg.json?.content?.[0]?.text ?? "";
report("anthropic body → Anthropic form (deepseek-v4-flash)", msg.status === 200 && msgText.includes("ANTHRO-"), `status=${msg.status} content=${msgText.slice(0, 40)}`);
report("anthropic body usage", msg.json?.usage?.output_tokens > 0, `usage=${JSON.stringify(msg.json?.usage)}`);

// [3] openai 体非流式（无头无硬信号 → 模型名兜底 openai；qwen3.8-flash 无 max_tokens 也应 200 —— 行为变化 1）
const chat = await api("/v1/messages", {
  method: "POST",
  body: { model: Q, messages: [{ role: "user", content: `Reply with exactly: OPENAI-${NONCE}` }] },
});
const chatText = chat.json?.choices?.[0]?.message?.content ?? "";
report("openai body → OpenAI form (qwen3.8-flash, no max_tokens)", chat.status === 200 && chat.json?.object === "chat.completion" && chatText.includes("OPENAI-"), `status=${chat.status} object=${chat.json?.object} content=${chatText.slice(0, 40)}`);
report("openai body usage", chat.json?.usage?.total_tokens > 0, `usage=${JSON.stringify(chat.json?.usage)}`);

// [4] anthropic 体流式（hy3）。
// 注意：hy3 在 128 token 预算下可能全被 reasoning 吃掉（实测 message_delta stop_reason=max_tokens，
// 无可见 content_block_delta）——协议验证看 Anthropic 事件序列（message_start/message_delta/message_stop），
// 不看具体 delta 类型，避免对 reasoning-heavy 模型误报。
const msgStream = await api("/v1/messages", {
  method: "POST",
  headers: { "anthropic-version": "2023-06-01" },
  body: { model: H, max_tokens: 128, stream: true, messages: [{ role: "user", content: `Count 1 to 3 (${NONCE})` }] },
});
const msgEvents = parseSse(msgStream.text);
report("anthropic body stream events (hy3)", msgStream.status === 200 && msgEvents.some((e) => e.type === "message_start") && msgEvents.some((e) => e.type === "message_stop") && msgEvents.some((e) => e.type === "content_block_delta" || e.type === "message_delta"), `events=${msgEvents.length}`);

// [5] openai 体流式（glm-5.3-flash）
const chatStream = await api("/v1/messages", {
  method: "POST",
  body: { model: G, stream: true, messages: [{ role: "user", content: `Count 1 to 3 (${NONCE})` }] },
});
const chatEvents = parseSse(chatStream.text);
report("openai body stream SSE + [DONE] (glm-5.3-flash)", chatStream.status === 200 && hasDone(chatStream.text) && chatEvents.length >= 2, `events=${chatEvents.length}`);
const usageTail = [...chatEvents].reverse().find((e) => e.usage);
report("openai body stream usage tail", !!usageTail && usageTail.usage.total_tokens > 0, `tail=${JSON.stringify(usageTail?.usage)}`);

// [6] 双向冲突 → 400 Anthropic 形态（行为变化 3）
const conflict = await api("/v1/messages", {
  method: "POST",
  body: { model: D, system: "sys", n: 2, messages: [{ role: "user", content: "x" }] },
});
report("conflict (system + n) → 400 Anthropic shape", conflict.status === 400 && conflict.json?.type === "error" && String(conflict.json?.error?.message ?? "").includes("mixes OpenAI and Anthropic"), `status=${conflict.status} body=${JSON.stringify(conflict.json)}`);

// [7] 结算：4 笔真实请求全落账 + 余额下降（延迟计费，120s 窗口）
const settled = await poll(() => {
  const rows = logs();
  const b = balanceOf();
  const successCost = rows.filter((r) => r.status === "success" && r.cost > 0).length;
  if (successCost >= 4 && b !== null && b < balanceBefore) return { rows, b };
  return null;
}, 120000);
report("delayed settlement: 4 success rows + balance decreased", settled !== null, settled ? `rows=${settled.rows.filter((r) => r.status === "success").length} balance=${settled.b}` : "timeout");
report("all settled rows have cost > 0", settled !== null && settled.rows.every((r) => r.status !== "success" || r.cost > 0), `costs=${JSON.stringify(settled?.rows.map((r) => r.cost))}`);
report("settled rows cover all 4 models", settled !== null && ["deepseek-v4-flash", "qwen3.8-flash", "glm-5.3-flash", "hy3"].every((m) => settled.rows.some((r) => r.model === m)), `models=${JSON.stringify(settled?.rows.map((r) => r.model))}`);

// [8] 错误形态跟随：401 + openai 体 → OpenAI 形态；401 + anthropic 体 → Anthropic 形态
const badKey401 = await api("/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer sk-invalid-proto" },
  body: { model: Q, messages: [{ role: "user", content: "x" }] },
});
report("401 + openai body → OpenAI shape", badKey401.status === 401 && badKey401.json?.type === undefined && badKey401.json?.error?.message, `status=${badKey401.status} body=${JSON.stringify(badKey401.json)}`);
const badKeyAnthro = await api("/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", Authorization: "Bearer sk-invalid-proto" },
  body: { model: D, max_tokens: 128, messages: [{ role: "user", content: "x" }] },
});
report("401 + anthropic body → Anthropic shape", badKeyAnthro.status === 401 && badKeyAnthro.json?.type === "error" && badKeyAnthro.json?.error?.type === "authentication_error", `status=${badKeyAnthro.status} body=${JSON.stringify(badKeyAnthro.json)}`);

console.log(`\n=== stg E2E protocol auto-detect: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("\nFailed checks:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
