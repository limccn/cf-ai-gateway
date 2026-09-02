// 三端响应式回归断言（AC1–AC5，随 task 08-28-dashboard-responsive 入库）：
//   1) 三端 × 全部页面零横向溢出（scrollWidth ≤ clientWidth）
//   2) 平板（768）主内容 ≥ 640px（图标栏不挤占）
//   3) 图表 SVG 宽度 = 卡片内容宽（无 FALLBACK 640 残留）
//   4) billing 手机过滤/翻页控件完整可见
//   5) providers/keys/models 手机 Actions 列 sticky right-0 + 藏列生效
// 本机专用脚本：依赖 playwright（未声明为 devDeps，需 `npm i -D playwright && npx playwright install chromium`）
// 前置：npm run dev + seed users（同 scripts/ui-audit.mjs）
// 用法：node scripts/verify-responsive.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const STATE = new URL("./ui-audit/state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const VIEWPORTS = [
  { name: "pc", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
];
const PAGES = ["/", "/usage", "/billing", "/keys", "/models", "/providers", "/users", "/settings", "/login", "/register", "/__no_such_route__"];

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` <- ${detail}` : ""}`);
  }
};

const browser = await chromium.launch({
  executablePath: "C:/Users/limc/AppData/Local/ms-playwright/chromium-1224/chrome-win64/chrome.exe",
});

// ---- AC1 三端零溢出 ----
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    storageState: STATE,
  });
  const page = await ctx.newPage();
  for (const p of PAGES) {
    await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1300);
    const r = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    check(`AC1 ${vp.name} ${p} 零溢出`, r.scrollW <= r.clientW, `scroll=${r.scrollW}/${r.clientW}`);
  }
  await ctx.close();
}

// ---- AC2 平板内容区 ≥ 640 ----
{
  const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 }, storageState: STATE });
  const page = await ctx.newPage();
  for (const p of ["/", "/usage", "/billing"]) {
    await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1300);
    const r = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      const main = document.querySelector("main");
      return {
        asideW: aside ? Math.round(aside.getBoundingClientRect().width) : null,
        mainW: main ? Math.round(main.getBoundingClientRect().width) : null,
      };
    });
    check(`AC2 平板 ${p} 图标栏+内容区`, r.asideW === 64 && r.mainW >= 640, `aside=${r.asideW} main=${r.mainW}`);
  }
  await ctx.close();
}

// ---- AC3 图表全宽（三端 dashboard）----
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, storageState: STATE });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const r = await page.evaluate(() => {
    const svg = document.querySelector('svg[aria-label="Usage bar chart"]');
    if (!svg) return null;
    const card = svg.closest(".rounded-lg");
    return {
      svgW: Math.round(svg.getBoundingClientRect().width),
      cardW: card ? Math.round(card.getBoundingClientRect().width) : null,
    };
  });
  if (r) {
    const pad = 48; // Card p-6 ×2
    const contentW = r.cardW - pad;
    // 无 640 fallback 残留（B1 根因）：窄容器（<640）下不允许固定 640；且图表铺满卡片
    // （柱宽下限允许小幅超出容器，内部滚动属有意设计，页面级溢出由 AC1 兜底）
    const noFallback = contentW >= 640 || r.svgW < 640;
    check(
      `AC3 ${vp.name} 图表全宽无 fallback`,
      r.cardW !== null && noFallback && r.svgW >= contentW - 8,
      `svg=${r.svgW} card=${r.cardW}`,
    );
  } else {
    check(`AC3 ${vp.name} 图表存在`, false, "svg not found");
  }
  await ctx.close();
}

// ---- AC4 手机 billing 控件可见 ----
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, storageState: STATE });
  const page = await ctx.newPage();
  await page.goto(BASE + "/billing", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1300);
  const r = await page.evaluate(() => {
    const sel = document.querySelector("#billing-type");
    const doc = document.documentElement;
    const rect = sel?.getBoundingClientRect();
    return {
      inViewport: rect ? rect.left >= 0 && rect.right <= doc.clientWidth : null,
      headerDir: sel?.closest(".space-y-0") ? getComputedStyle(sel.closest(".space-y-0")).flexDirection : null,
    };
  });
  check("AC4 手机 billing Select 可见", r.inViewport === true && r.headerDir === "column", JSON.stringify(r));
  await ctx.close();
}

// ---- AC5 手机表格 sticky Actions + 藏列 ----
for (const p of ["/providers", "/keys", "/models"]) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, storageState: STATE });
  const page = await ctx.newPage();
  await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1300);
  const r = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return null;
    const ths = [...table.querySelectorAll("thead th")];
    const actionsTh = ths[ths.length - 1];
    const cs = getComputedStyle(actionsTh);
    const hiddenCols = ths.filter((th) => getComputedStyle(th).display === "none").length;
    return { sticky: cs.position === "sticky" && cs.right === "0px", hiddenCols };
  });
  if (r) {
    check(`AC5 手机 ${p} Actions sticky`, r.sticky, JSON.stringify(r));
    check(`AC5 手机 ${p} 藏列≥1`, r.hiddenCols >= 1, `hidden=${r.hiddenCols}`);
  } else {
    check(`AC5 手机 ${p} 表格存在`, false, "no table");
  }
  await ctx.close();
}

await browser.close();

console.log(`\n响应式断言: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("失败明细:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
