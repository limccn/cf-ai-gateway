// stg 环境（https://stg-router.lmlh.net）真实模型矩阵验证：
// 双入口（/v1 OpenAI 形态、/anthropic Anthropic 形态）× 各协议模型列表，
// 每 10s 发送一次请求，逐个上报 PASS/FAIL。
// 用法：E2E_KEY=<网关key> node scripts/verify-stg-models.mjs
import { fileURLToPath } from "node:url";

const BASE = "https://stg-router.lmlh.net";
const KEY = process.env.E2E_KEY;
const INTERVAL_MS = 10_000; // 每 10s 一个请求
const TIMEOUT_MS = 120_000; // 单请求超时（慢上游兜底）
const PROMPT = "Reply with exactly: PONG"; // 统一小请求，控制成本

const V1_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
  "hy3",
  "glm-5.3-flash",
  "glm-5.3",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "qwen3.8-flash",
  "qwen3.8-27b",
  "qwen3.8-max",
  "kimi-k2.6",
  "kimi-k3",
];
const ANTHRO_MODELS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4.8",
  "claude-sonnet-4.6",
  "claude-haiku-4.5",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
  "glm-5.3-flash",
  "glm-5.3",
  "qwen3.8-flash",
  "qwen3.8-27b",
  "qwen3.8-max",
  "kimi-k2.6",
  "kimi-k3",
];

if (!KEY) {
  console.error("E2E_KEY env var required (gateway key)");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 节奏器：保证相邻两次请求的发出时刻 ≥ 10s（请求耗时不阻塞后续节奏）
let nextSlot = Date.now();
async function pace() {
  nextSlot = Math.max(nextSlot, Date.now()) + INTERVAL_MS;
  const wait = nextSlot - Date.now();
  if (wait > 0) await sleep(wait);
}

let passed = 0, failed = 0;
const failures = [];
const seen = new Map(); // model -> 结果摘要（去重计数，深居两表）

async function send(entry, model) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(entry === "v1"
      ? `${BASE}/v1/chat/completions`
      : `${BASE}/anthropic/v1/messages`, {
      method: "POST",
      headers: entry === "v1"
        ? { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }
        : { "x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(entry === "v1"
        ? { model, messages: [{ role: "user", content: PROMPT }] }
        : { model, max_tokens: 128, messages: [{ role: "user", content: PROMPT }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { status: 0, detail: `network/timeout: ${error.cause?.code ?? error.message}`, latencyMs: Date.now() - started };
  }
  const latencyMs = Date.now() - started;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE/空体 */ }

  if (res.status === 200) {
    const content = entry === "v1"
      ? json?.choices?.[0]?.message?.content ?? ""
      : json?.content?.find?.((b) => b.type === "text")?.text ?? "";
    if (content && content.length > 0) return { status: 200, content: content.slice(0, 30), latencyMs };
    return { status: 200, detail: `empty content body=${text.slice(0, 120)}`, latencyMs };
  }
  const errMsg = entry === "v1"
    ? json?.error?.message ?? text.slice(0, 120)
    : json?.error?.message ?? json?.error?.type ?? text.slice(0, 120);
  return { status: res.status, detail: String(errMsg).slice(0, 120), latencyMs };
}

async function runEntry(label, entry, models) {
  console.log(`\n=== ${label} @ ${BASE} (${models.length} models) ===`);
  for (const model of models) {
    const r = await send(entry, model);
    const tag = r.status === 200 ? "PASS" : "FAIL";
    if (r.status === 200) passed += 1;
    else { failed += 1; failures.push(`${label}:${model} (${r.status})`); }
    const summary = r.content ? `"${r.content}"` : r.detail ?? "";
    console.log(`  ${tag}  ${label.padEnd(10)} ${model.padEnd(26)} ${r.status} ${(r.latencyMs / 1000).toFixed(1)}s ${summary}`);
    if (!seen.has(model)) seen.set(model, { total: 0, pass: 0 });
    const s = seen.get(model);
    s.total += 1;
    if (r.status === 200) s.pass += 1;
    await pace(); // 下一次请求前等满 10s
  }
}

const startedAt = Date.now();
console.log(`stg model matrix verify @ ${BASE} (interval=${INTERVAL_MS / 1000}s, key=${KEY.slice(0, 8)}…)`);
await runEntry("/v1", "v1", V1_MODELS);
await runEntry("/anthropic", "ant", ANTHRO_MODELS);

const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
console.log(`\n=== RESULT: ${passed} passed, ${failed} failed (${minutes} min) ===`);
const dup = [...seen.entries()].filter(([, s]) => s.total > 1);
if (dup.length) {
  console.log("双入口共用模型（应全 PASS）：");
  for (const [m, s] of dup) console.log(`  ${m}: ${s.pass}/${s.total} PASS`);
}
if (failed) console.log("failures:", failures.join(" | "));
process.exit(failed ? 1 : 0);
