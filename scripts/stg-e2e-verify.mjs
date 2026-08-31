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
// 本次运行起点的最大 request_log id：只校验本轮新增行（重复运行会残留旧行，request_id 列迁移前为 NULL）
const MAX_ID_BEFORE = query(`SELECT COALESCE(MAX(id),0) AS m FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${MEMBER_EMAIL}');`)[0]?.m ?? 0;
// request_id：成功计费行携带幂等键（生产 = cf-ray，见 proxy.ts；错误/失败尝试行为 NULL）
const logs = () => query(`SELECT status, model, provider_id, cost, prompt_tokens, completion_tokens, request_id FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${MEMBER_EMAIL}') AND id > ${MAX_ID_BEFORE} ORDER BY id DESC LIMIT 12;`);

// 延迟计费（perf-v2）：响应先回，明细+扣费由 BILLING_QUEUE 消费者异步落定 → 轮询 D1
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, timeoutMs = 20000, intervalMs = 400) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(intervalMs);
  }
}
console.log(`=== stg E2E @ ${BASE} (model: ${MODEL}) ===`);

// [1] 健康 + 模型
const health = await api("/api/health", { headers: {} });
report("health ok", health.status === 200 && health.json?.ok === true, `status=${health.status}`);
const models = await api("/v1/models");
report("/v1/models 200 + model listed", models.status === 200 && models.json?.data?.some((m) => m.id === MODEL), `status=${models.status}`);

const balanceBefore = balanceOf();
report("member balance seed > 0", balanceBefore > 0, `balance=${balanceBefore}`);

// 本轮 nonce：face 请求体全部带 run 唯一标记 → 请求体跨 run 唯一。
// （固定请求体会跨 run 命中 R2 缓存（缓存键=完整请求体，KV TTL 1h），命中不产生计费事件 → [8] 计费断言失效）
// 注意用 base36 短词而非原始时间戳：实测 b.ai 上游对超长数字 prompt（如 1755720333）会陷入 reasoning、
// max_tokens=64 下返回空流（/v1/messages stream 无 content_block_delta）——数字大小是触发因素。
const NONCE = Date.now().toString(36);

// [2] chat completions 非流式（真实 DeepSeek 上游）
const chat = await api("/v1/chat/completions", { method: "POST", body: { model: MODEL, messages: [{ role: "user", content: `Reply with exactly: PONG-${NONCE}` }] } });
report("chat non-stream 200 + content", chat.status === 200 && chat.json?.choices?.[0]?.message?.content?.length > 0, `status=${chat.status} content=${chat.json?.choices?.[0]?.message?.content?.slice(0, 40)}`);
report("chat non-stream usage present", chat.status === 200 && chat.json?.usage?.total_tokens > 0, `usage=${JSON.stringify(chat.json?.usage)}`);

// [3] chat 流式
const chatStream = await api("/v1/chat/completions", { method: "POST", body: { model: MODEL, stream: true, messages: [{ role: "user", content: `Count 1 to 3 (${NONCE})` }] } });
const streamEvents = parseSse(chatStream.text);
report("chat stream SSE + [DONE]", chatStream.status === 200 && hasDone(chatStream.text) && streamEvents.length >= 2, `events=${streamEvents.length}`);
const usageTail = [...streamEvents].reverse().find((e) => e.usage);
report("chat stream usage tail", !!usageTail && usageTail.usage.total_tokens > 0, `tail=${JSON.stringify(usageTail?.usage)}`);

// [4] Anthropic 面（/v1/messages → 路由到 anthropic provider 原生 /anthropic）
// max_tokens=128：b.ai deepseek-v4-flash 在 64 下随机空流（reasoning 吃掉预算 → 0 deltas），128+ 稳定出内容（实测 6/6）
const msg = await api("/v1/messages", { method: "POST", headers: { "anthropic-version": "2023-06-01" }, body: { model: MODEL, max_tokens: 128, messages: [{ role: "user", content: `Reply with exactly: ANTHRO-${NONCE}` }] } });
const msgText = msg.json?.content?.[0]?.text ?? "";
report("/v1/messages Anthropic form", msg.status === 200 && msgText.includes("ANTHRO-"), `status=${msg.status} content=${msgText.slice(0, 40)}`);
report("/v1/messages usage", msg.json?.usage?.output_tokens > 0, `usage=${JSON.stringify(msg.json?.usage)}`);

// [5] Anthropic 面流式
const msgStream = await api("/v1/messages", { method: "POST", headers: { "anthropic-version": "2023-06-01" }, body: { model: MODEL, max_tokens: 128, stream: true, messages: [{ role: "user", content: `Count 1 to 3 (${NONCE})` }] } });
const msgEvents = parseSse(msgStream.text);
report("/v1/messages stream events", msgStream.status === 200 && msgEvents.some((e) => e.type === "content_block_delta") && msgEvents.some((e) => e.type === "message_stop"), `events=${msgEvents.length}`);

// [6] Responses 面
const resp = await api("/v1/responses", { method: "POST", body: { model: MODEL, input: `Reply with exactly: RESP-${NONCE}` } });
report("/v1/responses 200 + output_text", resp.status === 200 && (resp.json?.output_text ?? "").includes("RESP-"), `status=${resp.status} out=${String(resp.json?.output_text ?? "").slice(0, 40)}`);
const respStream = await api("/v1/responses", { method: "POST", body: { model: MODEL, stream: true, input: `Count 1 to 3 (${NONCE})` } });
const respEvents = parseSse(respStream.text);
report("/v1/responses stream completed", respStream.status === 200 && respEvents.some((e) => e.type === "response.completed"), `events=${respEvents.length}`);

// [7] 错误形态
const badKey = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { Authorization: "Bearer sk-wrong-key", "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }) });
const badKeyJson = await badKey.json().catch(() => null);
report("wrong key → 401 OpenAI form", badKey.status === 401 && badKeyJson?.error?.message?.length > 0, `status=${badKey.status}`);
const noModel = await api("/v1/chat/completions", { method: "POST", body: { model: "no-such-model-xyz", messages: [{ role: "user", content: "hi" }] } });
report("unknown model → 404", noModel.status === 404, `status=${noModel.status} body=${String(noModel.json?.error?.message ?? "").slice(0, 60)}`);

// [8] 计费落账（延迟计费：响应已回，明细+扣费由 BILLING_QUEUE 消费者异步落定 → 轮询）
// 时序说明：consumer 按批顺序处理（每消息 4-5 次 D1 调用），低流量时批间轮询间隔 30-40s，
// 积压下更久；PRD R3 明确"分钟级延迟可接受" → settle 断言窗口 120s。
const settled = await poll(() => {
  const rows = logs();
  const successCost = rows.filter((r) => r.status === "success" && r.cost > 0).length;
  const b = balanceOf();
  if (successCost >= 6 && b < balanceBefore) return { rows, b };
  return null;
}, 120000);
report("delayed billing settled (≥6 success rows, balance decreased)", settled !== null, `rows=${settled?.rows.length} before=${balanceBefore} after=${settled?.b}`);
report("success rows carry request_id (幂等键, 生产 = cf-ray)", settled !== null && settled.rows.filter((r) => r.status === "success").every((r) => r.request_id !== null), `sample=${settled?.rows.find((r) => r.status === "success")?.request_id}`);
// 路由归属：各请求面应落到服务该模型的 provider（multi-upstream：同模型可多 provider 负载分流，全部合法；
// 查询限定服务集——全局 DISTINCT 会被其他用户的日志污染）
const SERVING = new Set(query(`SELECT id FROM providers WHERE models LIKE '%"${MODEL}"%';`).map((r) => r.id));
const routedRows = (settled?.rows ?? []).filter((r) => r.model === MODEL && r.status === "success" && r.cost > 0);
const routedProviders = [...new Set(routedRows.map((r) => r.provider_id))];
report("routing: all faces → model-serving provider", routedRows.length >= 3 && routedProviders.length >= 1 && routedProviders.every((p) => SERVING.has(p)), `rows=${routedRows.length} providers=${routedProviders.join(",")}`);

// [9] 缓存（R2 收窄：第 1 次只计数、第 2 次达阈值写缓存、第 3 次命中不转发不扣费）
// 缓存体带时间戳：保证每次运行用全新缓存键（KV 缓存 TTL 1h，固定内容会跨运行命中）
const cacheBody = { model: MODEL, messages: [{ role: "user", content: `Cache me please ${Date.now()}` }] };
// 先等所有 face 扣费落定（余额稳定）再记录缓存段起点 —— 否则 face 的迟到扣费会污染 miss 断言
const cacheBefore = await poll(async () => {
  const b1 = balanceOf();
  if (b1 === null) return null;
  await sleep(800);
  const b2 = balanceOf();
  return b1 === b2 ? b1 : null;
}, 60000);
// 发 miss 前先采样 missBefore：消费侧恰在响应完成后写明细，若响应后再读会竞态（可能已含 miss 行 → +2 永不满足）
const missBefore = logs().filter((r) => r.status === "success" && r.cost > 0).length;
const miss1 = await api("/v1/chat/completions", { method: "POST", body: cacheBody });
const miss2 = await api("/v1/chat/completions", { method: "POST", body: cacheBody });
// 真实上游 LLM 非确定性：不比较 miss1/miss2 内容相等（仅断言非空），缓存体以 miss2 为准
const miss1Content = miss1.json?.choices?.[0]?.message?.content ?? "";
const miss2Content = miss2.json?.choices?.[0]?.message?.content ?? "";
report("cache miss #1/#2 → 200 + content (第1次只计数, 第2次写缓存)", miss1.status === 200 && miss2.status === 200 && miss1Content.length > 0 && miss2Content.length > 0, `status=${miss1.status}/${miss2.status} len=${miss1Content.length}/${miss2Content.length}`);
// 两次 miss 均扣费（延迟落定）：确定性判据 = 本轮 success+cost 行数比 miss 前多 2（消费侧写明细即扣费），
// 且余额已低于起点、连续两次取样一致（该批已处理完，无迟到扣费）

const twoMissSettled = await poll(async () => {
  const rows = logs();
  if (rows.filter((r) => r.status === "success" && r.cost > 0).length < missBefore + 2) return null;
  const b = balanceOf();
  if (b === null || b >= cacheBefore) return null;
  await sleep(800);
  return b === balanceOf() ? b : null;
}, 120000);
report("2 cache misses charged (delayed)", twoMissSettled !== null, `before=${cacheBefore} after=${twoMissSettled}`);
// 第 3 次 → 命中：不转发不扣费，明细记 cached。
// R2 写入走 waitUntil（响应后异步 fire-and-forget）：miss2 的写缓存未落盘时紧跟的请求会竞态 miss
// （实测偶发：miss3 被转发上游 + 延迟扣费 → 缓存命中断言失效）→ 先等写入完成再发 hit。
await sleep(4000);
const hit = await api("/v1/chat/completions", { method: "POST", body: cacheBody });
const hitSettled = await poll(async () => {
  const b1 = balanceOf();
  await sleep(600);
  const b2 = balanceOf();
  return b1 === b2 ? b1 : null;
}, 15000);
report("cache hit #3 → 200 + replays cached body", hit.status === 200 && (hit.json?.choices?.[0]?.message?.content ?? "") === miss2Content, `status=${hit.status} len=${(hit.json?.choices?.[0]?.message?.content ?? "").length}`);
report("cache hit not charged", hitSettled !== null && hitSettled === twoMissSettled, `before=${twoMissSettled} after=${hitSettled}`);
const cachedLog = query(`SELECT status FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${MEMBER_EMAIL}') AND status='cached' AND id > ${MAX_ID_BEFORE} ORDER BY id DESC LIMIT 1;`);
report("D1: request_logs cached", cachedLog.length === 1 && cachedLog[0].status === "cached", JSON.stringify(cachedLog[0]));

// [10] 管理 API 边界（无会话 → 401；绕过认证后管理面由 D1 直查验证）
const adminNoSession = await fetch(`${BASE}/api/users`, { headers: {} });
report("admin API no session → 401", adminNoSession.status === 401, `status=${adminNoSession.status}`);

console.log(`=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed) console.log("failures:", failures.join(" | "));
process.exit(failed ? 1 : 0);
