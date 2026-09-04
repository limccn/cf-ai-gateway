#!/usr/bin/env node
// 渲染 wrangler.toml：wrangler.toml.template + .dev.vars（+ process.env 白名单键）→ wrangler.toml。
//
// 背景（.trellis/spec/governance/config-inventory.md，本地 spec）：绑定级字段（name / routes / database_id / KV id /
// queue 名）与 [vars] 运行时配置都必须以 TOML 字面量烘焙进生成物——wrangler 4.x **实测不解析**
// `{KEY}` 占位符（`wrangler deploy --dry-run` 输出 `env.FOO ("{TEST_FOO}")`，字面量原样进运行时）。
// 因此所有环境差异值统一收进 .dev.vars / process.env，模板驱动渲染（生成物 gitignored）。
//
// 安全约束：
//   - 仅读取模板中出现的白名单 token（TOKENS）；.dev.vars 其他键（含 secrets）不透传。
//   - [vars] 段的 {KEY} 同样烘焙字面量：值链 process.env → .dev.vars →（--env staging）
//     STAGING_* 键覆盖 → DEFAULT_VALUES。部署真实值时在部署 shell export 同名环境变量覆盖。
//   - 值含本地占位特征（localhost / placeholder- / @example.com）时输出 WARN（部署前须确认）；
//     渲染后非注释行残留 {TOKEN} 直接 fail（防模板新增 token 忘登记）。
//   - 输出仅写入 wrangler.toml，stdout 摘要不含任何值。
//
// 用法：
//   node scripts/render-wrangler-config.mjs            # 渲染（缺键 fail-fast，不写坏文件）
//   node scripts/render-wrangler-config.mjs --check    # 仅校验，不写文件（CI/pre-hook 用）
//   node scripts/render-wrangler-config.mjs --env staging   # staging 值取 STAGING_* 键（.dev.vars / env）
//   node scripts/render-wrangler-config.mjs --env staging --check
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(ROOT, "wrangler.toml.template");
const OUTPUT_PATH = join(ROOT, "wrangler.toml");
const DOT_VARS = join(ROOT, ".dev.vars");
const DOT_VARS_STAGING = join(ROOT, ".dev.vars.staging");

// 白名单：与 .trellis/spec/governance/config-inventory.md「RENDER-ENV 移管清单」一一对应（26 键）。
// 顶层 [vars] 运行时配置（BETTER_AUTH_URL 等）与 infra 键同策略烘焙——wrangler 4.x 不解析
// {KEY}，值必须在构建期就位。本地默认值（localhost / 占位）来自 .dev.vars，仅用于本地 dev
// （wrangler dev 时 .dev.vars 优先于 [vars]，不受影响）；部署真实值走 shell export 覆盖。
const TOKENS = new Set([
  "WORKER_NAME",
  "DOMAIN",
  "D1_DB_NAME",
  "D1_DB_ID",
  "KV_ID",
  "QUEUE_NAME",
  "BILLING_QUEUE_NAME",
  "STAGING_WORKER_NAME",
  "STAGING_DOMAIN",
  "STAGING_D1_DB_NAME",
  "STAGING_D1_DB_ID",
  "STAGING_KV_ID",
  "STAGING_QUEUE_NAME",
  "STAGING_BILLING_QUEUE_NAME",
  // 顶层 [vars]：本地默认（.dev.vars）或部署 shell export 覆盖（process.env 优先）。
  "API_KEY_PREFIX",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_ALLOWED_EMAILS",
  "REQUEST_LOG_RETENTION_DAYS",
  "CACHE_ENABLED",
  // [env.staging.vars]：STAGING_* 独立键，与 infra 键同源管理（--env staging 渲染）。
  "STAGING_API_KEY_PREFIX",
  "STAGING_BETTER_AUTH_URL",
  "STAGING_GITHUB_CLIENT_ID",
  "STAGING_GITHUB_ALLOWED_EMAILS",
  "STAGING_REQUEST_LOG_RETENTION_DAYS",
  "STAGING_CACHE_ENABLED",
]);

/** 本地占位特征：命中即 WARN（仅提醒，不 fail——本地 dev 渲染本来就该是这些值）。 */
const PLACEHOLDER_HINTS = [/localhost/i, /placeholder-/, /@example\.com/i, /REPLACE/i];

/** 可选 token 的默认值（缺失不报错，取默认；默认链：process.env → .dev.vars → DEFAULT_VALUES）。 */
// CACHE_ENABLED / STAGING_CACHE_ENABLED 可选（09-03）：缺省 "false"（全局缓存默认关闭），
// 显式设 "true" 才启用；DEFAULT 非空避免 fail-fast（与 fail-fast 语义协调：缺省即合法值）。
const DEFAULT_VALUES = { API_KEY_PREFIX: "sk-", CACHE_ENABLED: "false", STAGING_CACHE_ENABLED: "false" };

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
  const envFlag = args.indexOf("--env");
  const env = envFlag >= 0 ? args[envFlag + 1] : undefined;
  return { env, check: args.includes("--check") };
}

function fail(message, keys = []) {
  const detail = keys.length ? `\n  缺失键（按环境注入 .dev.vars / CI 环境变量）:\n${keys.map((k) => `    - ${k}`).join("\n")}` : "";
  console.error(`[render-wrangler-config] ✗ ${message}${detail}`);
  process.exit(1);
}

const { env, check } = parseArgs();

if (!existsSync(TEMPLATE_PATH)) {
  fail(`模板不存在: ${TEMPLATE_PATH}`);
}
const template = readFileSync(TEMPLATE_PATH, "utf8");

// 模板中出现的全部 {TOKEN}（不含嵌套/值内花括号，wrangler.toml 仅用 {KEY} 形态）。
// 注释行（# 开头）不参与提取/替换——注释中的 "{KEY}" 字样是说明文字，不是 token。
const templateLines = template.split(/\r?\n/);
const activeText = templateLines
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");
const templateTokens = [...activeText.matchAll(/\{([A-Z0-9_]+)\}/g)].map((m) => m[1]);
const unknown = [...new Set(templateTokens)].filter((t) => !TOKENS.has(t));
if (unknown.length) {
  fail(`模板包含未知 token（不在白名单 TOKENS）: ${unknown.join(", ")}`);
}

// 取值链：.dev.vars → （--env staging 时）.dev.vars.staging 覆盖 → process.env 白名单键覆盖。
// 注意顺序：Object.assign 后者赢，staging 文件必须 push 在 .dev.vars 之后才能覆盖同名键。
const sources = [parseDotVars(DOT_VARS)];
if (env === "staging") sources.push(parseDotVars(DOT_VARS_STAGING));
const fromVars = Object.assign({}, ...sources);
const values = {};
const missing = [];
for (const token of templateTokens) {
  const value = process.env[token] ?? fromVars[token] ?? DEFAULT_VALUES[token] ?? "";
  if (!value.trim()) {
    missing.push(token);
    continue;
  }
  if (/["\\\r\n]/.test(value)) {
    fail(`token ${token} 的值含非法字符（" \\ 换行），会破坏 TOML`);
  }
  const v = value.trim();
  if (!(token in process.env) && PLACEHOLDER_HINTS.some((re) => re.test(v))) {
    console.warn(`  ⚠ ${token} 命中本地占位特征（${v.length > 60 ? v.slice(0, 57) + "…" : v}）——部署请 export 同名环境变量覆盖`);
  }
  values[token] = v;
}
if (missing.length) {
  fail("以下 token 缺值（fail-fast，未写出生成物）", missing);
}

// 渲染：非注释行白名单 token 逐项替换（全量烘焙，wrangler 4.x 不做运行时插值）。
const rendered = templateLines
  .map((line) => {
    if (line.trim().startsWith("#")) return line;
    let out = line;
    for (const [token, value] of Object.entries(values)) {
      out = out.replaceAll(`{${token}}`, value);
    }
    return out;
  })
  .join("\n");

// fail-safe：非注释行不得残留 {TOKEN}（模板新增 token 忘登记白名单 / 替换遗漏时拦截）。
const residual = [...rendered.split(/\r?\n/)]
  .filter((l) => !l.trim().startsWith("#"))
  .map((l) => l.match(/\{([A-Z0-9_]+)\}/))
  .filter(Boolean)
  .map((m) => m[1]);
if (residual.length) {
  fail(`渲染后仍残留未展开 token: ${[...new Set(residual)].join(", ")}`);
}

if (check) {
  console.log(`[render-wrangler-config] ✓ 校验通过（${Object.keys(values).length} 个 token 就绪${env === "staging" ? "，env=staging" : ""}）`);
  process.exit(0);
}

writeFileSync(OUTPUT_PATH, rendered);
const source = env === "staging" ? ".dev.vars.staging + .dev.vars" : ".dev.vars";
console.log(`[render-wrangler-config] ✓ 已生成 wrangler.toml（${Object.keys(values).length} 个 token 就绪，来源 ${source}）`);
