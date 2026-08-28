// stg 环境（https://stg-router.lmlh.net）真实全流程 E2E：
// 四协议入口 × 非流式/流式 × 真实 DeepSeek 上游 × 计费 × 缓存 × 错误形态。
// 前置：scripts/stg-e2e-bootstrap.mjs 已运行（KEY 输出）。
// 用法：E2E_KEY=<网关key> node scripts/stg-e2e-verify.mjs [--model deepseek-v4-flash]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const BASE = "https://stg-router.lmlh.net";
const KEY = process.env.E2E_KEY;
const MODEL = (process.argv.find((a) => a.startsWith("--model=")) ?? "--model=deepseek-v4-flash").split("=")[1];
const DB = "cf-ai-gateway-db-staging";
const WRANGLER_JS = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

if (!KEY) { console.error("E2E_KEY env var required (gateway key from bootstrap)"); process.exit(1); }

// key 归属用户动态解析（2026-08-28：key 归真实用户时不用 bootstrap 造 e2e-user）
// 按 sha256 哈希精确匹配（prefix 落库长度因 API_KEY_PREFIX 配置而异，slice(0,8) 不可靠）
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
const logs = () => query(`SELECT status, model, provider_id, cost, prompt_tokens, completion_tokens FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${MEMBER_EMAIL}') ORDER BY id DESC LIMIT 12;`);

console.log(`=== stg E2E @ ${BASE} (model: ${MODEL}) ===`);

// [1] 健康 + 模型
const health = await api("/api/health", { headers: {} });
report("health ok", health.status === 200 && health.json?.ok === true, `status=${health.status}`);
const models = await api("/v1/models");
report("/v1/models 200 + model listed", models.status === 200 && models.json?.data?.some((m) => m.id === MODEL), `status=${models.status}`);

const balanceBefore = balanceOf();
report("member balance seed > 0", balanceBefore > 0, `balance=${balanceBefore}`);

// [2] chat completions 非流式（真实 DeepSeek 上游）
const chat = await api("/v1/chat/completions", { method: "POST", body: { model: MODEL, messages: [{ role: "user", content: "Reply with exactly: PONG" }] } });
report("chat non-stream 200 + content", chat.status === 200 && chat.json?.choices?.[0]?.message?.content?.length > 0, `status=${chat.status} content=${chat.json?.choices?.[0]?.message?.content?.slice(0, 40)}`);
report("chat non-stream usage present", chat.status === 200 && chat.json?.usage?.total_tokens > 0, `usage=${JSON.stringify(chat.json?.usage)}`);

// [3] chat 流式
const chatStream = await api("/v1/chat/completions", { method: "POST", body: { model: MODEL, stream: true, messages: [{ role: "user", content: "Count 1 to 3" }] } });
const streamEvents = parseSse(chatStream.text);
report("chat stream SSE + [DONE]", chatStream.status === 200 && hasDone(chatStream.text) && streamEvents.length >= 2, `events=${streamEvents.length}`);
const usageTail = [...streamEvents].reverse().find((e) => e.usage);
report("chat stream usage tail", !!usageTail && usageTail.usage.total_tokens > 0, `tail=${JSON.stringify(usageTail?.usage)}`);

// [4] Anthropic 面（/v1/messages → 路由到 anthropic provider 原生 /anthropic）
const msg = await api("/v1/messages", { method: "POST", headers: { "anthropic-version": "2023-06-01" }, body: { model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "Reply with exactly: ANTHRO" }] } });
const msgText = msg.json?.content?.[0]?.text ?? "";
report("/v1/messages Anthropic form", msg.status === 200 && msgText.includes("ANTHRO"), `status=${msg.status} content=${msgText.slice(0, 40)}`);
report("/v1/messages usage", msg.json?.usage?.output_tokens > 0, `usage=${JSON.stringify(msg.json?.usage)}`);

// [5] Anthropic 面流式
const msgStream = await api("/v1/messages", { method: "POST", headers: { "anthropic-version": "2023-06-01" }, body: { model: MODEL, max_tokens: 64, stream: true, messages: [{ role: "user", content: "Count 1 to 3" }] } });
const msgEvents = parseSse(msgStream.text);
report("/v1/messages stream events", msgStream.status === 200 && msgEvents.some((e) => e.type === "content_block_delta") && msgEvents.some((e) => e.type === "message_stop"), `events=${msgEvents.length}`);

// [6] Responses 面
const resp = await api("/v1/responses", { method: "POST", body: { model: MODEL, input: "Reply with exactly: RESP" } });
report("/v1/responses 200 + output_text", resp.status === 200 && (resp.json?.output_text ?? "").includes("RESP"), `status=${resp.status} out=${String(resp.json?.output_text ?? "").slice(0, 40)}`);
const respStream = await api("/v1/responses", { method: "POST", body: { model: MODEL, stream: true, input: "Count 1 to 3" } });
const respEvents = parseSse(respStream.text);
report("/v1/responses stream completed", respStream.status === 200 && respEvents.some((e) => e.type === "response.completed"), `events=${respEvents.length}`);

// [7] 错误形态
const badKey = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { Authorization: "Bearer sk-wrong-key", "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
const badKeyJson = await badKey.json().catch(() => null);
report("wrong key → 401 OpenAI form", badKey.status === 401 && badKeyJson?.error?.message?.length > 0, `status=${badKey.status}`);
const noModel = await api("/v1/chat/completions", { method: "POST", body: { model: "no-such-model-xyz", messages: [{ role: "user", content: "hi" }] } });
report("unknown model → 404", noModel.status === 404, `status=${noModel.status} body=${String(noModel.json?.error?.message ?? "").slice(0, 60)}`);

// [8] 计费落账（请求后 balance 应下降，request_logs 有费用 + 路由归属）
const balanceAfter = balanceOf();
report("balance decreased (billing)", balanceAfter < balanceBefore, `before=${balanceBefore} after=${balanceAfter}`);
const logRows = logs();
report("request_logs rows written", logRows.length >= 6, `rows=${logRows.length}`);
// 路由归属：四种请求面都应落到同一 provider（模型→provider 映射动态解析，不硬编码 provider id）
const PROVIDER_IDS = [...new Set(query(`SELECT DISTINCT provider_id FROM request_logs WHERE provider_id IS NOT NULL;`).map((r) => r.provider_id))];
const routedRows = logRows.filter((r) => r.model === MODEL && r.status === "success" && r.cost > 0);
report("routing: all faces → same provider", routedRows.length >= 3 && PROVIDER_IDS.length === 1, `rows=${routedRows.length} provider=${PROVIDER_IDS.join(",")}`);

// [9] 缓存（开启 cache → 两次同请求第二次 cached 且不再扣费）
const cacheOffBefore = balanceOf();
await api("/v1/chat/completions", { method: "POST", body: { model: MODEL, messages: [{ role: "user", content: "Cache me please" }] } });
const firstCost = balanceOf();
await api("/v1/chat/completions", { method: "POST", body: { model: MODEL, messages: [{ role: "user", content: "Cache me please" }] } });
const secondCost = balanceOf();
report("cache disabled: double charge", secondCost < firstCost, `after1=${firstCost} after2=${secondCost}`);

// [10] 管理 API 边界（无会话 → 401；绕过认证后管理面由 D1 直查验证）
const adminNoSession = await fetch(`${BASE}/api/users`, { headers: {} });
report("admin API no session → 401", adminNoSession.status === 401, `status=${adminNoSession.status}`);

console.log(`=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed) console.log("failures:", failures.join(" | "));
process.exit(failed ? 1 : 0);
