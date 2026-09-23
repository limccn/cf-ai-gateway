#!/usr/bin/env node
// 种子数据移管 · 校验侧（09-21-seed-migration-tooling R-A3；AC-A8 的"能报 FAIL"）。
//
// 对**目标 D1** 逐条断言，打印 PASS/FAIL，**退出码非零当且仅当有 FAIL**。
// 为什么"能报 FAIL"要单独立一条 AC：一个只会输出 PASS 的脚本与一个恰好全绿的脚本
// 在读数上不可区分（design §7 / 本仓库的「恒真假绿」纪律）。反向验证的做法是
// **临时改目标库一行**让脚本变红，不是"改脚本让它假红"。
//
// 断言分三类，输出里带前缀区分（前缀决定汇总处的处置建议，见文件末尾）：
//   [合同]  —— PRD 的字面常量（D5 白名单 6 人 / AC-A1~A5 的 6、2+4、10、28）。
//              它们不随产物变化；改这些常量等于改验收标准，必须是有意识的动作。
//   [产物]  —— 目标库与 seed-artifact.json 的**逐字段相等**。产物即目标态，这是
//              "导入到底落没落对"的判据（比只数行数强：行数对而内容错是最坏的一类假绿）。
//   [seed]  —— 目标库与**仓库 seed.sql** 的相等（R-A9：models 以该文件为权威全量）。
//              与产物无关，单独一类——否则它的红会被当成"[产物]快照失配"而给出反向建议。
//
// 用法：
//   node scripts/migrate/verify-seed.mjs                          # 默认 prod（--remote）
//   node scripts/migrate/verify-seed.mjs --target staging
//   node scripts/migrate/verify-seed.mjs --target local --persist-to .wrangler/seed-mig-tmp
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_FIELDS, columnsOf, PROVIDER_FIELDS, USER_FIELDS } from "./lib/artifact-shape.mjs";
import { d1Query, TARGETS } from "./lib/wrangler-d1.mjs";

const DEFAULT_ARTIFACT = fileURLToPath(new URL("./out/seed-artifact.json", import.meta.url));
const DEFAULT_SEED_SQL = fileURLToPath(new URL("../../seed.sql", import.meta.url));

/**
 * PRD D5 / AC-A1 的字面白名单（合同常量）。**2026-09-23 由 7 人收窄为 6 人**（用户裁定）：
 * 原第 7 人 43 在 stg 不存在，它与现存的 48 是同一邮箱的前后身（见 export-seed.mjs 的
 * DEFAULT_USERS 注释）。改这里是**有意识的动作** —— 等于改验收标准，不是修 bug。
 */
const CONTRACT_USER_IDS = [13, 20, 21, 24, 42, 44];
/** PRD 字面：accounts 6 行 = 2 github + 4 credential（AC-A5/A1 的表述，随白名单一同收窄）。 */
const CONTRACT_ACCOUNT_SPLIT = { github: 2, credential: 4 };
/** PRD 字面：providers 10 行（R-A8）。 */
const CONTRACT_PROVIDER_COUNT = 10;
/** PRD 字面：seed.sql 28 行（R-A9）。 */
const CONTRACT_MODEL_COUNT = 28;

function parseArgs(argv) {
  const args = { target: "prod", persistTo: undefined, artifact: DEFAULT_ARTIFACT, seedSql: DEFAULT_SEED_SQL };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`多余的位置参数：${flag}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} 缺少取值`);
    }
    i += 1;
    if (flag === "--target") {
      if (!Object.hasOwn(TARGETS, value)) {
        throw new Error(`--target 只接受 ${Object.keys(TARGETS).join(" / ")}，收到 ${value}`);
      }
      args.target = value;
    } else if (flag === "--persist-to") {
      args.persistTo = resolve(process.cwd(), value);
    } else if (flag === "--artifact") {
      args.artifact = resolve(process.cwd(), value);
    } else if (flag === "--seed-sql") {
      args.seedSql = resolve(process.cwd(), value);
    } else {
      throw new Error(`未识别的参数：${flag}`);
    }
  }
  if (args.persistTo !== undefined && args.target !== "local") {
    throw new Error("--persist-to 只对 --target local 有效");
  }
  return args;
}

/** 值展示：邮箱只留域名（本脚本的输出会被贴进报告/issue，别顺手把 PII 撒出去）。 */
function show(value) {
  if (value === null || value === undefined) {
    return String(value);
  }
  let text = String(value);
  text = text.replace(/[^\s@,]+@[^\s@,]+/g, (email) => {
    const at = email.lastIndexOf("@");
    return `${email.slice(0, 2)}***${email.slice(at)}`;
  });
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

/**
 * **本身就是凭据**的列：比对一旦失配就要把值打进 stdout，而这份输出会被贴进报告/issue。
 * 最现实的一条：prod 上有人用 GitHub 登录过之后，`accounts.access_token` 就是**活 token**，
 * 跑一次校验就等于把它抄进聊天记录。`password` 是 scrypt 哈希（R-A7 要求保留，登录取它），
 * 两个 `*_enc` 是上游密钥的密文。这些列**只报"不同"、绝不报值**。
 */
const SECRET_COLUMNS = new Set([
  "password",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key_enc",
  "http_options_enc",
]);

/** 比对失配时的值展示：敏感列只报形状（或"是空"），其余走 `show`。 */
function showField(column, value) {
  if (!SECRET_COLUMNS.has(column)) {
    return show(value);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  const text = String(value);
  return text === "" ? "''" : `<已脱敏（长度 ${text.length}）>`;
}

const SAME = (want, got) => want === got;

/**
 * 断言名的前缀是**承重的**：文件末尾的警示行按 `[产物]` 前缀分流。前缀写错（或将来有人
 * 加一条不带前缀的 check）会让警示**静默失效** —— 那正是最难发现的一类退化。
 * 所以把这条不变量从"读者的记忆"变成**代码里的 fail-fast**。
 */
const CHECK_PREFIXES = ["[合同]", "[产物]", "[seed]"];

const results = [];
function check(name, ok, detail) {
  if (!CHECK_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new Error(`断言名必须以 ${CHECK_PREFIXES.join(" / ")} 开头（汇总处按前缀分流）：${name}`);
  }
  results.push({ name, ok, detail });
  const line = `${ok ? "PASS" : "FAIL"}  ${name}`;
  console.log(ok || detail === undefined ? line : `${line}\n      ${detail}`);
}

function info(message) {
  console.log(`INFO  ${message}`);
}

/** 产物 vs 目标库逐字段比对（按 id 配对，双向：缺行/多行都算）。 */
function compareRows(table, fields, expectedRows, actualRows) {
  const problems = [];
  const actualById = new Map(actualRows.map((row) => [row.id, row]));
  const expectedIds = new Set(expectedRows.map((row) => row.id));
  for (const expected of expectedRows) {
    const actual = actualById.get(expected.id);
    if (actual === undefined) {
      problems.push(`id=${expected.id} 在目标库缺失`);
      continue;
    }
    for (const field of fields) {
      if (!SAME(expected[field.key], actual[field.column])) {
        problems.push(
          `id=${expected.id} 列 ${field.column}：产物 ${showField(field.column, expected[field.key])} ≠ 目标 ${showField(field.column, actual[field.column])}`,
        );
      }
    }
  }
  for (const actual of actualRows) {
    if (!expectedIds.has(actual.id)) {
      problems.push(`目标库多出 id=${actual.id}（不在产物里）`);
    }
  }
  const shown = problems.slice(0, 6).join("；");
  return { ok: problems.length === 0, detail: problems.length === 0 ? undefined : `${shown}${problems.length > 6 ? `（共 ${problems.length} 处）` : ""}` };
}

/** seed.sql 的模型名单（R-A9：models 以该文件为权威全量）。 */
function parseSeedModels(path) {
  const text = readFileSync(path, "utf8");
  const names = new Set();
  for (const match of text.matchAll(/^\s*\('([^']+)'/gm)) {
    names.add(match[1]);
  }
  if (names.size === 0) {
    throw new Error(`${path} 里没解析出任何模型名（格式变了吗？）`);
  }
  return names;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifact = JSON.parse(readFileSync(args.artifact, "utf8"));
  const query = (sql) => d1Query(sql, { target: args.target, persistTo: args.persistTo });

  console.log(`# verify-seed  target=${args.target}(${TARGETS[args.target].db})`);
  console.log(`# 产物         ${args.artifact}（导出白名单 ${artifact.userAllowlist.join(",")}）`);
  if (args.target === "local" && args.persistTo === undefined) {
    console.log("# 注意：local 且未给 --persist-to ⇒ 读的是默认 .wrangler 状态目录（本机 dev 夹具库）");
  }
  console.log("");

  // ── users ────────────────────────────────────────────────────────────────
  const userColumns = columnsOf(USER_FIELDS).join(", ");
  const users = query(`SELECT ${userColumns} FROM users ORDER BY id;`);
  const userIds = users.map((row) => row.id).sort((a, b) => a - b);
  const contractIds = [...CONTRACT_USER_IDS].sort((a, b) => a - b);
  const missing = contractIds.filter((id) => !userIds.includes(id));
  const extra = userIds.filter((id) => !contractIds.includes(id));
  check(
    `[合同] users 的 id 集合 = [${contractIds.join(",")}]`,
    missing.length === 0 && extra.length === 0,
    missing.length > 0 || extra.length > 0
      ? `缺 ${missing.join(",") || "无"}；多 ${extra.join(",") || "无"}`
      : undefined,
  );
  check(
    `[合同] users 行数 = ${CONTRACT_USER_IDS.length}`,
    users.length === CONTRACT_USER_IDS.length,
    `实际 ${users.length}`,
  );

  const testDomainUsers = users.filter(
    (row) => typeof row.email === "string" && (/@staging\.test$/i.test(row.email) || /@sec\.test$/i.test(row.email)),
  );
  check(
    "[产物] 无测试号（%@staging.test / %@sec.test）",
    testDomainUsers.length === 0,
    testDomainUsers.map((row) => `id=${row.id} ${show(row.email)}`).join("；"),
  );

  const artifactEmails = new Set(artifact.users.map((user) => user.email));
  const strayEmails = users.filter((row) => !artifactEmails.has(row.email));
  check(
    "[产物] users 的 email 集合 = 产物的 email 集合",
    strayEmails.length === 0,
    strayEmails.map((row) => `id=${row.id} ${show(row.email)}`).join("；"),
  );

  const userCompare = compareRows("users", USER_FIELDS, artifact.users, users);
  check(`[产物] users 逐字段 = 产物（${artifact.users.length} 行）`, userCompare.ok, userCompare.detail);

  const nonZeroBalance = users.filter((row) => row.balance !== 0);
  check(
    "[产物] 白名单用户 balance 全 0",
    nonZeroBalance.length === 0,
    nonZeroBalance.map((row) => `id=${row.id} balance=${row.balance}`).join("；"),
  );

  // ── accounts ─────────────────────────────────────────────────────────────
  const accountColumns = columnsOf(ACCOUNT_FIELDS).join(", ");
  const accounts = query(`SELECT ${accountColumns} FROM accounts ORDER BY id;`);
  const split = { github: 0, credential: 0, other: 0 };
  for (const row of accounts) {
    split[row.provider_id] = (split[row.provider_id] ?? 0) + 1;
  }
  const contractAccountCount = CONTRACT_ACCOUNT_SPLIT.github + CONTRACT_ACCOUNT_SPLIT.credential;
  check(
    `[合同] accounts = ${contractAccountCount} 行（github ${CONTRACT_ACCOUNT_SPLIT.github} + credential ${CONTRACT_ACCOUNT_SPLIT.credential}）`,
    accounts.length === contractAccountCount &&
      split.github === CONTRACT_ACCOUNT_SPLIT.github &&
      split.credential === CONTRACT_ACCOUNT_SPLIT.credential,
    `实际 ${accounts.length} 行（github ${split.github} + credential ${split.credential}）`,
  );
  check(
    `[产物] accounts 行数 = 产物（${artifact.accounts.length}）`,
    accounts.length === artifact.accounts.length,
    `实际 ${accounts.length}`,
  );
  const accountCompare = compareRows("accounts", ACCOUNT_FIELDS, artifact.accounts, accounts);
  check(
    `[产物] accounts 逐字段 = 产物（含三个 OAuth token 列恒 NULL）`,
    accountCompare.ok,
    accountCompare.detail,
  );

  // ── providers ────────────────────────────────────────────────────────────
  const providerColumns = columnsOf(PROVIDER_FIELDS).join(", ");
  const providers = query(`SELECT ${providerColumns} FROM providers ORDER BY id;`);
  check(
    `[合同] providers = ${CONTRACT_PROVIDER_COUNT} 行`,
    providers.length === CONTRACT_PROVIDER_COUNT,
    `实际 ${providers.length}`,
  );
  check(
    `[产物] providers 行数 = 产物（${artifact.providers.length}）`,
    providers.length === artifact.providers.length,
    `实际 ${providers.length}`,
  );
  const providerCompare = compareRows("providers", PROVIDER_FIELDS, artifact.providers, providers);
  check(
    `[产物] providers 逐字段 = 产物（非密文字段原样；密文列已是目标态空值）`,
    providerCompare.ok,
    providerCompare.detail,
  );

  const enabledCount = query("SELECT COUNT(*) AS c FROM providers WHERE enabled <> 0;")[0].c;
  check("[产物] providers 全部 enabled = 0", enabledCount === 0, `enabled<>0 的行 ${enabledCount}`);

  for (const [column, label] of [
    ["api_key_enc", "api_key_enc 非空"],
    ["api_key_prefix", "api_key_prefix 非空"],
    ["http_options_enc", "http_options_enc 非 NULL"],
  ]) {
    const count = query(
      `SELECT COUNT(*) AS c FROM providers WHERE ${column} ${column === "http_options_enc" ? "IS NOT NULL" : "<> ''"};`,
    )[0].c;
    check(`[产物] providers ${label} 计数 = 0`, count === 0, `实际 ${count}`);
  }

  // ── 白名单用户的流水/明细（D2/R-A10：不迁移，新用户不该有历史）───────────
  const ids = artifact.userAllowlist.join(",");
  const balanceTx = query(
    `SELECT COUNT(*) AS c FROM balance_tx WHERE user_id IN (${ids});`,
  )[0].c;
  check(`[产物] 白名单用户 balance_tx 计数 = 0`, balanceTx === 0, `实际 ${balanceTx}`);
  const balanceTxAll = query("SELECT COUNT(*) AS c FROM balance_tx;")[0].c;
  info(`balance_tx 全库计数 = ${balanceTxAll}（只做参考：判据是白名单用户为 0）`);

  // 下面三项不是判据（设计没立这条 AC），只做发布窗口的旁证读数
  for (const [table, column] of [
    ["api_keys", "user_id"],
    ["usage_daily", "user_id"],
    ["request_logs", "user_id"],
  ]) {
    const count = query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} IN (${ids});`)[0].c;
    info(`${table} 白名单用户计数 = ${count}（参考：D2/R-A10 不迁移这些表）`);
  }

  // ── models（R-A9：seed.sql 权威全量）────────────────────────────────────
  const seedModels = parseSeedModels(args.seedSql);
  const dbModels = new Set(query("SELECT model FROM models;").map((row) => row.model));
  const modelsMissing = [...seedModels].filter((name) => !dbModels.has(name));
  const modelsExtra = [...dbModels].filter((name) => !seedModels.has(name));
  // ⚠ 这两条**不是** [产物]：models 由 seed.sql 负责（R-A9，另一步执行），与 seed-artifact.json 无关。
  // 贴成 [产物] 会让汇总处的"快照失配 ⇒ 别重跑导入"警示**误报**——它诊断的是流量改写，
  // 而这里的真因是"还没跑 seed.sql"，正确处置恰恰相反（去跑 seed.sql，别重新导出）。
  // 这一点是实跑发现的：只跑 import.sql、不跑 seed.sql 时，恰恰就是这两条红。
  check(
    `[seed] models 行数 = ${CONTRACT_MODEL_COUNT}`,
    dbModels.size === CONTRACT_MODEL_COUNT,
    `实际 ${dbModels.size}`,
  );
  check(
    `[seed] models 集合 = seed.sql 的集合（${seedModels.size} 个）`,
    modelsMissing.length === 0 && modelsExtra.length === 0,
    `seed.sql 有而目标库缺：${modelsMissing.slice(0, 6).join(",") || "无"}；目标库多出：${modelsExtra.slice(0, 6).join(",") || "无"}`,
  );

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((result) => !result.ok);
  console.log("");
  console.log(`# ${results.length - failed.length} PASS / ${failed.length} FAIL`);
  if (failed.length > 0) {
    console.log(`# FAIL 清单：${failed.map((result) => result.name).join("；")}`);
    // [产物] 类是**快照相等**：目标库一旦开始跑真实流量就会红（改密码、GitHub 登录写 token、
    // 余额变动都会改 updated_at），而这时候操作者最自然的反应是"重跑一次导入把它修好" ——
    // 那是**破坏性**的：import.sql 是 purge-then-insert，会把这段期间的全部流量数据删掉。
    if (failed.some((result) => result.name.startsWith("[产物]"))) {
      console.log("");
      console.log("⚠ 上面含 [产物] 类失配。该类断言比的是**快照相等**，不代表「坏了」：");
      console.log("  目标库跑过真实流量后（改密码 / GitHub 登录写 token / 余额变动 ⇒ updated_at 变）");
      console.log("  重跑就会红，这是**预期**的。");
      console.log("  ⛔ 此时**不要**重跑 import.sql —— 它是 purge-then-insert，会删掉这期间的全部流量数据。");
      console.log("  ✅ 正确做法：**重新导出一次产物**（export-seed.mjs）再比对。");
    }
    // [seed] 类的红有**另一个**成因，处置相反：models 由 seed.sql 负责（R-A9），
    // 只跑 import.sql 不跑 seed.sql 时恰好就是这几条红 —— 此时去"重新导出产物"是白费功夫。
    if (failed.some((result) => result.name.startsWith("[seed]"))) {
      console.log("");
      console.log("ℹ 上面含 [seed] 类失配：该类比的是**仓库 seed.sql**（models 的权威全量），与产物无关。");
      console.log("  最常见成因：只执行了 import.sql、还没执行 seed.sql（R-A9 的另一步）。");
      console.log("  ✅ 处置：跑 `wrangler d1 execute <db> --remote --config wrangler.toml --file=seed.sql` 后重跑本脚本。");
    }
    process.exitCode = 1;
  }
}

main();
