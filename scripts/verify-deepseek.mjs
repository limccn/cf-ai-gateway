// 真实上游全链路验证（DeepSeek，OpenAI 兼容面）：
// 前置：`npm run dev` 已启动；本脚本通过管理 API 配置 deepseek provider
// （key 从环境变量 DEEPSEEK_API_KEY 读取，绝不落盘/入 git），然后验证四个
// 协议入口 × 非流式/流式对 deepseek-v4-flash / deepseek-v4-pro 的连通。
// 用法：DEEPSEEK_API_KEY=<key> node scripts/verify-deepseek.mjs [--models deepseek-v4-flash,deepseek-v4-pro]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const DB_NAME = "cf-ai-gateway-db";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODELS = (process.argv.find((a) => a.startsWith("--models=")) ?? "--models=deepseek-v4-flash,deepseek-v4-pro")
  .split("=")[1].split(",");
const ADMIN_EMAIL = "proto-admin@example.com";
const PASSWORD = "testpass123";

if (!DEEPSEEK_KEY) {
  console.error("DEEPSEEK_API_KEY env var required (not logged, not persisted)");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];
function report(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  <- ${detail}` : ""}`); }
}

const WRANGLER_JS = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
function query(sql) {
  const out = execFileSync(process.execPath, [WRANGLER_JS, "d1", "execute", DB_NAME, "--local", "--command", sql, "--json"], { stdio: "pipe", encoding: "utf8" });
  return JSON.parse(out)[0]?.results ?? [];
}
const balanceSql = () => query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;

async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
  const finalHeaders = { ...headers };
  if (cookie) finalHeaders.Cookie = cookie;
  if (body !== undefined) finalHeaders["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: finalHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (error) {
    console.log(`  [retry] ${method} ${path} (${error.cause?.code ?? error.message})`);
    await new Promise((r) => setTimeout(r, 500));
    res = await fetch(BASE + path, { method, headers: finalHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookieOut = setCookies.length > 0
    ? setCookies.map((c) => c.split(";")[0]).filter((c) => c.includes("=")).join("; ")
    : null;
  return { status: res.status, json, text, cookie: cookieOut };
}

const ORIGIN = new URL(BASE).origin;
function parseSse(text) {
  const events = [];
  let current = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) current.event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data === "[DONE]") current.done = true;
      else { try { current.data = JSON.parse(data); } catch { current.raw = data; } }
      events.push(current);
      current = {};
    }
  }
  return events;
}

async function main() {
  console.log(`\n=== DeepSeek real-upstream verify @ ${BASE} (models: ${MODELS.join(",")}) ===`);

  // ---------- 1. 登录 + 配置 provider/价格/key ----------
  console.log("\n[1] auth + configure deepseek provider");
  const signinRes = await api("/api/auth/sign-in/email", {
    method: "POST", headers: { Origin: ORIGIN },
    body: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  report("admin signin", signinRes.status === 200 && signinRes.cookie !== null, `status=${signinRes.status}`);
  if (!signinRes.cookie) {
    console.log("  (bootstrap admin missing — run scripts/verify-protocols.mjs once first)");
    process.exit(1);
  }
  const authApi = { cookie: signinRes.cookie };

  // provider upsert（POST 幂等：先删同名再建，避免 409 残留）。
  // 双面配置：OpenAI 协议（chat/responses）→ /v1（type=openai）；
  // Anthropic 协议（messages）→ /anthropic 原生端点（type=anthropic，协议偏好路由）。
  const existing = await api("/api/providers", authApi);
  for (const p of (existing.json?.items ?? [])) {
    if (p.name.startsWith("deepseek-")) {
      await api(`/api/providers/${p.id}`, { method: "DELETE", ...authApi });
    }
  }
  const PROVIDER_BODIES = [
    { name: "deepseek-openai", type: "openai", baseUrl: "https://api.deepseek.com/v1" },
    { name: "deepseek-anthropic", type: "anthropic", baseUrl: "https://api.deepseek.com/anthropic" },
  ];
  for (const p of PROVIDER_BODIES) {
    const createProvider = await api("/api/providers", {
      method: "POST", ...authApi,
      body: {
        name: p.name, type: p.type, baseUrl: p.baseUrl,
        apiKey: DEEPSEEK_KEY,
        models: Object.fromEntries(MODELS.map((m) => [m, m])),
      },
    });
    report(`create provider ${p.name} (${p.type})`, createProvider.status === 200, `status=${createProvider.status}`);
  }
  const providersList = await api("/api/providers", authApi);
  const openaiProviderId = (providersList.json?.items ?? []).find((p) => p.name === "deepseek-openai")?.id;
  const anthropicProviderId = (providersList.json?.items ?? []).find((p) => p.name === "deepseek-anthropic")?.id;
  report("provider ids resolved", openaiProviderId !== undefined && anthropicProviderId !== undefined, `openai=${openaiProviderId} anthropic=${anthropicProviderId}`);

  // 价格 upsert：POST 409 时 PATCH
  for (const model of MODELS) {
    const createPrice = await api("/api/models", { method: "POST", ...authApi, body: { model, inputPriceShort: 1, inputPriceLong: 1, inputPriceCached: 0.25, outputPriceShort: 2, outputPriceLong: 2 } });
    if (createPrice.status === 409) {
      const list = await api("/api/models", authApi);
      const found = (list.json?.items ?? []).find((m) => m.model === model);
      if (found) await api(`/api/models/${found.id}`, { method: "PATCH", ...authApi, body: { inputPriceShort: 1, outputPriceShort: 2 } });
    }
    report(`price table ${model}`, createPrice.status === 200 || createPrice.status === 409, `status=${createPrice.status}`);
  }

  const userList = await api("/api/users", authApi);
  const adminUserId = (userList.json?.items ?? []).find((u) => u.email === ADMIN_EMAIL)?.id;
  const balanceNow = await api(`/api/users/${adminUserId}`, authApi).then((r) => r.json?.balance);
  if (balanceNow < 1) {
    await api(`/api/users/${adminUserId}/balance`, { method: "POST", ...authApi, body: { amount: 5, note: "deepseek verify credit" } });
  }
  const createKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "deepseek-key" } });
  const plaintext = createKey.json?.plaintext ?? "";
  report("create gateway key", createKey.status === 200 && plaintext.startsWith("sk-"), `status=${createKey.status}`);
  const proxyAuth = { Authorization: `Bearer ${plaintext}` };
  const balance0 = balanceSql();

  const expectCharged = (name, before) => {
    const after = balanceSql();
    report(`${name} (charged)`, after !== before && after < before, `before=${before} after=${after}`);
    return after;
  };

  // ---------- 2. 四协议入口 × 非流式/流式 ----------
  for (const model of MODELS) {
    console.log(`\n[2] ${model}`);
    const msg = { model, messages: [{ role: "user", content: "请用一句话介绍你自己" }] };

    let b = balanceSql();
    const chat = await api("/v1/chat/completions", { method: "POST", headers: proxyAuth, body: msg });
    report("chat non-stream 200 + content", chat.status === 200 && chat.json?.choices?.[0]?.message?.content?.length > 0, `status=${chat.status} ${JSON.stringify(chat.json?.error ?? chat.json?.choices?.[0]?.message?.content?.slice(0, 40))}`);
    b = expectCharged("chat non-stream", b);
    report("usage present", chat.json?.usage?.prompt_tokens > 0 && chat.json?.usage?.completion_tokens > 0, JSON.stringify(chat.json?.usage));

    const chatStream = await api("/v1/chat/completions", { method: "POST", headers: proxyAuth, body: { ...msg, stream: true } });
    const chatEvents = parseSse(chatStream.text);
    report("chat stream SSE + [DONE]", chatStream.status === 200 && chatEvents.some((e) => e.done) && chatEvents.some((e) => e.data?.choices?.[0]?.delta?.content), `events=${chatEvents.length}`);
    const usageTail = chatEvents.find((e) => e.data?.usage);
    report("chat stream usage tail", usageTail?.data?.usage?.prompt_tokens > 0, usageTail ? JSON.stringify(usageTail.data.usage) : "no usage tail (DeepSeek needs stream_options.include_usage?)");
    b = expectCharged("chat stream", b);

    // v4-pro 是推理模型：max_tokens 需留足推理余量，否则全部被 reasoning 耗尽
    // （content 返回空串 + finish_reason=length），Anthropic 面产出合法空 content: []
    const anthBody = { model, max_tokens: 1024, messages: [{ role: "user", content: "请用一句话介绍你自己" }] };
    const msgV1 = await api("/v1/messages", { method: "POST", headers: proxyAuth, body: anthBody });
    report("/v1/messages Anthropic form", msgV1.status === 200 && msgV1.json?.type === "message" && msgV1.json?.content?.[0]?.text?.length > 0, `status=${msgV1.status} ${JSON.stringify(msgV1.json?.error ?? msgV1.json)?.slice(0, 220)}`);
    b = expectCharged("/v1/messages non-stream", b);

    const msgStream = await api("/v1/messages", { method: "POST", headers: proxyAuth, body: { ...anthBody, stream: true } });
    const msgEvents = parseSse(msgStream.text);
    report("/v1/messages stream events", msgStream.status === 200 && msgEvents.some((e) => e.event === "message_start") && msgEvents.some((e) => e.event === "message_stop"), `events=${msgEvents.length}`);
    const md = msgEvents.find((e) => e.event === "message_delta");
    report("/v1/messages stream usage (output_tokens>0)", md?.data?.usage?.output_tokens > 0, JSON.stringify(md?.data?.usage));
    b = expectCharged("/v1/messages stream", b);

    const respBody = { model, input: "请用一句话介绍你自己" };
    const resp = await api("/v1/responses", { method: "POST", headers: proxyAuth, body: respBody });
    report("/v1/responses Response form", resp.status === 200 && resp.json?.object === "response" && resp.json?.status === "completed" && resp.json?.output_text?.length > 0, `status=${resp.status} ${JSON.stringify(resp.json?.error ?? resp.json?.usage)}`);
    b = expectCharged("/v1/responses non-stream", b);

    const respStream = await api("/v1/responses", { method: "POST", headers: proxyAuth, body: { ...respBody, stream: true } });
    const respEvents = parseSse(respStream.text);
    report("/v1/responses stream completed", respStream.status === 200 && respEvents.some((e) => e.data?.type === "response.completed") && !respEvents.some((e) => e.done), `events=${respEvents.length}`);
    const completed = respEvents.find((e) => e.data?.type === "response.completed");
    report("/v1/responses stream usage", completed?.data?.response?.usage?.input_tokens > 0, JSON.stringify(completed?.data?.response?.usage));
    b = expectCharged("/v1/responses stream", b);
  }

  // ---------- 3. 协议感知路由：Anthropic 面 → /anthropic provider，OpenAI 面 → /v1 provider ----------
  console.log("\n[3] protocol-aware provider routing");
  for (const model of MODELS) {
    const logs = query(
      `SELECT provider_id, status FROM request_logs WHERE model='${model}' AND status='success' ORDER BY id DESC LIMIT 30;`,
    );
    const openaiHits = logs.filter((l) => String(l.provider_id) === String(openaiProviderId));
    const anthropicHits = logs.filter((l) => String(l.provider_id) === String(anthropicProviderId));
    // OpenAI 面 4 次（chat 非流/流 + responses 非流/流）、Anthropic 面 2 次（messages 非流/流）
    report(`${model}: OpenAI-face → openai provider (/v1)`, openaiHits.length >= 4, `hits=${openaiHits.length}`);
    report(`${model}: Anthropic-face → anthropic provider (/anthropic)`, anthropicHits.length >= 2, `hits=${anthropicHits.length}`);
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failed:", failures.join(" | "));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Script error:", error);
  process.exitCode = 1;
});
