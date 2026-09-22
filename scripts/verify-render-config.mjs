#!/usr/bin/env node
// 渲染体系验收（09-22-env-config-unification，AC-E1..AC-E10）。
//
// **为什么在 Node 侧**：vitest 跑在 Workers pool（workerd）里没有 node:fs —— 凡是要读真实文件、
// 起子进程、临时挪走值文件的断言都只能在这里做。纯判定逻辑的边界用例在
// tests/render-config.unit.test.ts，两边互补、不重复。
//
// 刻意的独立性：本脚本**不复用** scripts/lib/toml-sections.mjs 的段判定，也不用渲染脚本的值解析，
// 而是用「按字面表头切两半 + 极简 `key = "值"` 读取」这套笨办法独立读生成物。渲染器与校验器共用
// 同一套判定逻辑的话，判定逻辑本身错了会两边一起错 —— 校验就成了自证。
//
// 用法：
//   node scripts/verify-render-config.mjs                 # 快检（不动任何文件的那些 AC）
//   node scripts/verify-render-config.mjs --with-dry-run  # 另跑两次 wrangler deploy --dry-run（慢，~1min）
//   node scripts/verify-render-config.mjs --with-mutation # 另做「破坏性」用例：AC-E5/E6/E8 需临时挪走
//                                                          # 或改写 .dev.vars.staging（finally 还原 + 校验）
//
// 覆盖：AC-E1a/E1b/E1c/E2/E3/E5(检查态)/E7/E9/E10 + AC-E6/E8（需 --with-mutation）+ AC-E3 dry-run（需 --with-dry-run）。
// AC-E4（npm test / typecheck / lint / dev 起服）不在本脚本内 —— 跑全量测试不能从测试链里再起测试。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "./lib/e2e-utils.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const WITH_DRY_RUN = args.includes("--with-dry-run");
const WITH_MUTATION = args.includes("--with-mutation");

const TEMPLATE = join(ROOT, "wrangler.toml.template");
const RENDER_SCRIPT = join(ROOT, "scripts", "render-wrangler-config.mjs");
const ENTRY_SCRIPT = join(ROOT, "scripts", "render-config.mjs");
const OUTPUT = join(ROOT, "wrangler.toml");
const DOT_VARS = join(ROOT, ".dev.vars");
const DOT_VARS_STAGING = join(ROOT, ".dev.vars.staging");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const { report, summary } = createHarness({ label: "render-config" });
const skip = (name, why) => console.log(`  SKIP  ${name}  <- ${why}`);

// ---------------------------------------------------------------- 执行与读取

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
  return {
    status: r.status ?? (r.error ? -1 : 1),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
  };
}

/** 直接跑渲染脚本（不走 npm）—— 参数必定到达，用于需要精确控制参数的用例。 */
const renderScript = (renderArgs = []) => run(process.execPath, [RENDER_SCRIPT, ...renderArgs]);

/**
 * 走 npm 入口 —— AC-E7 验的正是「npm 把 `--` 之后的参数追加到脚本命令串**末尾**」这一事实，
 * 必须从 npm 进，直接 spawn 渲染脚本验不到。
 * Windows 走 cmd.exe 而非 `shell: true`：后者在 Node 22+ 触发 DEP0190（参数不转义直接拼接）。
 * 这里的参数全是本脚本内的字面量，无外部输入。
 */
function npmRender(npmArgs = []) {
  const argv = ["run", "render:config", ...npmArgs];
  return process.platform === "win32"
    ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...argv])
    : run(NPM, argv);
}

const read = (file) => readFileSync(file, "utf8");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);

/** 极简 dotenv：`KEY=VALUE` + `# 注释` + 引号剥离。与渲染脚本各自的实现，互不背书。 */
function parseEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of read(file).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * 极简 TOML 读取：取每行里所有 `key = "值"` 对（本模板的值一律带引号），同键多值收集成数组。
 * 正则**不锚定行首**：`routes` 是多行数组，条目写成 `  { pattern = "x", custom_domain = true },`
 * —— 锚行首就一条都读不到（第一版就栽在这里，AC-E3 的 pattern 断言全成了空对空）。
 * 仍不做通用 TOML 解析，只需要能独立读出生成物里的 name / pattern / queue 等字段。
 */
function tomlValues(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    for (const m of line.matchAll(/([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(m[2]);
    }
  }
  return out;
}
const one = (map, key) => (map.get(key) ?? [])[0];
const all = (map, key) => [...new Set(map.get(key) ?? [])].sort();

/**
 * 按**字面表头**把生成物切成基段 / 环境段两半 —— 刻意不用段判定函数（否则校验器与渲染器共用
 * 同一处逻辑，那处错了会一起错）。`[env.staging]` 之后的所有 `[env.staging.*]` / `[[env.staging.*]]`
 * 也都归环境段，因为它们在文件里全部位于该表头之后。
 */
function splitRendered(text) {
  const marker = "\n[env.staging]\n";
  const at = text.indexOf(marker);
  if (at < 0) return null;
  return { base: tomlValues(text.slice(0, at)), env: tomlValues(text.slice(at)) };
}

/** 期望值：process.env 优先（部署 shell export 覆盖是既有约定），其次值文件。 */
function expectFrom(files, key) {
  if (process.env[key] !== undefined && process.env[key] !== null) {
    return { value: process.env[key], from: "process.env" };
  }
  for (const [file, values] of files) {
    if (values[key] !== undefined) return { value: values[key], from: file };
  }
  return { value: undefined, from: null };
}

/** 临时改写值文件 → 跑一段 → **无论成败都还原**（finally + 字节校验）。 */
function withPatchedFile(file, patch, fn) {
  const original = read(file);
  const backup = `${file}.bak-verify`;
  copyFileSync(file, backup);
  try {
    writeFileSync(file, patch(original));
    return fn();
  } finally {
    writeFileSync(file, original);
    const restored = read(file) === original;
    rmSync(backup, { force: true });
    if (!restored) {
      console.error(`[verify] ✗ ${file} 还原失败 —— 备份在 ${backup}，请手工恢复`);
      process.exit(1);
    }
  }
}

/** 临时把文件挪走（还原同样走 finally + 字节校验 —— 只查存在性会放过"还原成别的内容"）。 */
function withoutFile(file, fn) {
  const original = read(file);
  const backup = `${file}.bak-verify`;
  copyFileSync(file, backup);
  rmSync(file, { force: true });
  try {
    return fn();
  } finally {
    copyFileSync(backup, file);
    rmSync(backup, { force: true });
    if (!existsSync(file) || read(file) !== original) {
      console.error(`[verify] ✗ ${file} 还原失败 —— 备份在 ${backup}，请手工恢复`);
      process.exit(1);
    }
  }
}

const ok = (r) => r.status === 0;
const bag = (r) => `${r.stdout}\n${r.stderr}`;

/** `.dev.vars.staging` 的一行键（缺失 = 该键不存在）。 */
function setKey(text, key, value) {
  const line = `${key}=${value}`;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return lines.join("\n");
}

// ---------------------------------------------------------------- AC-E1 / E10：静态扫描

/** 骨架：仓库内文件扫描（跳过依赖、产物、git 与校验脚本自身）。 */
function repoFiles(relDirs) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === "dist" || name === ".wrangler") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  for (const rel of relDirs) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
  return files;
}

/**
 * 非注释行中出现的 `<needle>`（注释里的历史说明允许，但必须是"说明"而非活配置）。
 * 返回命中行（`文件:行号: 内容`）。
 */
function nonCommentHits(files, needle) {
  const hits = [];
  for (const file of files) {
    read(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (line.trim().startsWith("#")) return;
        if (line.includes(needle)) hits.push(`${file.replace(ROOT, ".")}:${i + 1}: ${line.trim()}`);
      });
  }
  return hits;
}

// `STAGING_` 这个字面量在本脚本里出现会自己命中自己（脚本也在 scripts/ 下扫描范围内），
// 故拼出来 —— 除此之外全脚本不出现该字面量。
const STAGING_PREFIX = ["STAG", "ING_"].join("");

// 扫描面 = **活代码**：scripts/ + src/ + app/ + tests/ + 模板。历史记录（.trellis/tasks、journal）
// 刻意不在内——那里记载的是"当时用的是 STAGING 前缀键"，改写它等于篡改史实。
const codeFiles = repoFiles(["scripts", "src", "app", "tests", "wrangler.toml.template"]).filter(
  (f) => f !== fileURLToPath(import.meta.url),
);
const valueFiles = [DOT_VARS, join(ROOT, ".dev.vars.example"), join(ROOT, ".dev.vars.staging.example")].filter(
  existsSync,
);

{
  const hits = nonCommentHits(codeFiles, STAGING_PREFIX);
  report(
    `AC-E1a ${STAGING_PREFIX}* 在 scripts/ 与模板中归零（非注释）`,
    hits.length === 0,
    hits.slice(0, 5).join(" ; "),
  );
}
{
  const hits = nonCommentHits(valueFiles, STAGING_PREFIX);
  report(
    `AC-E1b ${STAGING_PREFIX}* 在 .dev.vars 与两个 example 中归零`,
    hits.length === 0,
    hits.slice(0, 5).join(" ; "),
  );
}
{
  // AC-E10 的文档面：**.trellis/ 全量 gitignore，`git grep` 在这里恒为 0（恒真假绿）**，
  // 故必须走文件系统扫描；本地无 .trellis（全新 clone）时显式 SKIP 而不是算通过。
  const spec = join(ROOT, ".trellis", "spec");
  const specFiles = existsSync(spec) ? repoFiles([join(".trellis", "spec")]) : [];
  // 活文档面 = CLAUDE.md + README.md + **全量** spec。原实现只扫 governance 子目录 + CLAUDE.md，
  // 于是 README.md 与 backend/environment.md 里的陈旧说明长期漏网（复核发现的覆盖缺口）。
  const liveDocs = [join(ROOT, "CLAUDE.md"), join(ROOT, "README.md")];
  const hits = nonCommentHits([...liveDocs, ...specFiles], "render:config -- --env");
  report("AC-E10a 活文档中无 `render:config -- --env`（文件系统扫描，非 git grep）", hits.length === 0, hits.slice(0, 5).join(" ; "));

  const docStale = nonCommentHits(liveDocs, STAGING_PREFIX);
  report(`AC-E1c ${STAGING_PREFIX}* 在 CLAUDE.md / README.md 中归零（非注释）`, docStale.length === 0, docStale.slice(0, 5).join(" ; "));

  if (!existsSync(spec)) skip("AC-E10b trellis spec 的 STAGING_ 残留", ".trellis/ 不存在（本地 spec 不入 git）");
  else {
    const stale = nonCommentHits(specFiles, STAGING_PREFIX);
    report("AC-E10b trellis spec（全类目）中无 STAGING_（非注释）", stale.length === 0, stale.slice(0, 5).join(" ; "));
  }
}

// ---------------------------------------------------------------- AC-E2：白名单与模板的一致

const source = read(RENDER_SCRIPT);
const blockOf = (name) => {
  const at = source.indexOf(`const ${name} = new Set([`);
  if (at < 0) return null;
  const end = source.indexOf("]);", at);
  return end < 0 ? null : source.slice(at, end);
};
const namesIn = (block) => [...(block ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);

const tokens = namesIn(blockOf("TOKENS"));
const emptyAllowed = namesIn(blockOf("EMPTY_ALLOWED"));

report("AC-E2a TOKENS 白名单恰 20 项", tokens.length === 20, `实际 ${tokens.length} 项`);
report(
  `AC-E2b TOKENS 无 ${STAGING_PREFIX}* 残留`,
  tokens.every((t) => !t.includes(STAGING_PREFIX)),
  tokens.filter((t) => t.includes(STAGING_PREFIX)).join(", "),
);
{
  const defaultsAt = source.indexOf("const DEFAULT_VALUES = {");
  const defaultsBlock = defaultsAt < 0 ? "" : source.slice(defaultsAt, source.indexOf("\n};", defaultsAt));
  const staleKeys = [...defaultsBlock.matchAll(/^\s{2}([A-Z0-9_]+):/gm)].map((m) => m[1]).filter((k) => k.includes(STAGING_PREFIX));
  report(`AC-E2c DEFAULT_VALUES 无 ${STAGING_PREFIX}* 键`, staleKeys.length === 0, staleKeys.join(", "));
}
report(
  "AC-E2d EMPTY_ALLOWED 只留 EMAIL_ALLOWED_RECIPIENTS",
  emptyAllowed.length === 1 && emptyAllowed[0] === "EMAIL_ALLOWED_RECIPIENTS",
  emptyAllowed.join(", "),
);
{
  // 注释行里的 `{KEY}` 是说明文字（模板头部就在讲「wrangler 4.x 不解析 {KEY}」），不是 token
  // —— 不跳注释会得到一条假的「未登记 token」。
  const templateTokens = [
    ...new Set(
      read(TEMPLATE)
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("#"))
        .flatMap((l) => [...l.matchAll(/\{([A-Z0-9_]+)\}/g)].map((m) => m[1])),
    ),
  ];
  const unregistered = templateTokens.filter((t) => !tokens.includes(t));
  const dead = tokens.filter((t) => !templateTokens.includes(t));
  report("AC-E2e 模板 token 与白名单互相覆盖（无未登记 / 无死条目）", !unregistered.length && !dead.length,
    `未登记: ${unregistered.join(",") || "无"} ; 死条目: ${dead.join(",") || "无"}`);
}

// ---------------------------------------------------------------- AC-E3：一次渲染，两环境齐备

const baseValues = parseEnvFile(DOT_VARS);
const stagingValues = parseEnvFile(DOT_VARS_STAGING);
const hasStagingFile = existsSync(DOT_VARS_STAGING);

const renderOnce = renderScript([]);
report("AC-E3-pre 单次 `render:config`（直接调用）退出 0", ok(renderOnce), renderOnce.stderr.trim().slice(0, 200));

if (!ok(renderOnce)) {
  summary();
  process.exit(1);
}

const rendered = read(OUTPUT);
const halves = splitRendered(rendered);

if (!halves) {
  report("AC-E3 生成物含 [env.staging] 段", false, "未找到 `[env.staging]` 表头");
} else {
  const { base, env } = halves;
  const pairs = [
    ["name", "顶层 name vs [env.staging] name"],
    ["pattern", "routes pattern"],
    ["database_id", "d1 database_id"],
    ["id", "kv namespace id"],
    ["queue", "两个 queues 名"],
    ["BETTER_AUTH_URL", "[vars] BETTER_AUTH_URL"],
    ["GITHUB_CLIENT_ID", "[vars] GITHUB_CLIENT_ID"],
    ["GITHUB_ALLOWED_EMAILS", "[vars] GITHUB_ALLOWED_EMAILS"],
  ];
  for (const [key, label] of pairs) {
    const b = all(base, key);
    const e = all(env, key);
    const bothPresent = b.length > 0 && e.length > 0;
    const distinct = JSON.stringify(b) !== JSON.stringify(e);
    report(`AC-E3 段感知：${label} 两段各自有值且互不相同`, bothPresent && distinct,
      `基段 [${b.join(",")}] / 环境段 [${e.join(",")}]`);
  }

  // 逐字段对账：基段 ← .dev.vars，环境段 ← .dev.vars.staging（process.env 覆盖优先）。
  const expectations = [
    ["name", "WORKER_NAME", "base"],
    ["pattern", "DOMAIN", "base"],
    ["database_id", "D1_DB_ID", "base"],
    ["id", "KV_ID", "base"],
    ["BETTER_AUTH_URL", "BETTER_AUTH_URL", "base"],
  ];
  for (const [key, token, seg] of expectations) {
    const exp = expectFrom([[".dev.vars", baseValues]], token);
    const got = one(base, key);
    report(`AC-E3 基段 ${key} == ${exp.from}[${token}]`, exp.value !== undefined && got === exp.value,
      exp.value === undefined ? `${token} 未配置` : `期望 ${exp.value} / 实际 ${got}`);
  }
  for (const [key, token] of [["name", "WORKER_NAME"], ["pattern", "DOMAIN"], ["database_id", "D1_DB_ID"], ["id", "KV_ID"]]) {
    if (!hasStagingFile) continue;
    const exp = expectFrom([[".dev.vars.staging", stagingValues]], token);
    const got = one(env, key);
    report(`AC-E3 环境段 ${key} == .dev.vars.staging[${token}]`, exp.value !== undefined && got === exp.value,
      exp.value === undefined ? `${token} 未配置` : `期望 ${exp.value} / 实际 ${got}`);
  }

  report("AC-E3 顶层 name = cf-ai-gateway（生产 worker）", one(base, "name") === "cf-ai-gateway", String(one(base, "name")));
  report("AC-E3 [env.staging] name = cf-ai-gateway-staging", one(env, "name") === "cf-ai-gateway-staging", String(one(env, "name")));

  if (!hasStagingFile) skip("AC-E3 环境段逐字段对账", ".dev.vars.staging 不存在");

  // 不计数的一声提醒（不是失败项）：顶层段 = **生产值**，而它的值源 .dev.vars 同时服务本地 dev
  // —— 本地测试脚手架会被 predeploy 原样烘焙进生产 [vars]。覆盖手段是部署 shell export，
  // 但必须在发布前被看见（父任务 09-21-prod-release-prep 的发布窗口会踩到这里）。
  // 只报开合状态与名单长度，不回显邮箱（PII）。
  {
    const switchOn = ["true", "1", "yes", "on"].includes(String(one(base, "EMAIL_VERIFICATION_ENABLED") ?? "").toLowerCase());
    if (switchOn) {
      const len = String(one(base, "EMAIL_ALLOWED_RECIPIENTS") ?? "").length;
      console.log(
        "  ⚠ 顶层 [vars]（= 生产）EMAIL_VERIFICATION_ENABLED 为开，收件人白名单非空（长度 " + len + "）——\n" +
          "    这两个值直接来自 .dev.vars（本地 dev 与生产共用同一份），本地测试脚手架会被原样烘焙进生产。\n" +
          "    发布生产前：在部署 shell export 生产值，或把 .dev.vars 里的本地测试值注释掉后重渲染。",
      );
    }
  }
}

// ---------------------------------------------------------------- AC-E9：残留 token

{
  const residual = rendered
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("#"))
    .flatMap((l) => [...l.matchAll(/\{([A-Z0-9_]+)\}/g)].map((m) => m[1]));
  report("AC-E9 生成物非注释行无残留 {TOKEN}", residual.length === 0, [...new Set(residual)].join(", "));
}

// ---------------------------------------------------------------- AC-E5 / E6 / E8：临时改文件的用例

if (!hasStagingFile) {
  for (const name of ["AC-E5 缺 .dev.vars.staging 不炸", "AC-E6 name 冲突拦截", "AC-E8 误发护栏每次渲染都跑"]) {
    skip(name, ".dev.vars.staging 不存在");
  }
} else if (!WITH_MUTATION) {
  for (const name of ["AC-E5 缺 .dev.vars.staging 不炸", "AC-E6 name 冲突拦截", "AC-E8 误发护栏每次渲染都跑"]) {
    skip(name, "需 --with-mutation（会临时挪走/改写 .dev.vars.staging）");
  }
} else {
  // AC-E5：挪走值文件 → 必须**成功**（predev/pretest 会渲染，全新 clone 不能挂）且喊出后果。
  // 用 `--check` 跑：同样会走到回退分支与两条 WARN，但不写生成物（避免留下降级产物再靠重渲染收拾）。
  const missing = withoutFile(DOT_VARS_STAGING, () => renderScript(["--check"]));
  const text = bag(missing);
  report("AC-E5 缺 .dev.vars.staging 时渲染仍成功（不 fail-fast）", ok(missing), `exit=${missing.status}`);
  report("AC-E5 打印环境段回退 WARN", text.includes("环境段（[env.*]）当前回退为本地值"), text.trim().slice(-200));
  report("AC-E5 R-E10 路径给出可执行指引（如何创建该文件）", text.includes("cp .dev.vars.staging.example .dev.vars.staging"), "");

  const restored = renderScript(["--check"]);
  report("AC-E5 恢复值文件后回退 WARN 消失", ok(restored) && !bag(restored).includes("当前回退为本地值"), "");

  // AC-E6：环境 worker 名等于顶层名 ⇒ fail-fast **且不写出生成物**（"不写坏文件"的既有保证）。
  const before = sha(OUTPUT);
  const baseWorkerName = baseValues.WORKER_NAME;
  const collided = withPatchedFile(
    DOT_VARS_STAGING,
    (t) => setKey(t, "WORKER_NAME", baseWorkerName),
    () => renderScript([]), // 不带 --check：必须是一次真实渲染尝试
  );
  report("AC-E6 name 冲突时 fail-fast（非 0 退出）", !ok(collided), `exit=${collided.status}`);
  report(
    "AC-E6 错误信息可执行（点明 .dev.vars.staging 与 --env 的后果）",
    bag(collided).includes(".dev.vars.staging") && bag(collided).includes("--env"),
    bag(collided).trim().split("\n").slice(-3).join(" | "),
  );
  report("AC-E6 未写出生成物（wrangler.toml 字节不变）", sha(OUTPUT) === before, `前后 ${before} / ${sha(OUTPUT)}`);

  // AC-E8：开关开 + 名单空 = 危险组合 ⇒ **不带任何参数**的渲染就要喊出来（证明检查已与 --env 解耦）。
  const risky = withPatchedFile(
    DOT_VARS_STAGING,
    (t) => setKey(setKey(t, "EMAIL_VERIFICATION_ENABLED", "true"), "EMAIL_ALLOWED_RECIPIENTS", ""),
    () => renderScript(["--check"]),
  );
  report("AC-E8 不带参数也能触发误发护栏", ok(risky) && bag(risky).includes("EMAIL_ALLOWED_RECIPIENTS 为空"), bag(risky).trim().slice(-200));
}

// ---------------------------------------------------------------- AC-E7：--env 已移除

{
  const r = npmRender(["--", "--env", "staging"]);
  const text = bag(r);
  report("AC-E7 `npm run render:config -- --env staging` 非 0 退出", !ok(r), `exit=${r.status}`);
  report("AC-E7 提示改用两个值文件（不是静默忽略）", text.includes(".dev.vars.staging") && text.includes("--env 参数已移除"), text.trim().slice(-200));

  // 等号形态（复核发现）：只精确匹配 `--env` 时 `--env=staging` 会被当成"无害的未知参数"放行，
  // 旧命令于是静默退化成"照常渲染了一遍"——恰是 R-E8 要消灭的形态。
  const eq = npmRender(["--", "--env=staging"]);
  report("AC-E7 `--env=staging`（等号形态）同样非 0 退出", !ok(eq), `exit=${eq.status}`);

  // 未知参数（拼写错误）：`--chek` 必须报错，而不是静默变成"确实渲染了文件"。
  const typo = npmRender(["--", "--chek"]);
  report("AC-E7 未知参数 `--chek` 非 0 退出（不静默当渲染）", !ok(typo), `exit=${typo.status}`);
}

// ---------------------------------------------------------------- AC-E3 dry-run（慢，可选）

if (!WITH_DRY_RUN) {
  skip("AC-E3 dry-run 双环境可部署", "需 --with-dry-run（每次约 20-40s）");
} else {
  const wranglerBin = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const dryRun = (segArgs) => run(process.execPath, [wranglerBin, "deploy", "--dry-run", "--config", "wrangler.toml", ...segArgs], { cwd: ROOT });
  /** 绑定表 → Map：`env.CACHE_KV (b2df81c4...)` 这样的行（wrangler 输出带 ANSI，先剥掉）。 */
  const bindingsOf = (text) => {
    const out = new Map();
    for (const m of text.replace(/\u001b\[[0-9;]*m/g, "").matchAll(/^\s*env\.([A-Z0-9_]+)\s*\(([^)]*)\)/gm)) {
      out.set(m[1], m[2]);
    }
    return out;
  };
  const prodRun = dryRun([]);
  const stgRun = dryRun(["--env", "staging"]);
  report("AC-E3 dry-run 生产退出 0", ok(prodRun), `exit=${prodRun.status} ${bag(prodRun).trim().slice(-160)}`);
  report("AC-E3 dry-run staging 退出 0", ok(stgRun), `exit=${stgRun.status} ${bag(stgRun).trim().slice(-160)}`);
  if (ok(prodRun) && ok(stgRun)) {
    // **wrangler 的 dry-run 输出里没有 worker 名**（它只列绑定表），名字的正确性由上面生成物的
    // 段断言覆盖；这里补的是只有真跑一遍才看得见的东西 —— 每个环境实际拿到的**绑定**。
    const p = bindingsOf(bag(prodRun));
    const s = bindingsOf(bag(stgRun));
    for (const [binding, label] of [
      ["CACHE_KV", "KV namespace id"],
      ["DB", "D1 database 名"],
      ["USAGE_QUEUE", "usage 队列名"],
      ["BILLING_QUEUE", "计费队列名"],
      ["BETTER_AUTH_URL", "BETTER_AUTH_URL"],
    ]) {
      const pv = p.get(binding);
      const sv = s.get(binding);
      report(`AC-E3 dry-run ${label} 两环境各自有值且互不相同`, Boolean(pv && sv) && pv !== sv, `生产 ${pv} / staging ${sv}`);
    }
    report("AC-E3 dry-run 生产 D1 = cf-ai-gateway-db", p.get("DB") === "cf-ai-gateway-db", String(p.get("DB")));
    report("AC-E3 dry-run staging D1 = cf-ai-gateway-db-staging", s.get("DB") === "cf-ai-gateway-db-staging", String(s.get("DB")));
    report(
      "AC-E3 dry-run 生产 KV = b2df81c4…（与 staging f76273f5… 不同）",
      (p.get("CACHE_KV") ?? "").startsWith("b2df81c4") && (s.get("CACHE_KV") ?? "").startsWith("f76273f5"),
      `生产 ${p.get("CACHE_KV")} / staging ${s.get("CACHE_KV")}`,
    );
  }
}

// ---------------------------------------------------------------- AC-E10c：文档描述与脚本行为一致

{
  const r = npmRender(["--", "--check"]);
  report("AC-E10c 文档所述命令 `npm run render:config -- --check` 实跑成功", ok(r), bag(r).trim().slice(-200));
  report("AC-E10c --check 摘要如实描述两个值来源", bag(r).includes(".dev.vars.staging") && bag(r).includes("基段"), bag(r).trim().slice(-200));
}

summary();
