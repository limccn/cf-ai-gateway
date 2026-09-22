#!/usr/bin/env node
// 渲染 wrangler.toml：wrangler.toml.template + 两个值文件 → wrangler.toml（**一次生成，两环境齐备**）。
//
// 背景（.trellis/spec/governance/config-inventory.md，本地 spec）：绑定级字段（name / routes / database_id / KV id /
// queue 名）与 [vars] 运行时配置都必须以 TOML 字面量烘焙进生成物——wrangler 4.x **实测不解析**
// `{KEY}` 占位符（`wrangler deploy --dry-run` 输出 `env.FOO ("{TEST_FOO}")`，字面量原样进运行时）。
// 因此所有环境差异值统一收进值文件 / process.env，模板驱动渲染（生成物 gitignored）。
//
// 段感知渲染（09-22-env-config-unification，决策 D14「三套环境一套变量」）：
//   模板中以 `[env.<name>]` / `[env.<name>.*]` / `[[env.<name>.*]]` 表头开始的段落 = **环境段**，
//   其余段落（含任何表头之前的顶层键，如 `name` / `routes` / `assets`）= **基段**。同一个 token 名
//   在两段各自取值：
//     基段：process.env[K] → .dev.vars[K] → DEFAULT_VALUES[K]
//     环境段：process.env[K] → .dev.vars.staging[K] → .dev.vars[K] → DEFAULT_VALUES[K]
//   于是同一份模板同时产出两个环境的正确内容，**部署哪个环境只由 `wrangler deploy [--env staging]`
//   这个运行参数决定** —— 这也正是 `--env` 渲染参数被移除的原因（平铺替换时代它会把顶层段也渲染成
//   staging 值，`name` / `routes` / D1 id 全部错位，忘了重渲染就留下毒化的生成物）。
//
// 安全约束：
//   - 仅读取模板中出现的白名单 token（TOKENS）；值文件其他键（含 secrets）不透传。
//   - 值含本地占位特征（localhost / placeholder- / @example.com）时输出 WARN（部署前须确认）；
//     渲染后非注释行残留 {TOKEN} 直接 fail（防模板新增 token 忘登记）。
//   - stdout 摘要**不含任何值**（占位 WARN 只报 token 名与命中的特征，不回显值本身）。
//
// 用法：
//   node scripts/render-wrangler-config.mjs            # 渲染（缺键 fail-fast，不写坏文件）
//   node scripts/render-wrangler-config.mjs --check    # 仅校验，不写文件（CI/pre-hook 用）
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SECTION_BASE,
  SECTION_ENV,
  classifySections,
  collectTokenOccurrences,
  extractWorkerNames,
  renderBySection,
} from "./lib/toml-sections.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(ROOT, "wrangler.toml.template");
const OUTPUT_PATH = join(ROOT, "wrangler.toml");
const DOT_VARS = join(ROOT, ".dev.vars");
const DOT_VARS_STAGING = join(ROOT, ".dev.vars.staging");

// 白名单：与 .trellis/spec/governance/config-inventory.md「RENDER-ENV 移管清单」一一对应（20 键）。
// 计数口径 = 本集合元素个数（非模板 {TOKEN} 出现次数：同名 token 在顶层段与环境段各出现一次）。
// 顶层 [vars] 运行时配置（BETTER_AUTH_URL 等）与 infra 键同策略烘焙——wrangler 4.x 不解析
// {KEY}，值必须在构建期就位。本地默认值（localhost / 占位）来自 .dev.vars，仅用于本地 dev
// （wrangler dev 时 .dev.vars 优先于 [vars]，不受影响）；部署真实值走 shell export 覆盖。
const TOKENS = new Set([
  // --- infra 结构键（基段与管理段同名共用；值文件各给一份） ---
  "WORKER_NAME",
  "DOMAIN",
  "D1_DB_NAME",
  "D1_DB_ID",
  "KV_ID",
  "QUEUE_NAME",
  "BILLING_QUEUE_NAME",
  // --- [vars] 运行时配置（基段 = .dev.vars / 环境段 = .dev.vars.staging） ---
  "API_KEY_PREFIX",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_ALLOWED_EMAILS",
  "REQUEST_LOG_RETENTION_DAYS",
  "CACHE_ENABLED",
  "MODELCAP_BASE_TOKENS",
  "MODELCAP_MULTIPLIER",
  "SIGNUP_BONUS_AMOUNT",
  "EMAIL_VERIFY_BONUS_AMOUNT",
  "EMAIL_VERIFICATION_ENABLED",
  "EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED",
  // 事务邮件收件人白名单（08-27-email-notification）：**空是合法配置**（= 全放行），见 EMPTY_ALLOWED。
  "EMAIL_ALLOWED_RECIPIENTS",
]);

/**
 * 允许空值的 token：空是**合法配置**（空 = 全放行，见 src/lib/email.ts 的 parseEmailAllowlist），
 * 而非「缺配置」。其余 token 取值为空仍 fail-fast。
 * 注意：通道本身另有缺省闸门 —— RESEND_API_KEY（secret，不进本渲染）为空时整个邮件通道关闭。
 */
const EMPTY_ALLOWED = new Set(["EMAIL_ALLOWED_RECIPIENTS"]);

/** 本地占位特征：命中即 WARN（仅提醒，不 fail——本地 dev 渲染本来就该是这些值）。 */
const PLACEHOLDER_HINTS = [/localhost/i, /placeholder-/, /@example\.com/i, /REPLACE/i];

/** 可选 token 的默认值（缺失不报错，取默认；默认链末端）。**不得出现环境专用键**：环境差异靠值文件。 */
// CACHE_ENABLED 可选（09-03）：缺省 "false"（全局缓存默认关闭），显式设 "true" 才启用；
// DEFAULT 非空避免 fail-fast（与 fail-fast 语义协调：缺省即合法值）。
const DEFAULT_VALUES = {
  API_KEY_PREFIX: "sk-",
  CACHE_ENABLED: "false",
  // modelcap 档位乘算常数缺省（09-16 kv-ops 档位化）：8192 × 2 = 16384 基准
  MODELCAP_BASE_TOKENS: "8192",
  MODELCAP_MULTIPLIER: "2",
  // 赠金与邮箱验证开关缺省（09-16-signup-bonus-grant）：金额 5（开箱即送）、验证关。
  // 默认值必须非空，否则缺配置会触发下面的 fail-fast。
  SIGNUP_BONUS_AMOUNT: "5",
  EMAIL_VERIFY_BONUS_AMOUNT: "5",
  EMAIL_VERIFICATION_ENABLED: "false",
  // 账户安全总开关缺省（09-21-email-admin-promotion-switch）：**"false" 就是缺省语义**
  // （缺省即禁止邮件注册账户提升为 admin）。DEFAULT 必须非空，否则缺配置会触发下面的 fail-fast。
  EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED: "false",
  // 事务邮件收件人白名单缺省（08-27-email-notification）：**空串**即缺省语义（空 = 全放行，
  // prod 形态）。空值靠 EMPTY_ALLOWED 放行 —— 见该集合的注释。
  EMAIL_ALLOWED_RECIPIENTS: "",
};

// 解析 .dev.vars：KEY=VALUE 行 + # 注释 + 双/单引号剥离（手写解析，零依赖）。
function parseDotVars(file) {
  const values = {};
  if (!existsSync(file)) return values;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parseArgs() {
  const args = process.argv.slice(2);
  // `--env` 已随段感知改造移除（R-E8）。**等号形态必须一并拦**：只精确匹配 `--env` 时
  // `--env=staging` 会被当成"无害的未知参数"放行，旧命令于是静默退化成"照常渲染了一遍"——
  // 恰是 R-E8 要消灭的那种"悄悄变成别的事"。
  if (args.some((a) => a === "--env" || a.startsWith("--env="))) {
    fail(
      "--env 参数已移除：渲染已改为段感知，一次执行即同时产出两个环境的正确内容。\n" +
        "  staging 的值请写进 .dev.vars.staging（与 .dev.vars 同名键，见 .dev.vars.staging.example），\n" +
        "  部署哪个环境只由 `wrangler deploy [--env staging]` 决定。",
    );
  }
  // 其余未知参数同样 fail-fast：`--chek` 这类拼写错误否则会静默变成"确实写了文件"。
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length) {
    fail(`无法识别的参数：${unknown.join(" ")}（本脚本只接受 --check）`);
  }
  return { check: args.includes("--check") };
}

function fail(message, keys = []) {
  const detail = keys.length
    ? `\n  缺失键（按段写入对应值文件，或用同名环境变量注入）:\n${keys.map((k) => `    - ${k}`).join("\n")}`
    : "";
  console.error(`[render-wrangler-config] ✗ ${message}${detail}`);
  process.exit(1);
}

const { check } = parseArgs();

if (!existsSync(TEMPLATE_PATH)) {
  fail(`模板不存在: ${TEMPLATE_PATH}`);
}
const template = readFileSync(TEMPLATE_PATH, "utf8");

// --- 逐行状态机：标注每行所属的段（R-E6）。判定逻辑在 scripts/lib/toml-sections.mjs（与单测共用）。
const scanned = classifySections(template.split(/\r?\n/));

// 模板中出现的全部 {TOKEN}（不含嵌套/值内花括号，wrangler.toml 仅用 {KEY} 形态），**带段标注**。
const occurrences = collectTokenOccurrences(scanned);
const unknown = [...new Set(occurrences.map((o) => o.token))].filter((t) => !TOKENS.has(t));
if (unknown.length) {
  fail(`模板包含未知 token（不在白名单 TOKENS）: ${unknown.join(", ")}`);
}

// --- 值源（R-E7）。两个值文件都只提供白名单键；缺文件即空对象。
const baseSource = parseDotVars(DOT_VARS);
const stagingSourceExists = existsSync(DOT_VARS_STAGING);
const stagingSource = stagingSourceExists ? parseDotVars(DOT_VARS_STAGING) : {};

function lookup(token, sec) {
  const chain =
    sec === SECTION_ENV
      ? [process.env, stagingSource, baseSource, DEFAULT_VALUES]
      : [process.env, baseSource, DEFAULT_VALUES];
  for (const source of chain) {
    const value = source[token];
    if (value !== undefined && value !== null) return value;
  }
  return "";
}

// --- 逐 (token, 段) 求值。**校验只针对"模板中实际出现的 token"**，不比对两个值文件的键集合是否
// 相等：某 token 只在一侧出现（如只在 [env.staging] routes 里的环境专属域名）是合法形态，另一侧
// 不该被要求提供它。
const values = {}; // `${section}:${token}` -> 渲染值
const warnedPlaceholder = new Set();
const missing = [];
for (const { token, section: sec } of occurrences) {
  const key = `${sec}:${token}`;
  if (key in values || missing.some((m) => m.key === key)) continue;
  const raw = lookup(token, sec);
  if (!raw.trim() && !EMPTY_ALLOWED.has(token)) {
    missing.push({
      key,
      label: `${token}（${sec === SECTION_ENV ? "环境段" : "基段"}）`,
    });
    continue;
  }
  if (/["\\\r\n]/.test(raw)) {
    fail(`token ${token} 的值含非法字符（" \\ 换行），会破坏 TOML`);
  }
  const trimmed = raw.trim();
  // 占位 WARN：只报 token 名与命中的特征，**不回显值**（值可能是 PII/域名，且摘要承诺不含值）。
  if (!(token in process.env) && !warnedPlaceholder.has(key)) {
    const hit = PLACEHOLDER_HINTS.find((re) => re.test(trimmed));
    if (hit) {
      warnedPlaceholder.add(key);
      console.warn(
        `  ⚠ ${token}（${sec === SECTION_ENV ? "环境段" : "基段"}）命中本地占位特征（${hit.source}）——部署请 export 同名环境变量覆盖`,
      );
    }
  }
  values[key] = trimmed;
}
if (missing.length) {
  fail("以下 token 缺值（fail-fast，未写出生成物）", missing.map((m) => m.label));
}

// 缺 .dev.vars.staging 时环境段整体回退到 .dev.vars（R-E9）。**不 fail-fast**：predev / pretest
// 都会渲染，全新 clone 没有该文件时不能直接挂。但必须喊出来——否则"stg 已配好"是错觉。
if (!stagingSourceExists) {
  console.warn(
    `  ⚠ ${DOT_VARS_STAGING.replace(ROOT, ".")} 不存在，环境段（[env.*]）当前回退为本地值 ——\n` +
      "    此时 staging 段与顶层段取值相同（含 worker 名），**不能据此部署 staging**。\n" +
      "    创建：cp .dev.vars.staging.example .dev.vars.staging 后填入各环境的真实值。",
  );
}

// modelcap 常数不得按环境分叉：render:modelcaps 只读 .dev.vars 的顶层值，生成的档位表
// （src/generated/modelcaps.ts，两环境共享的代码）无法分叉。若环境段在这两个键上给出与基段不同的
// 值，[vars] 宣称的 cap 与代码里烘焙的档位就不一致 —— 静默错账，必须喊出来（只报 token 名，不报值）。
for (const token of ["MODELCAP_BASE_TOKENS", "MODELCAP_MULTIPLIER"]) {
  const envValue = values[`${SECTION_ENV}:${token}`];
  const baseValue = values[`${SECTION_BASE}:${token}`];
  if (envValue !== undefined && baseValue !== undefined && envValue !== baseValue) {
    console.warn(
      `  ⚠ ${token} 在环境段与基段取值不同 —— render:modelcaps 只读 .dev.vars 的顶层值，\n` +
        "    生成的档位表（src/generated/modelcaps.ts）为两环境共享、无法分叉，\n" +
        "    该环境将拿到与代码不一致的 cap。确需分叉要先解决档位表的生成方式。",
    );
  }
}

// --- 渲染：按行所属段取该段的值替换（全量烘焙，wrangler 4.x 不做运行时插值）。
const rendered = renderBySection(scanned, (token, section) => values[`${section}:${token}`]);

// fail-safe：非注释行不得残留 {TOKEN}（模板新增 token 忘登记白名单 / 替换遗漏时拦截）。
const residual = [...rendered.split(/\r?\n/)]
  .filter((l) => !l.trim().startsWith("#"))
  .map((l) => l.match(/\{([A-Z0-9_]+)\}/))
  .filter(Boolean)
  .map((m) => m[1]);
if (residual.length) {
  fail(`渲染后仍残留未展开 token: ${[...new Set(residual)].join(", ")}`);
}

// --- 环境 worker 名不得等于顶层（R-E10）：wrangler 以此为环境标识，同名意味着 `--env <name>`
// 会部署到生产 worker 上。现状靠值本身的差异恰好成立，改造后必须显式拦截。
const { top: topWorkerName, envNames } = extractWorkerNames(rendered);
for (const [name, workerName] of envNames) {
  if (workerName !== topWorkerName) continue;
  if (!stagingSourceExists) {
    // 缺文件导致的回退：上面已给 WARN，这里只补充后果，不 fail（见 R-E9 与 AC-E5）。
    console.warn(
      `  ⚠ [env.${name}].name 与顶层相同（${topWorkerName}）—— 这是上面"环境段回退"的直接后果。\n` +
        `    创建 .dev.vars.staging 并设置不同的 WORKER_NAME 后即可正常渲染。`,
    );
    continue;
  }
  fail(
    `[env.${name}].name 渲染后等于顶层 name（${topWorkerName}）—— wrangler 要求两个环境的 worker 名不同，\n` +
      `  否则 \`wrangler deploy --env ${name}\` 会部署到生产 worker 上。\n` +
      `  请在 .dev.vars.staging 中为 WORKER_NAME 给出该环境自己的值（当前值来自值文件，非默认值）。`,
  );
}

// --- 误发护栏（R-E11）：与 prod **共用同一把 Resend 账号**，而「空白名单 = 全放行」是 prod 语义
// —— 在 staging 上它几乎只能是漏配。危险组合 = 开关开 + 名单空：此时任何在 stg 注册的**真实邮箱**
// 都会收到信。**仅告警不 fail**（空值仍是合法配置，见 EMPTY_ALLOWED），只把危险组合喊出来。
// R-E11 起**每次渲染都检查**（不再需要 `--env staging` 才会跑）——段感知后 staging 值恒可得。
// 另注意 fail-fast 网兜不住这两个键 —— 它们在 DEFAULT_VALUES 里有缺省值。
// 判据与 src/lib/bonus.ts 的 isEmailVerificationEnabled 保持同一套真值集合（true/1/yes/on）。
const truthy = new Set(["true", "1", "yes", "on"]);
// 判据必须与运行时**同一套语义**：src/lib/email.ts 的 parseEmailAllowlist 会 trim + 丢弃空项，
// 故 "," / " , " 与 "" 在运行时都解析为空数组 = 全放行。只判 `=== ""` 会让「删地址时留下尾逗号」
// 这一常见手误静默关掉护栏——护栏不能有"看着还在、其实已失效"的形态。文案不变（R-E11）。
const isEmptyAllowlist = (raw) => (raw ?? "").split(",").filter((part) => part.trim() !== "").length === 0;
const envVerifySwitch = values[`${SECTION_ENV}:EMAIL_VERIFICATION_ENABLED`];
const envAllowlist = values[`${SECTION_ENV}:EMAIL_ALLOWED_RECIPIENTS`];
if (envVerifySwitch !== undefined && truthy.has(envVerifySwitch.toLowerCase()) && isEmptyAllowlist(envAllowlist)) {
  console.warn(
    "  ⚠ 环境段的 EMAIL_VERIFICATION_ENABLED 为开，但 EMAIL_ALLOWED_RECIPIENTS 为空（= 全放行）——\n" +
      "    staging 将能向任意真实邮箱发信（与 prod 共用 Resend 账号）。\n" +
      "    部署前请在 .dev.vars.staging 设 EMAIL_ALLOWED_RECIPIENTS=<测试邮箱>（逗号分隔多个）。",
  );
}

const tokenCount = new Set(occurrences.map((o) => o.token)).size;
if (check) {
  console.log(
    `[render-wrangler-config] ✓ 校验通过（${tokenCount} 个 token 就绪：基段 ← .dev.vars；` +
      `环境段 ← .dev.vars.staging）`,
  );
  process.exit(0);
}

writeFileSync(OUTPUT_PATH, rendered);
console.log(
  `[render-wrangler-config] ✓ 已生成 wrangler.toml（${tokenCount} 个 token 就绪，来源：` +
    `基段 ← .dev.vars；环境段 ← .dev.vars.staging${stagingSourceExists ? "" : "（缺失，已回退）"}）`,
);
