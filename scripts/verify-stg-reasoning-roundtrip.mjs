// stg 真实上游 E2E（09-03-cc-stg-reasoning-400）：Claude Code thinking 模式
// reasoning_content 双向闭环验证（DeepSeek V4 契约：历史每条 assistant 消息
// 必须回传 reasoning_content，否则 400 "must be passed back to the API"）。
// 场景：
//   A1  轮1 /v1/messages + thinking:{type:"enabled"}（stream）→ 200 且收到
//       thinking_delta 事件（R2 响应侧闭环：上游 reasoning_content → thinking 块）
//   A2  轮2 历史回传 thinking 块（non-stream）→ 200 且响应含 thinking 块
//       （R1 请求侧闭环 + R3 非流式映射；缺回传时 deepseek 恒 400）
//   A3  工具循环（合成历史确定性验证）：assistant 含 thinking + tool_use，
//       tool_result 回传后再问 → 200（tool 消息上的 reasoning_content 回传）
//   B1  gpt-5.6-luna 携带 reasoning_content 历史（OpenAI 协议）→ 200
//       （R5 回归护栏：flag on 后 OpenAI 系模型容忍度；400 则回退 flag 重议）
// 前置：stg 已部署本任务代码；5 个 b.ai provider reasoning_roundtrip=1。
// 用法：E2E_KEY=<网关key> node scripts/verify-stg-reasoning-roundtrip.mjs
const BASE = "https://stg-api.lmlh.net";
const KEY = process.env.E2E_KEY;
const MODEL = process.env.MODEL ?? "deepseek-v4-flash";
const GPT_MODEL = process.env.GPT_MODEL ?? "gpt-5.6-luna";
const INTERVAL_MS = 10_000; // 相邻请求 ≥10s（settle/限流安全节奏）
const TIMEOUT_MS = 120_000;

if (!KEY) {
  console.error("E2E_KEY env var required (gateway key)");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextSlot = Date.now();
async function pace() {
  nextSlot = Math.max(nextSlot, Date.now()) + INTERVAL_MS;
  const wait = nextSlot - Date.now();
  if (wait > 0) await sleep(wait);
}

let passed = 0;
let failed = 0;
const failures = [];

function report(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

const ANTHRO_HEADERS = {
  "x-api-key": KEY,
  "anthropic-version": "2023-06-01",
  "Content-Type": "application/json",
};
const OPENAI_HEADERS = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

/** Anthropic SSE 解析：收集 thinking 文本 / 普通文本 / thinking_delta 出现次数。 */
async function collectAnthropicStream(res) {
  const text = await res.text();
  let thinking = "";
  let content = "";
  let thinkingDeltas = 0;
  for (const raw of text.split("\n\n")) {
    if (!raw.startsWith("event:")) continue;
    const lines = raw.split("\n");
    const event = lines[0].slice(6).trim();
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    let data;
    try {
      data = JSON.parse(dataLine.slice(5));
    } catch {
      continue;
    }
    if (event === "content_block_delta") {
      if (data?.delta?.type === "thinking_delta" && typeof data.delta.thinking === "string") {
        thinking += data.delta.thinking;
        thinkingDeltas += 1;
      } else if (data?.delta?.type === "text_delta" && typeof data.delta.text === "string") {
        content += data.delta.text;
      }
    }
  }
  return { thinking, content, thinkingDeltas };
}

/** 非流式 Anthropic 响应：提取 content 块（thinking 块置前断言用）。 */
function parseNonStream(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return {
    thinkingBlock: blocks.find((b) => b?.type === "thinking"),
    textBlocks: blocks.filter((b) => b?.type === "text"),
  };
}

async function post(path, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`\n=== stg reasoning_content roundtrip verify @ ${BASE} (model: ${MODEL}) ===`);
  await pace();

  // ---------- A1：轮1 流式，断言客户端收到 thinking 事件 ----------
  console.log("\n[A1] turn-1 stream: thinking enabled → expect thinking_delta events");
  {
    const res = await post("/v1/messages", ANTHRO_HEADERS, {
      model: MODEL,
      max_tokens: 256,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "Think step by step, then reply with exactly: PONG" }],
    });
    const out = await collectAnthropicStream(res);
    const ok = res.status === 200 && out.thinkingDeltas > 0 && out.content.length > 0;
    report(
      "A1 stream thinking_delta received",
      ok,
      `status=${res.status} thinkingDeltas=${out.thinkingDeltas} contentLen=${out.content.length} thinkingLen=${out.thinking.length}`,
    );
    if (!ok) {
      console.log(`  (A2/A3 skipped: turn-1 failed)`);
    } else {
      // ---------- A2：轮2 历史回传 thinking 块（非流式） ----------
      console.log("\n[A2] turn-2 non-stream: history carries thinking block → expect 200 + thinking block");
      await pace();
      const res2 = await post("/v1/messages", ANTHRO_HEADERS, {
        model: MODEL,
        max_tokens: 256,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [
          { role: "user", content: "Think step by step, then reply with exactly: PONG" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: out.thinking },
              { type: "text", text: out.content },
            ],
          },
          { role: "user", content: "Good. Now reply with exactly: PONG again" },
        ],
      });
      const data2 = await res2.json().catch(() => null);
      const blocks2 = parseNonStream(data2);
      report(
        "A2 roundtrip 200 + thinking block in non-stream response",
        res2.status === 200 && blocks2.thinkingBlock !== undefined && blocks2.textBlocks.length > 0,
        `status=${res2.status} err=${JSON.stringify(data2?.error ?? null)} thinkingBlock=${blocks2.thinkingBlock !== undefined}`,
      );

      // ---------- A3：工具循环（合成历史，确定性） ----------
      console.log("\n[A3] tool loop: assistant thinking+tool_use + tool_result → expect 200");
      await pace();
      const res3 = await post("/v1/messages", ANTHRO_HEADERS, {
        model: MODEL,
        max_tokens: 256,
        thinking: { type: "enabled", budget_tokens: 1024 },
        tools: [
          {
            name: "get_time",
            description: "Return the current time",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages: [
          { role: "user", content: "What time is it?" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should call get_time to answer." },
              { type: "tool_use", id: "toolu_0001", name: "get_time", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_0001", content: "2026-09-03T15:30:00Z" },
            ],
          },
          { role: "user", content: "So what time was it? Reply with exactly: OK" },
        ],
      });
      const data3 = await res3.json().catch(() => null);
      report(
        "A3 tool-loop roundtrip 200",
        res3.status === 200,
        `status=${res3.status} err=${JSON.stringify(data3?.error ?? null)}`,
      );
    }
  }

  // ---------- B1：gpt-5.6-luna 回归护栏 ----------
  console.log(`\n[B1] gpt regression: ${GPT_MODEL} history carries reasoning_content → expect 200`);
  await pace();
  {
    const res = await post("/v1/chat/completions", OPENAI_HEADERS, {
      model: GPT_MODEL,
      // 128+：b.ai reasoning 模型 max_tokens=64 有随机空流 quirk（reasoning 吃光预算），护栏断言只要 200，避开空流噪声
      max_tokens: 128,
      messages: [
        { role: "user", content: "Reply with exactly: PONG" },
        { role: "assistant", content: "PONG", reasoning_content: "user asked for PONG" },
        { role: "user", content: "Again" },
      ],
    });
    const data = await res.json().catch(() => null);
    report(
      "B1 gpt model tolerates reasoning_content history (flag on)",
      res.status === 200,
      `status=${res.status} err=${JSON.stringify(data?.error ?? null)} — 400 需回退 reasoning_roundtrip flag 并重议 per-model 粒度`,
    );
  }

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    for (const f of failures) {
      console.log(`  FAIL  ${f.name}\n        ${f.detail}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify aborted:", err);
  process.exit(1);
});
