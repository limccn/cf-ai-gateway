// 深度 DOM 审计：定位溢出元素文本、表格列宽、移动导航栏结构
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const STATE = new URL("./ui-audit/state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const VIEWPORTS = [
  { name: "pc", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
];
const PAGES = ["/", "/usage", "/billing", "/keys", "/models", "/providers", "/users", "/settings"];

const DETAIL_JS = () => {
  const doc = document.documentElement;
  const out = { viewport: innerWidth, overflowX: doc.scrollWidth > doc.clientWidth + 1, offenders: [], tables: [], navTabs: null, inputs: [], buttons: [] };

  if (out.overflowX) {
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > doc.clientWidth + 1 || r.left < -1) {
        // 跳过在 overflow 容器内可滚动的元素（父级 overflow-x:auto/scroll）
        let p = el.parentElement, scrollableParent = false;
        while (p) {
          const cs = getComputedStyle(p);
          if (cs.overflowX === "auto" || cs.overflowX === "scroll") { scrollableParent = true; break; }
          if (p === document.body) break;
          p = p.parentElement;
        }
        if (scrollableParent) continue;
        out.offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).slice(0, 80),
          text: el.textContent.trim().slice(0, 40).replace(/\s+/g, " "),
          left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
          parentCls: String(el.parentElement?.className ?? "").slice(0, 60),
        });
        if (out.offenders.length >= 15) break;
      }
    }
  }

  for (const [i, t] of [...document.querySelectorAll("table")].entries()) {
    const ths = [...t.querySelectorAll("thead th")].map((th) => ({
      text: th.textContent.trim().slice(0, 16),
      w: Math.round(th.getBoundingClientRect().width),
    }));
    out.tables.push({ i, cols: ths.length, ths, tableW: t.getBoundingClientRect().width, scrollW: t.scrollWidth, clientW: t.clientWidth });
  }

  // 移动导航 tab 栏
  const nav = document.querySelector('nav[aria-label="Mobile navigation"]');
  if (nav) {
    const scrollDiv = nav.querySelector(".overflow-x-auto");
    out.navTabs = {
      navW: Math.round(nav.getBoundingClientRect().width),
      tabsW: scrollDiv ? Math.round(scrollDiv.scrollWidth) : null,
      tabsClient: scrollDiv ? Math.round(scrollDiv.clientWidth) : null,
      tabCount: nav.querySelectorAll("a").length,
    };
  }

  // 表单输入与按钮
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) out.inputs.push({ tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height), ph: (el.placeholder || "").slice(0, 20) });
  }
  for (const el of document.querySelectorAll("button, a")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.buttons.push({ tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height), t: el.textContent.trim().slice(0, 14) });
  }
  return out;
};

const browser = await chromium.launch({
  executablePath: "C:/Users/limc/AppData/Local/ms-playwright/chromium-1224/chrome-win64/chrome.exe",
});

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, storageState: STATE });
  const page = await ctx.newPage();
  for (const p of PAGES) {
    await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const d = await page.evaluate(DETAIL_JS);
    console.log(`\n===== ${vp.name} ${p} (${d.viewport}px) overflow=${d.overflowX ? "⚠" : "✓"} =====`);
    if (d.offenders.length) {
      for (const o of d.offenders) console.log(`  ⚠ ${o.tag}.${o.cls} [${o.left}..${o.right}] "${o.text}" (parent: ${o.parentCls})`);
    }
    for (const t of d.tables) {
      if (t.tableW < 380 && t.cols >= 4) {
        console.log(`  📊 table#${t.i} ${t.cols}列 宽${t.tableW} 列宽: ${t.ths.map((x) => `${x.text}=${x.w}px`).join(" ")}`);
      }
    }
    if (d.navTabs) {
      console.log(`  🧭 移动导航: nav=${d.navTabs.navW}px tabs=${d.navTabs.tabsW}px(滚动区${d.navTabs.tabsClient}px) 链接数=${d.navTabs.tabCount} ${d.navTabs.tabsW > d.navTabs.tabsClient ? "(可滚动)" : "(未溢出)"}`);
    }
    const smallBtns = d.buttons.filter((b) => b.h < 36 && b.tag === "a" && b.t);
    if (smallBtns.length) console.log(`  🖱️ 小按钮(<36px高): ${smallBtns.map((b) => `${b.t}(${b.w}x${b.h})`).join(" ")}`);
  }
  await ctx.close();
}
await browser.close();
