// 三端响应式回归断言（AC1–AC5，随 task 08-28-dashboard-responsive 入库）：
//   1) 三端 × 全部页面零横向溢出（scrollWidth ≤ clientWidth）
//   2) 平板（768）主内容 ≥ 640px（图标栏不挤占）
//   3) 图表 SVG 宽度 = 卡片内容宽（无 FALLBACK 640 残留）
//   4) billing 手机过滤/翻页控件完整可见
//   5) providers/keys/models 手机：现行「Card block（标题+搜索+藏列）」契约成立
//      （Actions 为末列且可见、th/td **均未**冻结、卡内有搜索输入、藏列≥1 —— 见 AC5 段注释）
// 空态分流（AC3 与 AC5 同一判据）：页面无数据 → 渲染 EmptyState → 对应断言**显式 SKIP**（写明原因，
// 汇总行单列 skipped）；但如果**另有独立信号表明该页其实有数据**（AC3 看最近请求列表 / AC5 看卡内
// 搜索框），却仍无图表/表格 → 判 **FAIL**（疑似分支回归），SKIP 不成为兜底黑洞。
// 本机专用脚本：依赖 playwright（未声明为 devDeps，需 `npm i -D playwright && npx playwright install chromium`）
// 前置：
//   1. `npm run dev`；2. `scripts/ui-audit/state.json` 内有**未过期**的 admin 会话
//      （过期即全站 302 → 所有非 AC1 断言齐红；用 `node scripts/ui-audit.mjs` 或等价登录刷新）；
//   3. 数据前置：dashboard 窗口内有用量行（否则 AC3 显式 SKIP）、/keys 至少 1 个 key、
//      /providers 至少 1 行 —— 缺数据的页面会渲染 EmptyState，此时对应断言**显式 SKIP**，
//      既不算通过也不算失败（见 AC3/AC5 段注释与汇总行的 skipped）。
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
// 环境性场景（如本机该表 0 行 → EmptyState，无 <table> 可断言）：既不计通过也不计失败，
// 但必须显式列出，避免「静默跳过 = 看起来全绿」。
const skipped = [];
const check = (name, ok, detail) => {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` <- ${detail}` : ""}`);
  }
};
const skip = (name, reason) => {
  skipped.push(`${name}${reason ? ` <- ${reason}` : ""}`);
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

// ---- AC3 图表：dashboard 三栏小图（批次 J 重写，2026-09-18）----
// 旧断言针对「一张 2/3 宽的请求柱图 + Recent requests 明细表」，两者**都已被批次 J 删除**，
// 断言若不动就会停在废弃结构上（与本文件 AC4/AC5 两次「断言停在废弃契约」同型）。改判据：
//   · 原「页内有数据」的独立信号取自明细表（`main table`）—— 表没了，该分流分支成死代码；
//   · 新 dashboard 的三张柱图**恒渲染**：桶窗口是固定 24/24/14/30 槽、缺数据补 0，
//     BarChart 里 `data.length === 0` 那条空态分支永不触发 ⇒「无图空态」这一档不再存在，
//     无图只剩「加载中 / 报错 / 真回归」三种可能，故不再有 SKIP 通道。
// 三条断言：① 三图齐备；② 每图铺满其卡片（无 640 fallback 残留）；
// ③ **柱图不横向溢出** —— 本批最容易被静默破坏的不变量：卡片内容盒只有 214~307px 而桶有
//    24~30 个，常规柱宽/间距（10px 柱 + 8px 间距，30 桶要 532px）必然撑出内部滚动条；
//    那正是 BarChart 新增 `dense` 模式要解决的问题，删掉 dense 这条立刻红（已构造性验证：
//    摘掉 dense → 三图齐报 scroll=532/307）。
//
// **③ 的判别力不是一蹴而就的**（2026-09-18 实录）：dense 首版的柱宽下限取 6px（照 1440 三栏的
//    307px 内容盒定的），pc/tablet 全绿、**唯独 mobile 红**（scroll=238/214）—— 375 下宽度链是
//    375 −64(图标栏 w-16) −15(经典滚动条) −32(px-4) −48(CardContent p-6) −2(border) = **214px**，
//    30 桶连柱带距只有 214/30 ≈ 7px 可用。修法不是把下限调到 5（那只盖住 214 这一档，换更窄
//    视口又犯），而是 dense 下限取 1 ⇒ 柱宽 = floor(slot) ⇒ 恒有 n*柱宽 + (n-1)*间距 ≤ 容器宽
//    ⇒ 溢出**构造上不可能**。已扫描 1440→280 共 11 档视口实测零溢出（脚本
//    scripts/ui-audit/measure-dash-mobile.mjs）。故本条同时是全视口的回归锁。
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, storageState: STATE });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  // 等柱图或错误态出现再判定，避免把慢加载误判成页面异常
  await page
    .waitForFunction(
      () =>
        document.querySelector('svg[aria-label="Usage bar chart"]') ||
        document.querySelector('main [role="alert"]'),
      { timeout: 15000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg[aria-label="Usage bar chart"]')];
    if (svgs.length === 0) {
      return { noChart: true, error: Boolean(document.querySelector('main [role="alert"]')) };
    }
    return {
      noChart: false,
      charts: svgs.map((svg) => {
        // svg 的父元素就是 BarChart 的 `w-full overflow-x-auto` 包裹层（bar-chart.tsx）
        const wrap = svg.parentElement;
        const card = svg.closest(".rounded-lg");
        return {
          svgW: Math.round(svg.getBoundingClientRect().width),
          cardW: card ? Math.round(card.getBoundingClientRect().width) : null,
          wrapW: wrap.clientWidth,
          wrapScrollW: wrap.scrollWidth,
        };
      }),
    };
  });
  if (r.noChart) {
    check(
      `AC3 ${vp.name} 三张柱图齐备`,
      false,
      r.error
        ? "ErrorState（页面报错，非环境性）"
        : "既无柱图也无 ErrorState —— 加载未完成或图表分支回归",
    );
  } else {
    check(`AC3 ${vp.name} 三张柱图齐备（Spend/Requests/Tokens）`, r.charts.length === 3,
      `实测 ${r.charts.length} 张`);
    for (const [i, c] of r.charts.entries()) {
      const contentW = (c.cardW ?? 0) - 48; // Card p-6 ×2
      // 无 640 fallback 残留（B1 根因）：窄容器（<640）下不允许固定 640；且图表铺满卡片
      const noFallback = contentW >= 640 || c.svgW < 640;
      check(
        `AC3 ${vp.name} 图${i + 1} 全宽无 fallback`,
        c.cardW !== null && noFallback && c.svgW >= contentW - 8,
        `svg=${c.svgW} card=${c.cardW}`,
      );
      check(
        `AC3 ${vp.name} 图${i + 1} 不横向溢出（三栏小图 dense 生效）`,
        c.wrapScrollW <= c.wrapW + 1,
        `scroll=${c.wrapScrollW}/${c.wrapW}`,
      );
    }
  }
  await ctx.close();
}

// ---- AC4 手机 billing 筛选控件可见（2026-09-18 批次 I 订正） ----
// 旧断言停在**已被主动废弃**的结构上：type 下拉原在流水表 header 内，判据是
// `sel.closest(".space-y-0")` 的 flexDirection 在手机下为 column。批次 I 把下拉移入
// Ledger summary 卡（替换该卡的 Types 静态行），那个 `.space-y-0` 已不存在 ——
// 若不动它，`closest()` 回 null → headerDir=null → **恒 FAIL**，红点与真实回归混在一起
// （与 AC5 那次「断言停在废弃契约上」同型，修法是订正断言、不是把下拉搬回去）。
// 改为指向现行契约三条：
//   ① 下拉在手机视口内完整可见（核心诉求，**不变**）；
//   ② 下拉确实落在 Ledger summary 卡内（批次 I 的搬移契约 —— 搬回去必须有人知道）；
//   ③ 下拉未被压扁、也未跑出所在卡片右边界（1/3 窄卡 + w-full 的真实风险）。
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, storageState: STATE });
  const page = await ctx.newPage();
  await page.goto(BASE + "/billing", { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1300);
  const r = await page.evaluate(() => {
    const sel = document.querySelector("#billing-type");
    if (!sel) return { found: false };
    const doc = document.documentElement;
    const rect = sel.getBoundingClientRect();
    // 卡片根 = 最近的 .rounded-lg 祖先（与 AC5 同一条判据：table.tsx 包裹层只有
    // relative/overflow-auto，CardContent 只有 p-0，故 closest() 无歧义）
    const card = sel.closest(".rounded-lg");
    const cardRect = card?.getBoundingClientRect();
    return {
      found: true,
      inViewport: rect.left >= 0 && rect.right <= doc.clientWidth,
      width: Math.round(rect.width),
      cardHeading: card?.querySelector("h3")?.textContent?.trim() ?? null,
      withinCard: cardRect ? rect.right <= cardRect.right + 1 : null,
    };
  });
  check("AC4 手机 billing Select 可见", r.found === true && r.inViewport === true, JSON.stringify(r));
  check(
    "AC4 手机 billing Select 落在 Ledger summary 卡内（批次 I 契约）",
    r.cardHeading === "Ledger summary",
    `所在卡标题=${r.cardHeading}`,
  );
  check(
    "AC4 手机 billing Select 未被压扁且未跑出卡片",
    (r.width ?? 0) >= 120 && r.withinCard === true,
    `宽 ${r.width}px，withinCard=${r.withinCard}`,
  );
  await ctx.close();
}

// ---- AC5 手机表格：现行「Card block（标题+搜索+藏列）」契约 ----
// 断言指向**现行**契约（b99b3b7「keys/providers/models 表格撤 sticky 改 Card block」之后），
// 不是已撤除的 `Actions` 列 sticky —— 恢复 sticky 是**错误**修法（见 task 09-18-fix-verify-responsive-ac5）。
// 「未冻结」是**负向锁**：它天然恒真，除非有人真把 sticky 加回来；这正是它的用途（加了必须有人知道），
// 其判别力已由 AC2 构造性验证（临时加回 sticky right-0 → 本条转 FAIL）。
for (const p of ["/providers", "/keys", "/models"]) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, storageState: STATE });
  const page = await ctx.newPage();
  await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  // 先等页面脱离加载态（表格 / 空态 / 错误态任一出现），否则慢加载会被误判成「页面异常」
  await page
    .waitForFunction(
      () =>
        document.querySelector("table") ||
        document.querySelector('main .rounded-lg .border-dashed') ||
        document.querySelector('main [role="alert"]'),
      { timeout: 15000 },
    )
    .catch(() => {});
  const r = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) {
      // 判据落在 main 内：Dialog/DropdownMenu 都 portal 到 body，非空表单里的 role="alert" 不会误判。
      // EmptyState 判据取 `main .rounded-lg .border-dashed`（其后代关系）—— require-admin 的
      // 403 提示自身即 .rounded-lg.border-dashed，不是任何 .rounded-lg 的后代，故不会误判为空态。
      return {
        noTable: true,
        empty: Boolean(document.querySelector("main .rounded-lg .border-dashed")),
        error: Boolean(document.querySelector('main [role="alert"]')),
        // 独立「该页有数据」信号（对称于 AC3 的 dataShown）：搜索框与表格同受 `items.length > 0`
        // 门控且全站仅这三页有 `aria-label^="Search"`，故**有搜索框却无表格** = 有数据却没渲染出
        // 表格 → 真回归。少了这条，空态判据同样无法区分「真无数据」与「表格分支被改坏」。
        // （脚本从不输入搜索词，故不会撞上「搜到 0 条 → EmptyState 但搜索框仍在」的合法态。）
        dataShown: Boolean(document.querySelector('main input[aria-label^="Search"]')),
      };
    }
    const ths = [...table.querySelectorAll("thead th")];
    const actionsTh = ths[ths.length - 1];
    const cs = getComputedStyle(actionsTh);
    // 冻结锁要成对看 th/td：规范要求两处类名同步（components.md「表格手机适配」），只锁 th 会在
    // 「只给 td 加 sticky」时静默放过 —— 那正是本条要防的回归。
    const bodyTds = [...(table.querySelector("tbody tr")?.querySelectorAll("td") ?? [])];
    const actionsTd = bodyTds.length ? bodyTds[bodyTds.length - 1] : null;
    const tdPosition = actionsTd ? getComputedStyle(actionsTd).position : null;
    // 卡片式容器：Table 的最近 .rounded-lg 祖先 = Card 根（table.tsx 的包裹层只有 relative/overflow-auto）
    const card = table.closest(".rounded-lg");
    const search = card ? card.querySelector('input[aria-label^="Search"]') : null;
    const hiddenCols = ths.filter((th) => getComputedStyle(th).display === "none").length;
    return {
      noTable: false,
      lastIsActions: /^actions$/i.test(actionsTh.textContent.trim()),
      actionsVisible: cs.display !== "none",
      position: cs.position,
      right: cs.right,
      tdPosition,
      searchLabel: search ? search.getAttribute("aria-label") : null,
      searchVisible: search ? getComputedStyle(search).display !== "none" : false,
      hiddenCols,
      colCount: ths.length,
    };
  });
  if (r.noTable) {
    if (r.error) {
      check(`AC5 手机 ${p} 表格存在`, false, "ErrorState（页面报错，非环境性）");
    } else if (r.dataShown) {
      check(`AC5 手机 ${p} 表格存在`, false, "有数据（卡内搜索框已渲染）却无表格 —— 疑似列表分支回归");
    } else if (r.empty) {
      skip(`AC5 手机 ${p}`, "EmptyState：本机该表 0 行，无 <table> 可断言（环境性）");
    } else {
      check(`AC5 手机 ${p} 表格存在`, false, "既无表格也无 EmptyState/ErrorState（页面异常）");
    }
  } else {
    check(
      `AC5 手机 ${p} Actions 为末列且可见`,
      r.lastIsActions && r.actionsVisible,
      `lastIsActions=${r.lastIsActions} display≠none=${r.actionsVisible} cols=${r.colCount}`,
    );
    check(
      `AC5 手机 ${p} Actions 未冻结(position≠sticky)`,
      r.position !== "sticky" && r.tdPosition !== "sticky",
      `th.position=${r.position} th.right=${r.right} td.position=${r.tdPosition}`,
    );
    check(
      `AC5 手机 ${p} 卡片式容器含搜索输入`,
      r.searchLabel !== null && r.searchVisible,
      `search=${JSON.stringify(r.searchLabel)}`,
    );
    check(`AC5 手机 ${p} 藏列≥1`, r.hiddenCols >= 1, `hidden=${r.hiddenCols}/${r.colCount}`);
  }
  await ctx.close();
}

await browser.close();

console.log(`\n响应式断言: ${passed} passed, ${failed} failed, ${skipped.length} skipped`);
if (skipped.length) {
  console.log("跳过（环境性，既非通过也非失败）:");
  for (const s of skipped) console.log(`  - ${s}`);
}
if (failures.length) {
  console.log("失败明细:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
