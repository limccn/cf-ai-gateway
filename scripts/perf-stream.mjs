// 长上下文性能压测（08-31-stream-settle-1102-perf Step 6 + 08-31-perf-v2 非流式场景）：
// - 流式（默认）：mock 上游发 92.7k 输入 + 大输出 SSE（~500KB），并发 N（4/8）请求，
//   输出完成率 + TTFB/wall time 汇总（对比基线：修复前 O(n²) settle 在 84KB/2s 已超时）。
// - 非流式（PERF_MODE=nonstream）：同一大输入体（>32KB 走缓存前置过滤跳过评估），
//   并发 N 请求测 wall time —— 延迟计费（08-31-perf-v2）下响应路径 0 同步 D1 写；
//   基线对比：同步计费实现（git revert 延迟计费提交）同样跑本模式取数。
// 自包含：内嵌专用大输出 mock（不依赖 mock-upstream.mjs）+ D1 bootstrap（复用 verify-m4 模式）。
// 前置：
//   - 本地 D1 已应用迁移（`npm run db:migrate -- --local`）
//   - `npm run dev` 已启动（http://localhost:5173，可 BASE_URL 覆盖）
// 用法：
//   node scripts/perf-stream.mjs                      # 流式，并发 4
//   PERF_CONCURRENCY=8 node scripts/perf-stream.mjs
//   PERF_MODE=nonstream node scripts/perf-stream.mjs  # 非流式（延迟计费 wall time）
// 可选覆盖：PERF_INPUT_KB / PERF_FRAMES / PERF_FRAME_KB / PERF_DELAY_MS / MOCK_PORT / PERF_OUTPUT_KB
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8790);
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 4);
const MODE = process.env.PERF_MODE === "nonstream" ? "nonstream" : "stream";
const INPUT_KB = Number(process.env.PERF_INPUT_KB ?? 92.7); // 请求体 ≈ 92.7KB（长上下文模拟）
const FRAMES = Number(process.env.PERF_FRAMES ?? 125); // 输出帧数（每帧 4KB → ~500KB）
const FRAME_KB = Number(process.env.PERF_FRAME_KB ?? 4);
const FRAME_DELAY_MS = Number(process.env.PERF_DELAY_MS ?? 1);
const OUTPUT_KB = Number(process.env.PERF_OUTPUT_KB ?? 64); // 非流式输出体积（KB）

const DB_NAME = "cf-ai-gateway-db";
const ADMIN_EMAIL = "perf@example.com";
const PASSWORD = "testpass123";
const INVITE = "PERF0001";
const MODEL = "perf-big";

// ============ 内嵌大输出 mock 上游 ============

function sendSse(res, frames, usage) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const chunk = (content) => ({
    id: "chatcmpl-perf",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  let i = 0;
  const timer = setInterval(() => {
    if (i < frames.length) {
      res.write(`data: ${JSON.stringify(chunk(frames[i++]))}\n\n`);
      return;
    }
    clearInterval(timer);
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-perf",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [],
        usage,
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  }, FRAME_DELAY_MS);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        resolve({ body: JSON.parse(raw || "{}"), bytes: Buffer.byteLength(raw) });
      } catch {
        resolve({ body: null, bytes: Buffer.byteLength(raw) });
      }
    });
  });
}

const mockServer = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const { body, bytes } = await readJson(req);
    if (body?.model !== MODEL) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "perf mock: only perf-big" } }));
      return;
    }
    if (body?.stream === true) {
      const frameText = "x".repeat(FRAME_KB * 1024);
      const frames = Array.from({ length: FRAMES }, () => frameText);
      sendSse(
        res,
        frames,
        { prompt_tokens: 100_000, completion_tokens: FRAMES * 100, total_tokens: 100_000 + FRAMES * 100 },
      );
      console.log(`[mock] stream request body=${(bytes / 1024).toFixed(1)}KB → ${FRAMES}×${FRAME_KB}KB frames`);
      return;
    }
    // 非流式（08-31-perf-v2）：固定 JSON 输出（~PERF_OUTPUT_KB），usage 100k/12.5k
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-perf",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "x".repeat(OUTPUT_KB * 1024) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100_000, completion_tokens: 12_500, total_tokens: 112_500 },
      }),
    );
    console.log(`[mock] non-stream request body=${(bytes / 1024).toFixed(1)}KB → ${OUTPUT_KB}KB JSON`);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "perf mock: not found" } }));
});

// ============ 本地 D1 + API helpers（verify-m4 模式） ============

const WRANGLER_JS = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

function runSql(sql) {
  execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", DB_NAME, "--local", "--command", sql],
    { stdio: "pipe", encoding: "utf8" },
  );
}

const ORIGIN = new URL(BASE).origin;

async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
  const finalHeaders = { ...headers };
  if (cookie) {
    finalHeaders.Cookie = cookie;
  }
  if (body !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    console.log(`  [retry] ${method} ${path} failed (${error.cause?.code ?? error.message}), retrying...`);
    await new Promise((r) => setTimeout(r, 500));
    res = await fetch(BASE + path, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // SSE / 非 JSON
  }
  let cookieOut = null;
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    cookieOut = setCookies.map((c) => c.split(";")[0]).filter((c) => c.includes("=")).join("; ");
  }
  return { status: res.status, json, text, cookie: cookieOut };
}

// ============ 压测 ============

/** 并发跑 count 个任务，返回每项结果（含失败原因）。 */
async function runConcurrent(count, task) {
  const results = await Promise.all(
    Array.from({ length: count }, async () => {
      try {
        return { ok: true, ...(await task()) };
      } catch (error) {
        return { ok: false, error: error.cause?.code ?? error.message };
      }
    }),
  );
  return results;
}

async function main() {
  const modeLabel =
    MODE === "stream"
      ? `流式 输出 ~${Math.round(((FRAMES * FRAME_KB) / 1024) * 10) / 10}MB`
      : `非流式（延迟计费）输出 ~${OUTPUT_KB}KB`;
  console.log(`\n=== perf-stream @ ${BASE} (${modeLabel}, 并发 ${CONCURRENCY}, 输入 ${INPUT_KB}KB) ===`);

  // ---------- 0. 内嵌 mock 上游 ----------
  await new Promise((resolve) => mockServer.listen(MOCK_PORT, "127.0.0.1", resolve));
  console.log(`[mock] big-output upstream on :${MOCK_PORT}`);

  // ---------- 1. D1 bootstrap（幂等） ----------
  console.log("\n[setup] prepare local D1");
  runSql(
    `DELETE FROM invite_codes;` +
      `DELETE FROM accounts;` +
      `DELETE FROM sessions;` +
      `DELETE FROM balance_tx;` +
      `DELETE FROM usage_daily;` +
      `DELETE FROM request_logs;` +
      `DELETE FROM api_keys;` +
      `DELETE FROM providers;` +
      `DELETE FROM models;` +
      `DELETE FROM users WHERE email <> 'bootstrap@example.com';`,
  );
  runSql(
    `INSERT OR IGNORE INTO users (id, email, name, role, status, balance, email_verified, created_at, updated_at) ` +
      `VALUES (1,'bootstrap@example.com','Bootstrap','admin','active',100,1,unixepoch(),unixepoch());`,
  );
  runSql(
    `INSERT OR IGNORE INTO invite_codes (code, created_by, expires_at, created_at) VALUES ` +
      `('${INVITE}',1,unixepoch()+86400,unixepoch());`,
  );

  const signup = await api("/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: { email: ADMIN_EMAIL, password: PASSWORD, name: "perf", inviteCode: INVITE },
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`signup failed: status=${signup.status} ${signup.text.slice(0, 200)}`);
  }
  runSql(`UPDATE users SET role='admin', balance=1000 WHERE email='${ADMIN_EMAIL}';`);
  const signin = await api("/api/auth/sign-in/email", {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  const adminCookie = signin.cookie;
  const authApi = { cookie: adminCookie };

  const provider = await api("/api/providers", {
    method: "POST",
    ...authApi,
    body: {
      name: "perf-provider",
      type: "openai",
      baseUrl: `${MOCK_BASE}`,
      apiKey: "sk-perf",
      models: { [MODEL]: MODEL },
    },
  });
  if (provider.status !== 200) {
    throw new Error(`provider create failed: ${provider.status} ${provider.text.slice(0, 200)}`);
  }
  const price = await api("/api/models", {
    method: "POST",
    ...authApi,
    body: {
      model: MODEL,
      inputPriceShort: 0.15,
      inputPriceLong: 0.15,
      inputPriceCached: 0.0375,
      outputPriceShort: 0.6,
      outputPriceLong: 0.6,
    },
  });
  if (price.status !== 200) {
    throw new Error(`price create failed: ${price.status} ${price.text.slice(0, 200)}`);
  }
  const key = await api("/api/keys", { method: "POST", ...authApi, body: { name: "perf-key" } });
  const plaintext = key.json?.plaintext;
  if (!plaintext) {
    throw new Error("key create failed");
  }
  const proxyAuth = { Authorization: `Bearer ${plaintext}` };

  // ---------- 2. 预热一次（剔除冷启动） ----------
  console.log(`\n[warmup] single ${MODE} request`);
  const warmBody = {
    model: MODEL,
    ...(MODE === "stream" ? { stream: true } : {}),
    messages: [{ role: "user", content: "x".repeat(Math.floor(INPUT_KB * 1024)) }],
  };
  await api("/v1/chat/completions", { method: "POST", headers: proxyAuth, body: warmBody });

  // ---------- 3. 并发压测 ----------
  console.log(`\n[bench] ${CONCURRENCY} concurrent ${MODE === "stream" ? "big-stream" : "non-stream (delayed billing)"} requests`);
  const bodyBytes = Buffer.byteLength(JSON.stringify(warmBody));
  const t0 = Date.now();
  const results = await runConcurrent(CONCURRENCY, async () => {
    const start = Date.now();
    const res = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...proxyAuth },
      body: JSON.stringify(warmBody),
    });
    if (!res.ok || !res.body) {
      throw new Error(`status=${res.status}`);
    }
    if (MODE === "stream") {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rawText = "";
      let bytes = 0;
      let ttfb = null;
      let chunk = await reader.read();
      while (!chunk.done) {
        if (ttfb === null) {
          ttfb = Date.now() - start;
        }
        rawText += decoder.decode(chunk.value, { stream: true });
        bytes += chunk.value.length;
        chunk = await reader.read();
      }
      // 事件计数在完整文本上统计（跨 chunk 边界不丢帧）
      const events = (rawText.match(/data: /g) ?? []).length;
      return { wallMs: Date.now() - start, ttfb, bytes, events };
    }
    // 非流式：整体读回（wall time = 响应路径全链路，含延迟计费旁路）
    const text = await res.text();
    return { wallMs: Date.now() - start, ttfb: Date.now() - start, bytes: Buffer.byteLength(text), events: 0 };
  });
  const totalMs = Date.now() - t0;

  // ---------- 4. 汇总 ----------
  const done = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const walls = done.map((r) => r.wallMs).sort((a, b) => a - b);
  const ttfs = done.map((r) => r.ttfb ?? 0).sort((a, b) => a - b);
  const totalBytes = done.reduce((s, r) => s + r.bytes, 0);
  const p50 = (arr) => arr[Math.floor(arr.length * 0.5)] ?? 0;
  const p95 = (arr) => arr[Math.floor(arr.length * 0.95)] ?? 0;
  const mem = process.memoryUsage();

  console.log("\n=== 汇总 ===");
  console.log(`模式: ${MODE === "stream" ? "流式（settle 延迟计费）" : "非流式（延迟计费，0 同步 D1 写）"}`);
  console.log(`请求体: ${(bodyBytes / 1024).toFixed(1)}KB / 请求（${CONCURRENCY} 并发）`);
  console.log(`完成率: ${done.length}/${results.length}${failed.length > 0 ? `（失败: ${failed.map((f) => f.error).join(", ")}）` : ""}`);
  console.log(`wall time: 总 ${(totalMs / 1000).toFixed(2)}s | p50 ${p50(walls)}ms | p95 ${p95(walls)}ms`);
  console.log(`TTFB: p50 ${p50(ttfs)}ms | p95 ${p95(ttfs)}ms`);
  console.log(`输出: 共 ${(totalBytes / 1024 / 1024).toFixed(1)}MB（${done.length} 请求合计）| 事件/请求 ~${Math.round((done[0]?.events ?? 0) / 1)}`);
  console.log(`进程内存: rss ${(mem.rss / 1024 / 1024).toFixed(0)}MB | heap ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`);
  if (MODE === "nonstream") {
    console.log(`基线对比：同步计费实现（revert 延迟计费提交后）跑本模式记录 wall p50/p95 作对照；`);
    console.log(`延迟计费下响应路径无 findModelPrice / chargeUsage await（见单测 0 同步 D1 写断言）。`);
  }

  // 期望输出：流式 ~= FRAMES 帧 + usage 帧 + [DONE]（~500KB）；非流式 ~= OUTPUT_KB（容差 10%）
  const expectBytes =
    MODE === "stream" ? FRAMES * FRAME_KB * 1024 : OUTPUT_KB * 1024;
  const pass =
    done.length === results.length &&
    done.every((r) => r.bytes >= expectBytes * 0.9 && (MODE === "stream" ? r.events >= FRAMES + 1 : true));
  console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL");

  await new Promise((resolve) => mockServer.close(resolve));
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nperf-stream aborted: ${error.message}`);
  mockServer.close(() => process.exit(2));
});
