// 真实上游全链路验证（DeepSeek，OpenAI 兼容面）：
// 前置：`npm run dev` 已启动；本脚本通过管理 API 配置 deepseek provider
// （key 从环境变量 DEEPSEEK_API_KEY 读取，绝不落盘/入 git），然后验证四个
// 协议入口 × 非流式/流式对 deepseek-v4-flash / deepseek-v4-pro 的连通。
// 用法：DEEPSEEK_API_KEY=<key> node scripts/verify-deepseek.mjs [--models deepseek-v4-flash,deepseek-v4-pro] [--disguise <requestModel>]
//   --disguise <requestModel>：伪装模式 —— provider 映射 { <requestModel>: MODELS[0] }，
//   请求 <requestModel> 实际送 MODELS[0] 真实上游，断言响应 model 回写为 <requestModel>
//   （非流式 + 流式 + /v1/messages + /v1/responses + request_logs 按内部名）。
import { createHarness, createD1, parseSse, poll } from "./lib/e2e-utils.mjs";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODELS = (process.argv.find((a) => a.startsWith("--models=")) ?? "--models=deepseek-v4-flash,deepseek-v4-pro")
  .split("=")[1].split(",");
const DISGUISE = process.argv.find((a) => a.startsWith("--disguise="))?.split("=")[1] ?? null;
const ADMIN_EMAIL = "proto-admin@example.com";
const PASSWORD = "testpass123";

if (!DEEPSEEK_KEY) {
  console.error("DEEPSEEK_API_KEY env var required (not logged, not persisted)");
  process.exit(1);
}

const { api, report, summary, base, origin } = createHarness({ label: "DeepSeek" });
const { query } = createD1();
const balanceSql = () => query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;

async function main() {
  console.log(`\n=== DeepSeek real-upstream verify @ ${base} (models: ${MODELS.join(",")}) ===`);

  // ---------- 1. 登录 + 配置 provider/价格/key ----------
  console.log("\n[1] auth + configure deepseek provider");
  const signinRes = await api("/api/auth/sign-in/email", {
    method: "POST", headers: { Origin: origin },
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
        // 恒等映射（基线）；--disguise 时伪造成 { requestModel → MODELS[0] }
        models: DISGUISE
          ? { [DISGUISE]: MODELS[0] }
          : Object.fromEntries(MODELS.map((m) => [m, m])),
      },
    });
    report(`create provider ${p.name} (${p.type})`, createProvider.status === 200, `status=${createProvider.status}`);
  }
  const providersList = await api("/api/providers", authApi);
  const openaiProviderId = (providersList.json?.items ?? []).find((p) => p.name === "deepseek-openai")?.id;
  const anthropicProviderId = (providersList.json?.items ?? []).find((p) => p.name === "deepseek-anthropic")?.id;
  report("provider ids resolved", openaiProviderId !== undefined && anthropicProviderId !== undefined, `openai=${openaiProviderId} anthropic=${anthropicProviderId}`);

  // 价格 upsert：POST 409 时 PATCH（disguise 模式额外为内部名建价）
  for (const model of [...MODELS, ...(DISGUISE ? [DISGUISE] : [])]) {
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

  // 延迟计费：响应先回、扣费由队列消费者异步落定 → poll 到余额下降或超时
  const expectCharged = async (name, before) => {
    const after = await poll(() => {
      const now = balanceSql();
      return now !== undefined && now < before ? now : null;
    }, 15000, 250);
    report(`${name} (charged)`, after !== null && after < before, `before=${before} after=${after ?? balanceSql()}`);
    return after ?? balanceSql();
  };

  if (DISGUISE) {
    // ---------- 2d. disguise 真实上游：请求内部名 → 真实 DeepSeek，响应全回写 ----------
    const inner = MODELS[0];
    console.log(`\n[2d] disguise: 请求 ${DISGUISE} → 实际 ${inner}（真实 DeepSeek 上游）`);
    const msg = { model: DISGUISE, messages: [{ role: "user", content: "请用一句话介绍你自己" }] };

    let b = balanceSql();
    const chat = await api("/v1/chat/completions", { method: "POST", headers: proxyAuth, body: msg });
    report("chat non-stream 200 + 真实内容", chat.status === 200 && chat.json?.choices?.[0]?.message?.content?.length > 0,
      `status=${chat.status} ${JSON.stringify(chat.json?.error ?? chat.json?.choices?.[0]?.message?.content?.slice(0, 40))}`);
    report(`chat non-stream model 回写 → ${DISGUISE}`, chat.json?.model === DISGUISE,
      `model=${chat.json?.model}`);
    b = await expectCharged("chat non-stream (disguise)", b);
    report("usage present", chat.json?.usage?.prompt_tokens > 0 && chat.json?.usage?.completion_tokens > 0,
      JSON.stringify(chat.json?.usage));

    const chatStream = await api("/v1/chat/completions", { method: "POST", headers: proxyAuth, body: { ...msg, stream: true } });
    const chatEvents = parseSse(chatStream.text);
    const chunkModels = chatEvents.map((e) => e.data?.model).filter((m) => m !== undefined);
    report("chat stream [DONE] + 每帧 model 回写", chatStream.status === 200 && chatEvents.some((e) => e.done)
      && chunkModels.length > 0 && chunkModels.every((m) => m === DISGUISE),
      `frames=${chunkModels.length} models=${[...new Set(chunkModels)].join(",")}`);
    b = await expectCharged("chat stream (disguise)", b);

    const anthBody = { model: DISGUISE, max_tokens: 1024, messages: [{ role: "user", content: "请用一句话介绍你自己" }] };
    const msgV1 = await api("/v1/messages", { method: "POST", headers: proxyAuth, body: anthBody });
    report("/v1/messages Anthropic 形态 + model 回写", msgV1.status === 200 && msgV1.json?.type === "message"
      && msgV1.json?.model === DISGUISE && msgV1.json?.content?.[0]?.text?.length > 0,
      `status=${msgV1.status} model=${msgV1.json?.model} ${JSON.stringify(msgV1.json?.error)?.slice(0, 220)}`);
    b = await expectCharged("/v1/messages (disguise)", b);

    const resp = await api("/v1/responses", { method: "POST", headers: proxyAuth, body: { model: DISGUISE, input: "请用一句话介绍你自己" } });
    report("/v1/responses Response 形态 + model 回写", resp.status === 200 && resp.json?.object === "response"
      && resp.json?.status === "completed" && resp.json?.model === DISGUISE && resp.json?.output_text?.length > 0,
      `status=${resp.status} model=${resp.json?.model}`);
    b = await expectCharged("/v1/responses (disguise)", b);

    const logs = query(`SELECT provider_id, status FROM request_logs WHERE model='${DISGUISE}' AND status='success' ORDER BY id DESC LIMIT 10;`);
    report("request_logs 按内部名记录", logs.length >= 4, `hits=${logs.length}`);
  } else {
  // ---------- 2. 四协议入口 × 非流式/流式（恒等映射基线） ----------
  for (const model of MODELS) {
    console.log(`\n[2] ${model}`);
    const msg = { model, messages: [{ role: "user", content: "请用一句话介绍你自己" }] };

    let b = balanceSql();
    const chat = await api("/v1/chat/completions", { method: "POST", headers: proxyAuth, body: msg });
    report("chat non-stream 200 + content", chat.status === 200 && chat.json?.choices?.[0]?.message?.content?.length > 0, `status=${chat.status} ${JSON.stringify(chat.json?.error ?? chat.json?.choices?.[0]?.message?.content?.slice(0, 40))}`);
    b = await expectCharged("chat non-stream", b);
    report("usage present", chat.json?.usage?.prompt_tokens > 0 && chat.json?.usage?.completion_tokens > 0, JSON.stringify(chat.json?.usage));

    // DeepSeek 需 stream_options.include_usage 才在流尾附 usage；缺失时软断言（warn 不 FAIL）
    const chatStream = await api("/v1/chat/completions", { method: "POST", headers: proxyAuth, body: { ...msg, stream: true, stream_options: { include_usage: true } } });
    const chatEvents = parseSse(chatStream.text);
    report("chat stream SSE + [DONE]", chatStream.status === 200 && chatEvents.some((e) => e.done) && chatEvents.some((e) => e.data?.choices?.[0]?.delta?.content), `events=${chatEvents.length}`);
    const usageTail = chatEvents.find((e) => e.data?.usage);
    report("chat stream usage tail", usageTail?.data?.usage?.prompt_tokens > 0, usageTail ? JSON.stringify(usageTail.data.usage) : "WARN: no usage tail (include_usage sent, upstream omitted)");
    b = await expectCharged("chat stream", b);

    // v4-pro 是推理模型：max_tokens 需留足推理余量，否则全部被 reasoning 耗尽
    // （content 返回空串 + finish_reason=length），Anthropic 面产出合法空 content: []
    const anthBody = { model, max_tokens: 1024, messages: [{ role: "user", content: "请用一句话介绍你自己" }] };
    const msgV1 = await api("/v1/messages", { method: "POST", headers: proxyAuth, body: anthBody });
    report("/v1/messages Anthropic form", msgV1.status === 200 && msgV1.json?.type === "message" && msgV1.json?.content?.[0]?.text?.length > 0, `status=${msgV1.status} ${JSON.stringify(msgV1.json?.error ?? msgV1.json)?.slice(0, 220)}`);
    b = await expectCharged("/v1/messages non-stream", b);

    const msgStream = await api("/v1/messages", { method: "POST", headers: proxyAuth, body: { ...anthBody, stream: true } });
    const msgEvents = parseSse(msgStream.text);
    report("/v1/messages stream events", msgStream.status === 200 && msgEvents.some((e) => e.event === "message_start") && msgEvents.some((e) => e.event === "message_stop"), `events=${msgEvents.length}`);
    const md = msgEvents.find((e) => e.event === "message_delta");
    report("/v1/messages stream usage (output_tokens>0)", md?.data?.usage?.output_tokens > 0, JSON.stringify(md?.data?.usage));
    b = await expectCharged("/v1/messages stream", b);

    const respBody = { model, input: "请用一句话介绍你自己" };
    const resp = await api("/v1/responses", { method: "POST", headers: proxyAuth, body: respBody });
    report("/v1/responses Response form", resp.status === 200 && resp.json?.object === "response" && resp.json?.status === "completed" && resp.json?.output_text?.length > 0, `status=${resp.status} ${JSON.stringify(resp.json?.error ?? resp.json?.usage)}`);
    b = await expectCharged("/v1/responses non-stream", b);

    const respStream = await api("/v1/responses", { method: "POST", headers: proxyAuth, body: { ...respBody, stream: true } });
    const respEvents = parseSse(respStream.text);
    report("/v1/responses stream completed", respStream.status === 200 && respEvents.some((e) => e.data?.type === "response.completed") && !respEvents.some((e) => e.done), `events=${respEvents.length}`);
    const completed = respEvents.find((e) => e.data?.type === "response.completed");
    report("/v1/responses stream usage", completed?.data?.response?.usage?.input_tokens > 0, JSON.stringify(completed?.data?.response?.usage));
    b = await expectCharged("/v1/responses stream", b);
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
  }

  summary();
}

main().catch((error) => {
  console.error("Script error:", error);
  process.exitCode = 1;
});
