#!/usr/bin/env node
// 种子数据移管 · 序列化侧（09-21-seed-migration-tooling R-A2；design §4/§5）。
//
//   seed-artifact.json ──[本文件：零业务逻辑，只拼 SQL]──▶ out/import.sql
//
// **本文件不做任何变换**（R-A4）：角色覆盖、余额归零、密文置空都在导出侧完成，
// 产物即目标态。这里只负责引用转义、NULL 字面量、外键序，以及把"下一步要删/要插什么"
// 留在生成物的头部注释里（执行者不看脚本也能读懂这份 SQL 会干什么）。
//
// 导入语义（R-A11/A12/A13）：**先 purge 后 insert**，单文件 `wrangler d1 execute --file`
// 执行（D1 批量执行 = 单事务，一条失败全部回滚 ⇒ 原子）。
//
// 用法：
//   node scripts/migrate/render-import-sql.mjs
//   node scripts/migrate/render-import-sql.mjs --artifact /tmp/a.json --out /tmp/import.sql
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_FIELDS, PROVIDER_FIELDS, USER_FIELDS } from "./lib/artifact-shape.mjs";

const DEFAULT_ARTIFACT = fileURLToPath(new URL("./out/seed-artifact.json", import.meta.url));
const DEFAULT_OUT = fileURLToPath(new URL("./out/import.sql", import.meta.url));

// 字段映射在 lib/artifact-shape.mjs（渲染与校验共用一份：**显式列名，不用
// `INSERT INTO t VALUES (…)`** —— 位置式插入会在任何一次迁移加列时静默错位，
// 而 SQLite 的值没有类型保护）。

function parseArgs(argv) {
  const args = { artifact: DEFAULT_ARTIFACT, out: DEFAULT_OUT };
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
    if (flag === "--artifact") {
      args.artifact = resolve(process.cwd(), value);
    } else if (flag === "--out") {
      args.out = resolve(process.cwd(), value);
    } else {
      throw new Error(`未识别的参数：${flag}`);
    }
  }
  return args;
}

/**
 * 值 → SQL 字面量。**只认 null / number / string**，其余（含 `undefined`）一律 fail-fast ——
 * `undefined` 静默变成 `NULL` 会写出一行"看起来对、字段空了"的数据，而这类错误在
 * 目标库里没有报错、只有后验才发现。
 */
function sqlValue(value, context) {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${context}: 非有限数值 ${value}`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    return `'${value.split("'").join("''")}'`;
  }
  throw new Error(`${context}: 不支持的值类型 ${typeof value}（只接受 null/string/number）`);
}

/** 单表多行 INSERT（显式列名；一行一条元组，便于 diff 与目视复核）。 */
function renderInsert(table, fields, rows, headerComment) {
  if (rows.length === 0) {
    return null;
  }
  const columns = fields.map((field) => field.column).join(", ");
  const tuples = rows.map((row, index) => {
    const values = fields.map((field) =>
      sqlValue(row[field.key], `${table}[${index}].${field.column}`),
    );
    return `  (${values.join(", ")})`;
  });
  return `${headerComment}\nINSERT INTO ${table} (${columns}) VALUES\n${tuples.join(",\n")};\n`;
}

/**
 * 产物自检（渲染前的最后一道闸，与导出侧的自检**目的不同**）：
 * 导出侧保证"产物是从 stg 变换出来的"；这里保证"手里这份产物没被手改过"——
 * 产物是可以在两次运行之间被编辑的文件，而一个被改过的产物会安静地写进目标库。
 */
function validateArtifact(artifact, path) {
  const problems = [];
  for (const key of ["userAllowlist", "users", "accounts", "providers"]) {
    if (artifact[key] === undefined) {
      problems.push(`缺少 ${key}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${path} 不像一份 seed-artifact：\n  - ${problems.join("\n  - ")}`);
  }
  if (artifact.models !== undefined) {
    problems.push("产物含 models（R-A9：models 以 seed.sql 为权威，不进产物，本文件也不该碰）");
  }
  if (artifact.users.length === 0) {
    problems.push("users 为空 —— 一份只会删、不会插的文件不得渲染（误删目标库全部白名单用户）");
  }
  if (artifact.users.length !== artifact.userAllowlist.length) {
    problems.push(`users ${artifact.users.length} 行 ≠ userAllowlist ${artifact.userAllowlist.length}`);
  }
  const allowlist = new Set(artifact.userAllowlist);
  const seenIds = new Set();
  for (const user of artifact.users) {
    if (!allowlist.has(user.id)) {
      problems.push(`users 含白名单外 id=${user.id}`);
    }
    if (seenIds.has(user.id)) {
      problems.push(`users 出现重复 id=${user.id}`);
    }
    seenIds.add(user.id);
    if (typeof user.email !== "string" || user.email === "") {
      problems.push(`user id=${user.id} 的 email 为空 —— purge 靠 email 认人，空 email 会误伤`);
    }
    if (user.balance !== 0) {
      problems.push(`user id=${user.id} 的 balance=${user.balance}（产物应已归零）`);
    }
  }
  for (const account of artifact.accounts) {
    if (!allowlist.has(account.userId)) {
      problems.push(`accounts id=${account.id} 指向白名单外 user_id=${account.userId}`);
    }
    for (const column of ["accessToken", "refreshToken", "idToken"]) {
      if (account[column] !== null) {
        problems.push(`accounts id=${account.id} 的 ${column} 非 null（OAuth 凭据不得入库）`);
      }
    }
  }
  for (const provider of artifact.providers) {
    if (provider.apiKeyEnc !== "" || provider.apiKeyPrefix !== "" || provider.httpOptionsEnc !== null) {
      problems.push(`provider id=${provider.id} 的密文列非空（R-A8 要求在导出侧清空）`);
    }
    if (provider.enabled !== 0) {
      problems.push(`provider id=${provider.id} 的 enabled=${provider.enabled}（R-A8 要求 0）`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${path} 自检未通过：\n  - ${problems.join("\n  - ")}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifact = JSON.parse(readFileSync(args.artifact, "utf8"));
  validateArtifact(artifact, args.artifact);

  const ids = artifact.userAllowlist.join(", ");
  const emails = artifact.users.map((user) => sqlValue(user.email, "email")).join(", ");
  const accountIds = artifact.accounts.map((account) => account.id).join(", ");
  const providerIds = artifact.providers.map((provider) => provider.id).join(", ");

  // 被判死的用户集合。**必须是子查询而不是 id 列表**：`email IN (…)` 命中的那个人的 id
  // 在目标库里可能**不是**白名单 id（这正是 AC-A5 的场景），而他的依赖行挂着的是那个 id。
  // 写成 id 列表就会漏删依赖 ⇒ `DELETE FROM users` 当场撞外键。
  const purged = `SELECT id FROM users WHERE id IN (${ids}) OR email IN (${emails})`;
  const purgedKeys = `SELECT id FROM api_keys WHERE user_id IN (${purged})`;
  const purgedLogs =
    `SELECT id FROM request_logs WHERE user_id IN (${purged}) OR key_id IN (${purgedKeys})`;

  const purge = [
    // 叶子先行，顺序与 src/routes/users/procedures/delete.ts 的拓扑序一致
    // （balanceTx.refRequestId → requestLogs.id；usageDaily.keyId → apiKeys.id；其余 → users.id）。
    `-- 流水与明细：挂 users 的直删；另外两类"引用即将消失的行"的残留也必须先走\n` +
      `--   ① 引用被判死用户的 request_log 的 balance_tx（ref_request_id）\n` +
      `--   ② 引用被判死用户的 api_key 的 usage_daily / request_logs（key_id）\n` +
      `-- 少了这两句，后面删 request_logs / api_keys 会撞即时外键（schema 里没有任何 ON DELETE CASCADE）。\n` +
      `DELETE FROM balance_tx WHERE user_id IN (${purged})\n` +
      `   OR ref_request_id IN (${purgedLogs});\n` +
      `DELETE FROM usage_daily WHERE user_id IN (${purged}) OR key_id IN (${purgedKeys});\n` +
      `DELETE FROM request_logs WHERE id IN (${purgedLogs});\n` +
      `DELETE FROM sessions WHERE user_id IN (${purged});\n` +
      // accounts 多一个 id 条件：`accounts.id` 是主键，产物要按这些 id 插回去；
      // 目标库里碰巧同 id 的另一行（"同 id 不同人"）不清掉就会撞 UNIQUE。
      `DELETE FROM accounts WHERE user_id IN (${purged}) OR id IN (${accountIds});\n` +
      `DELETE FROM invite_codes WHERE created_by IN (${purged});\n` +
      `DELETE FROM api_keys WHERE user_id IN (${purged});\n` +
      // users：id 或 email 命中都删（R-A12）。两个条件缺一不可 —— 只按 id 删会漏掉
      // "同 email 不同 id"的人（人工改过 id / 旧库自增被推进过），只按 email 删会漏掉
      // "同 id 不同人"（库里 id 被人占用）。
      `DELETE FROM users WHERE id IN (${ids}) OR email IN (${emails});\n`,
    // providers 不在 design §5 的 purge 列表里，但它**必须**清：产物按 stg 的 id 插回去
    // （R-A8 的 10 行），第二次执行时这些 id 就在库里 ⇒ 不清就撞主键，AC-A3 的幂等直接不成立。
    // 它前面要先"解引用"：request_logs.provider_id → providers.id 是即时外键，而删掉的行马上
    // 会以同一 id 重新插入（内容不同）⇒ 那些日志的归属已经失真，置 NULL 比留着一个指向
    // "另一条 provider"的 id 更诚实，也避免了删日志（数据损失更大）。
    `-- providers 的 id 会被原样重灌 ⇒ 先把指向它们的历史日志解引用，再删（见上方说明）。\n` +
      `UPDATE request_logs SET provider_id = NULL WHERE provider_id IN (${providerIds});\n` +
      `DELETE FROM providers WHERE id IN (${providerIds});\n`,
  ];

  const inserts = [
    renderInsert(
      "users",
      USER_FIELDS,
      artifact.users,
      `-- users：${artifact.users.length} 行（白名单 ${artifact.userAllowlist.join("/")}）。\n` +
        `-- role 已按覆盖表落定、balance 已归零、id 保留（显式插入大 id 会推进 AUTOINCREMENT 的 sqlite_sequence）`,
    ),
    renderInsert(
      "accounts",
      ACCOUNT_FIELDS,
      artifact.accounts,
      `-- accounts：${artifact.accounts.length} 行（credential 用 password 的 scrypt 哈希原样搬，` +
        `github 行的三个 OAuth token 列已被导出侧置 NULL）`,
    ),
    renderInsert(
      "providers",
      PROVIDER_FIELDS,
      artifact.providers,
      `-- providers：${artifact.providers.length} 行，四个字段是目标态：api_key_enc=''、api_key_prefix=''、` +
        `http_options_enc=NULL、enabled=0\n-- （密钥待在管理台手工重填；enabled=0 保证未重填时是干净 404 而不是解密失败 500）`,
    ),
  ].filter((block) => block !== null);

  const sql =
    `-- ⚠ 生成物，勿手改 —— 由 scripts/migrate/render-import-sql.mjs 从 seed-artifact.json 渲染。\n` +
    `-- 产物   : ${args.artifact}\n` +
    `-- 生成于 : ${new Date().toISOString()}\n` +
    `-- 执行   : wrangler d1 execute <db> --remote --config wrangler.toml --file=scripts/migrate/out/import.sql\n` +
    `--\n` +
    `-- 这份文件会 **先删后插**（purge-then-insert，R-A11/A12）：\n` +
    `--   · 删除 users 里 id 命中 (${artifact.userAllowlist.join(",")}) **或** email 命中产物白名单的行，及全部依赖行；\n` +
    `--   · 删除 id 命中产物的 provider 行；\n` +
    `--   · **不碰 models**（R-A9：models 以 seed.sql 为权威全量，另跑 seed.sql）。\n` +
    `-- 单文件一次执行 = 一个事务（D1 批量语义）⇒ 要么全成、要么全回滚；执行前先备份（runbook §2.1）。\n` +
    `\n` +
    `-- ──────────────────────── 1. purge（外键序：叶子先行）────────────────────────\n` +
    purge.join("") +
    `\n-- ──────────────────────── 2. insert（users → accounts → providers）──────────\n` +
    inserts.join("\n");

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, sql, "utf8");

  console.log(`[render-import-sql] 产物 ${args.artifact}`);
  console.log(
    `[render-import-sql] purge：users ${artifact.users.length} 行（id/email 两条件）+ 其依赖 + providers ${artifact.providers.length} 行`,
  );
  console.log(
    `[render-import-sql] insert：users ${artifact.users.length} / accounts ${artifact.accounts.length} / providers ${artifact.providers.length}`,
  );
  console.log(`[render-import-sql] 已写入 ${args.out}（${sql.length} 字节）`);
}

main();
