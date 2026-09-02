// 三端响应式 UI 调查脚本（本地 dev）：
//   1) 截取 10 个页面的 PC/平板/手机 截图到 scripts/ui-audit/shots/
//   2) 检测横向溢出（scrollWidth > clientWidth）与越界元素
//   3) 采集表格列数/宽度、侧边栏、卡片等布局指标
// 本机专用脚本：依赖 playwright（未声明为 devDeps，需 `npm i -D playwright && npx playwright install chromium`）
// 前置：npm run dev 已启动；本地测试用户已 seed（POST /api/seed/users）
// 用法：node scripts/ui-audit.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const OUT_DIR = new URL("./ui-audit/shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: "pc", width: 1440, height: 900, tag: "PC" },
  { name: "tablet", width: 768, height: 1024, tag: "平板" },
  { name: "mobile", width: 375, height: 812, tag: "手机" },
];

const AUTH_PAGES = [
  { path: "/login", name: "login" },
  { path: "/register", name: "register" },
];
const APP_PAGES = [
  { path: "/", name: "dashboard" },
  { path: "/usage", name: "usage" },
  { path: "/billing", name: "billing" },
  { path: "/keys", name: "keys" },
  { path: "/models", name: "models" },
  { path: "/providers", name: "providers" },
  { path: "/users", name: "users" },
  { path: "/settings", name: "settings" },
  { path: "/__no_such_route__", name: "not-found" },
];

const AUDIT_JS = () => {
  const doc = document.documentElement;
  const overflowX = doc.scrollWidth > doc.clientWidth + 1;
  const offenders = [];
  if (overflowX) {
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > doc.clientWidth + 1 || r.left < -1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).slice(0, 70),
          left: Math.round(r.left),
          right: Math.round(r.right),
          w: Math.round(r.width),
        });
        if (offenders.length >= 25) break;
      }
    }
  }
  const tables = [...document.querySelectorAll("table")].map((t, i) => ({
    i,
    cols: t.querySelectorAll("thead th").length,
    rows: t.querySelectorAll("tbody tr").length,
    scrollW: t.scrollWidth,
    clientW: t.clientWidth,
    overflow: t.scrollWidth > t.clientWidth + 1,
  }));
  const aside = document.querySelector("aside");
  const nav = document.querySelector("nav");
  const main = document.querySelector("main");
  const gridCards = [...document.querySelectorAll("main *")].filter(
    (el) => el.children.length > 0 && getComputedStyle(el).display === "grid",
  ).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50), cols: getComputedStyle(el).gridTemplateColumns.split(" ").length, w: Math.round(el.getBoundingClientRect().width) }));
  return {
    viewport: { w: innerWidth, h: innerHeight },
    scroll: { docW: doc.scrollWidth, clientW: doc.clientWidth, bodyW: document.body.scrollWidth },
    overflowX,
    offenders,
    tables,
    aside: aside ? { w: Math.round(aside.getBoundingClientRect().width) } : null,
    gridCards: gridCards.slice(0, 6),
    mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
    h1: document.querySelector("h1")?.textContent?.trim() ?? null,
    btns: [...document.querySelectorAll("button")].map((b) => ({ t: b.textContent.trim().slice(0, 12), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })).filter((b) => b.w > 0).slice(0, 8),
  };
};

const results = [];

async function auditPage(page, viewport, p) {
  await page.goto(BASE + p.path, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  // 等待路由稳定（SPA 客户端渲染完成）
  await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 15000 }).catch(() => {});
  // 数据懒加载 + 动画
  await page.waitForTimeout(1800);
  let data;
  try {
    data = await page.evaluate(AUDIT_JS);
  } catch {
    await page.waitForTimeout(1500);
    data = await page.evaluate(AUDIT_JS);
  }
  await page.screenshot({ path: `${OUT_DIR}${viewport.name}-${p.name}.png`, fullPage: true });
  results.push({ viewport: viewport.name, page: p.name, ...data });
  const hasOverflow = data.overflowX || data.tables.some((t) => t.overflow);
  console.log(`${viewport.tag} ${p.name.padEnd(10)} overflow=${hasOverflow ? "⚠" : "✓"} scroll=${data.scroll.docW}/${data.scroll.clientW} tables=${data.tables.map((t) => `${t.cols}c${t.rows}r${t.overflow ? "!" : ""}`).join(",") || "-"} grid=${data.gridCards.map((g) => `${g.cols}col`).join(",") || "-"} aside=${data.aside ? data.aside.w : "-"} main=${data.mainW}`);
  if (data.offenders.length) {
    console.log(`      offenders: ${data.offenders.map((o) => `${o.tag}.${o.cls} [${o.left}..${o.right}]`).slice(0, 5).join(" | ")}`);
  }
}

const browser = await chromium.launch({
  executablePath: "C:/Users/limc/AppData/Local/ms-playwright/chromium-1224/chrome-win64/chrome.exe",
});

// ---- 阶段 1：未登录页面（login / register）----
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  for (const p of AUTH_PAGES) await auditPage(page, vp, p);
  await ctx.close();
}

// ---- 阶段 2：登录，保存会话 ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.fill('input[type="email"], input[name="email"]', "admin@local.dev");
  await page.fill('input[type="password"]', "local-dev-pass-123");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(1000);
  const url = page.url();
  if (!url.startsWith(BASE) || url.includes("login")) {
    console.error("登录失败，当前 URL:", url);
    process.exit(1);
  }
  console.log("登录成功:", url);
  await page.context().storageState({ path: new URL("./ui-audit/state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
  await ctx.close();
}

// ---- 阶段 3：登录后页面 × 三端 ----
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    storageState: new URL("./ui-audit/state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  });
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`      [console.error] ${vp.name} ${msg.text().slice(0, 120)}`);
  });
  for (const p of APP_PAGES) await auditPage(page, vp, p);
  await ctx.close();
}

await browser.close();
console.log("\n审计完成，报告见 scripts/ui-audit/");
