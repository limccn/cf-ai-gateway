// E2E 脚本公共工具（提取自 verify-m3/m4/deepseek/protocols 的重复实现）：
//   api（连接级偶发错误重试一次 + getSetCookie 全取 + JSON/SSE 文本区分）、parseSse、
//   report/summary（统一 PASS/FAIL 计数与汇总）、signup/signin（Better Auth Origin 校验）、
//   createD1（本地 wrangler d1 execute：run 写 / query 读）、sleep
// 用法：
//   import { createHarness, createD1, parseSse, sleep } from "./lib/e2e-utils.mjs";
//   const { api, report, summary, signup, signin, origin, base } = createHarness({ label: "M3" });
//   const { run: runSql, query } = createD1();
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WRANGLER_JS = fileURLToPath(
  new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询直到 fn() 返回真值或超时（延迟计费断言用：成功路径扣费由队列消费者异步落定，
 * 响应已先返回；本地 dev 队列投递+消费在毫秒~秒级，15s 覆盖冷启动队列）。
 */
export async function poll(fn, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      return null;
    }
    await sleep(intervalMs);
  }
}

/** 本地 D1 执行器（--local）：run = 写（无返回），query = 读（--json → results 行）。 */
export function createD1(dbName = "cf-ai-gateway-db") {
  const run = (sql) =>
    execFileSync(
      process.execPath,
      [WRANGLER_JS, "d1", "execute", dbName, "--local", "--command", sql],
      { stdio: "pipe", encoding: "utf8" },
    );
  const query = (sql) => {
    const out = execFileSync(
      process.execPath,
      [WRANGLER_JS, "d1", "execute", dbName, "--local", "--command", sql, "--json"],
      { stdio: "pipe", encoding: "utf8" },
    );
    return JSON.parse(out)[0]?.results ?? [];
  };
  return { run, query };
}

/** SSE 文本 → 事件数组：`{ event, data | done | raw }`（data 非 JSON 时带 raw）。 */
export function parseSse(text) {
  const events = [];
  let eventName = "message";
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        events.push({ event: eventName, done: true });
      } else {
        try {
          events.push({ event: eventName, data: JSON.parse(data) });
        } catch {
          events.push({ event: eventName, raw: data });
        }
      }
      eventName = "message";
    }
  }
  return events;
}

/**
 * E2E 验证 harness：report/summary 计数 + api/signup/signin。
 * base 可用 BASE_URL 覆盖；label 用于汇总标题。
 */
export function createHarness({
  base = process.env.BASE_URL ?? "http://localhost:5173",
  label = "verify",
} = {}) {
  let passed = 0;
  let failed = 0;
  const lastFailures = [];

  function report(name, ok, detail) {
    if (ok) {
      passed += 1;
      console.log(`  PASS  ${name}`);
    } else {
      failed += 1;
      lastFailures.push(name);
      console.log(`  FAIL  ${name}${detail ? `  <- ${detail}` : ""}`);
    }
  }

  function summary() {
    console.log(`\n=== ${label} RESULT: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
      console.log("Failed:", lastFailures.join(" | "));
      process.exitCode = 1;
    }
  }

  /** GET/POST/PATCH/DELETE + cookie 会话；连接级偶发错误（keep-alive 复用竞态）重试一次。 */
  async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
    const finalHeaders = { ...headers };
    if (cookie) {
      finalHeaders.Cookie = cookie;
    }
    if (body !== undefined) {
      finalHeaders["Content-Type"] = "application/json";
    }
    const doFetch = () =>
      fetch(base + path, {
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    let res;
    try {
      res = await doFetch();
    } catch (error) {
      console.log(`  [retry] ${method} ${path} failed (${error.cause?.code ?? error.message}), retrying...`);
      await sleep(500);
      res = await doFetch();
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON（SSE 等）
    }
    let cookieOut = null;
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      cookieOut = setCookies
        .map((c) => c.split(";")[0])
        .filter((c) => c.includes("="))
        .join("; ");
    }
    return { status: res.status, json, text, cookie: cookieOut };
  }

  // Better Auth 校验 Origin（CSRF 防护）：API 调用需带与 baseURL 同源的 Origin 头
  const origin = new URL(base).origin;

  async function signup(email, password, inviteCode, name) {
    return api("/api/auth/sign-up/email", {
      method: "POST",
      headers: { Origin: origin },
      body: { email, password, name: name ?? email.split("@")[0], inviteCode },
    });
  }

  async function signin(email, password) {
    return api("/api/auth/sign-in/email", {
      method: "POST",
      headers: { Origin: origin },
      body: { email, password },
    });
  }

  return { api, report, summary, signup, signin, origin, base, parseSse, sleep };
}
