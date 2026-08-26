// SPA 运行时冒烟验证（部署前执行）：用 jsdom 模拟浏览器加载 dist/client 的构建产物，
// 路由到 /login 并渲染，捕获任何未处理异常（如 React 双实例导致的
// "Cannot read properties of null (reading 'useState')" 这类仅在生产 bundle 出现的问题）。
// 用法：node scripts/verify-spa.mjs [path]
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const clientDir = resolve(process.argv[2] ?? "dist/client");
const indexPath = resolve(clientDir, "index.html");
if (!existsSync(indexPath)) {
  console.error(`index.html not found at ${indexPath} — run "npm run build" first`);
  process.exit(1);
}

const html = readFileSync(indexPath, "utf-8");
const entryMatch = html.match(/<script type="module"[^>]*src="([^"]+)"/);
if (!entryMatch) {
  console.error("no module entry script found in index.html");
  process.exit(1);
}
const entry = entryMatch[1].replace(/^\//, "");
const entryUrl = pathToFileURL(resolve(clientDir, entry)).href;

// --- jsdom 浏览器环境 ---
const dom = new JSDOM(html, {
  url: "http://localhost/login",
  runScripts: "outside-only",
  pretendToBeVisual: true, // requestAnimationFrame
});
const { window } = dom;

// jsdom 缺少的浏览器 API 补丁
window.matchMedia =
  window.matchMedia ||
  (() => ({
    matches: false,
    media: "",
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));

// jsdom 的 window.fetch 未实现（undici "not implemented"）：注入 mock，
// 模拟 API 不可达（404 JSON）—— 恰好对应未登录访问 /login 的场景。
window.fetch = async () =>
  new Response(JSON.stringify({ error: { message: "mock: api unavailable" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

for (const key of [
  "window",
  "document",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
  "history",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "Event",
  "CustomEvent",
  "MutationObserver",
  "fetch",
  "Headers",
  "Request",
  "Response",
]) {
  if (window[key] !== undefined) {
    try {
      globalThis[key] = window[key];
    } catch {
      // Node 全局（如 navigator）是只读 getter：用 defineProperty 覆盖
      Object.defineProperty(globalThis, key, {
        value: window[key],
        configurable: true,
        writable: true,
      });
    }
  }
}

// --- 错误捕获 ---
const errors = [];
window.addEventListener("error", (e) => errors.push(e.message ?? String(e)));
window.addEventListener("unhandledrejection", (e) =>
  errors.push(`[unhandledrejection] ${e.reason?.message ?? String(e.reason)}`),
);

console.log(`loading entry: ${entry}`);
try {
  await import(entryUrl);
} catch (e) {
  console.error("ENTRY IMPORT FAILED:", e);
  process.exit(1);
}

// 等待渲染（React Router 解析 + 懒加载 chunk + React Query 首轮请求失败静默）
await new Promise((r) => setTimeout(r, 2000));

const root = dom.window.document.getElementById("root");
const text = root?.textContent ?? "";
console.log("--- root rendered (first 300 chars) ---");
console.log(root?.innerHTML?.slice(0, 300) ?? "(empty)");
console.log("---");

let failed = false;
if (!root || text.trim().length === 0) {
  console.error("FAIL: #root is empty — SPA did not render");
  failed = true;
} else if (text.includes("Internal Server Error") || /Unexpected Application Error/.test(text)) {
  console.error("FAIL: error boundary rendered");
  failed = true;
}
if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} uncaught error(s):`);
  for (const e of errors.slice(0, 5)) console.error("  -", e);
  failed = true;
}
if (!failed) {
  const isLogin = /sign in|continue with github/i.test(text);
  console.log(`PASS: SPA rendered (login page: ${isLogin ? "yes" : "no — check route"})`);
}
process.exit(failed ? 1 : 0);
