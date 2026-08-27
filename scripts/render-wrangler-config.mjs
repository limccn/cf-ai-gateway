#!/usr/bin/env node
// 渲染 wrangler.toml：wrangler.toml.template + .dev.vars[.staging]（+ process.env 白名单键）→ wrangler.toml。
//
// 背景（docs/CONFIG-INVENTORY.md）：wrangler 的 {KEY} 插值仅 [vars] 段支持，绑定级字段
// （name / routes / database_id / KV id / queue 名）必须是 TOML 字面量。本脚本把这类
// infra 结构性配置统一收进 .dev.vars 管理（模板驱动渲染，生成物 gitignored）。
//
// 安全约束：
//   - 仅读取模板中出现的白名单 token（TOKENS）；.dev.vars 其他键（含 secrets）不透传。
//   - [vars] 段的 {KEY}（KEEP_INTERP）是 wrangler 原生插值，渲染不展开。
//   - 输出仅写入 wrangler.toml，stdout 摘要不含任何值。
//
// 用法：
//   node scripts/render-wrangler-config.mjs            # 渲染（缺键 fail-fast，不写坏文件）
//   node scripts/render-wrangler-config.mjs --check    # 仅校验，不写文件（CI/pre-hook 用）
//   node scripts/render-wrangler-config.mjs --env staging   # 优先读 .dev.vars.staging，回退 .dev.vars
//   node scripts/render-wrangler-config.mjs --env staging --check
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(ROOT, "wrangler.toml.template");
const OUTPUT_PATH = join(ROOT, "wrangler.toml");
const DOT_VARS = join(ROOT, ".dev.vars");
const DOT_VARS_STAGING = join(ROOT, ".dev.vars.staging");

// 白名单：与 docs/CONFIG-INVENTORY.md「RENDER-ENV 移管清单」一一对应（12 键）。
const TOKENS = new Set([
  "WORKER_NAME",
  "DOMAIN",
  "D1_DB_NAME",
  "D1_DB_ID",
  "KV_ID",
  "QUEUE_NAME",
  "STAGING_WORKER_NAME",
  "STAGING_DOMAIN",
  "STAGING_D1_DB_NAME",
  "STAGING_D1_DB_ID",
  "STAGING_KV_ID",
  "STAGING_QUEUE_NAME",
]);

// [vars] 原生 {KEY} 插值（wrangler 运行时解析），渲染必须保留不展开。
const KEEP_INTERP = new Set([
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_ALLOWED_EMAILS",
  "REQUEST_LOG_RETENTION_DAYS",
  "API_KEY_PREFIX",
]);

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
const unknown = [...new Set(templateTokens)].filter((t) => !TOKENS.has(t) && !KEEP_INTERP.has(t));
if (unknown.length) {
  fail(`模板包含未知 token（不在白名单 TOKENS / KEEP_INTERP）: ${unknown.join(", ")}`);
}

// 取值链：.dev.vars → （--env staging 时）.dev.vars.staging 覆盖 → process.env 白名单键覆盖。
const sources = [parseDotVars(DOT_VARS)];
if (env === "staging") sources.unshift(parseDotVars(DOT_VARS_STAGING));
const fromVars = Object.assign({}, ...sources);
const values = {};
const missing = [];
for (const token of templateTokens) {
  if (KEEP_INTERP.has(token)) continue; // 原生插值，保留
  const value = process.env[token] ?? fromVars[token] ?? "";
  if (!value.trim()) {
    missing.push(token);
    continue;
  }
  if (/["\\\r\n]/.test(value)) {
    fail(`token ${token} 的值含非法字符（" \\ 换行），会破坏 TOML`);
  }
  values[token] = value.trim();
}
if (missing.length) {
  fail("以下 token 缺值（fail-fast，未写出生成物）", missing);
}

// 渲染：非注释行白名单 token 逐项替换；[vars] 的 {KEY} 不在替换集合内，自然保留。
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

if (check) {
  console.log(`[render-wrangler-config] ✓ 校验通过（${Object.keys(values).length} 个 token 就绪${env === "staging" ? "，env=staging" : ""}）`);
  process.exit(0);
}

writeFileSync(OUTPUT_PATH, rendered);
const source = env === "staging" ? ".dev.vars.staging + .dev.vars" : ".dev.vars";
console.log(`[render-wrangler-config] ✓ 已生成 wrangler.toml（${Object.keys(values).length} 个 token 就绪，来源 ${source}）`);
