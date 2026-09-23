#!/usr/bin/env node
// 种子数据移管 · 导出侧（09-21-seed-migration-tooling R-A1；design §2/§3/§4）。
//
//   stg D1 ──SELECT──▶ [本文件 = 全部业务逻辑] ──▶ seed-artifact.json
//                                                        │
//                              render-import-sql.mjs ────┘（零业务逻辑，只做 SQL 拼装）
//
// **产物即目标态**（R-A4）：角色覆盖、余额归零、provider 密文列清空都在这里做完，
// 于是产物可以人工目视复核，且导入失败后能单独重跑导入。
//
// 只读（R-A1）：全程 SELECT，不写源库。**且不 SELECT 任何密文列** —— 值不进内存就
// 没有写进产物的机会（providers.api_key_enc / http_options_enc、accounts 的三个 OAuth
// token 列都只取「是否非空」的布尔）。见下方 ACCOUNT_TOKEN_COLUMNS 的说明。
//
// 一条语句一次调用、读 j[0].results（runbook R-D11）：多语句的 --json 返回的不是数组，
// 拿它 forEach 会炸。判据已写成断言（见 lib/wrangler-d1.mjs 的 d1Query，三个脚本共用）。
//
// 用法：
//   node scripts/migrate/export-seed.mjs --env staging
//   node scripts/migrate/export-seed.mjs --env prod --out /tmp/a.json --users 13,20,21
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_FIELDS, columnsOf, PROVIDER_FIELDS, USER_FIELDS } from "./lib/artifact-shape.mjs";
import { d1Query, TARGETS } from "./lib/wrangler-d1.mjs";

const DEFAULT_OUT = fileURLToPath(new URL("./out/seed-artifact.json", import.meta.url));

/**
 * 迁移用户白名单（R-A1 的默认值，与父 PRD D5 同源）。
 *
 * 2026-09-23 由 7 人收窄为 6 人（用户裁定）：原第 7 人 **43 在 stg 不存在** ——
 * 它与现存的 **48 是同一个人的前后身**（**同一邮箱**，而 `users.email` 是 UNIQUE，
 * 故两 id 不可能并存：旧号被删、于 09-22 跑邮件链路测试时重新注册成 48）。
 * 该用户裁定**不迁**（48 的余额 10 全部来自 signup/email-verify 两笔赠金，不属"真号"）。
 * 注意 48 这个 id 是**新的**：不能把它当成"43 改名"写进白名单。
 *
 * ⚠ **本文件入库、且本仓库准备转公开：注释里不写真实邮箱。** 上面这条论证不依赖地址本身
 * （"同一邮箱"就够了），用户裁定依据的完整邮箱留在 `.trellis/`（该目录整体 gitignore）。
 */
const DEFAULT_USERS = [13, 20, 21, 24, 42, 44];

/** 角色覆盖表（R-A6 / D6）：stg 的 admin 到 prod 一律降为 member。 */
const ROLE_OVERRIDES = { 20: "member", 21: "member" };

/**
 * accounts 的 OAuth token 列：一律置空，**且不 SELECT**。
 *
 * 理由是一处真实冲突的裁决：R-A7 说 accounts「整行原样」，R-A5 说「产物不含明文机密」，
 * 而 stg 的两个 github 账号行里**确实存着** access_token / refresh_token（better-auth 落库）。
 * 两者不可兼得 ⇒ 按 R-A5 处理，依据有三：
 *   ① 全部 9 处 `accounts.*token*` 在 `src/` 里的引用点只有 schema 声明（`grep` 0 消费方），
 *      GitHub 登录靠 (issuer, account_id) 认人，token 只是死重；
 *   ② design §1 自己枚举产物含什么时写的是「7 个真实邮箱 + password 的 scrypt 哈希 + github_id」，
 *      **没有** token；
 *   ③ 本仓库正在准备转公开，产物即便不入库也是落在开发者机器上的明文凭据。
 */
const ACCOUNT_TOKEN_COLUMNS = ["accessToken", "refreshToken", "idToken"];

/** 上面对应的 DB 列名（下划线形），供 SELECT 列表剔重用。 */
const ACCOUNT_TOKEN_DB_COLUMNS = ACCOUNT_FIELDS.filter((field) =>
  ACCOUNT_TOKEN_COLUMNS.includes(field.key),
).map((field) => field.column);

/** 从共享字段表生成 `<列名>,\n            …` 形态的 SELECT 清单（列名不必手抄一遍）。 */
function selectList(fields) {
  return fields.map((column) => `            ${column}`).join(",\n");
}

/**
 * AES-GCM 密文的形状：`base64(iv):base64(ciphertext)`（src/lib/security.ts）。
 * 两侧各 ≥16 字符即可与普通文本（域名、模型名、`local:credential`）区分开。
 */
const CIPHERTEXT_SHAPE = /[A-Za-z0-9+/]{16,}={0,2}:[A-Za-z0-9+/]{16,}={0,2}/;

function parseArgs(argv) {
  const args = { env: "staging", out: DEFAULT_OUT, users: DEFAULT_USERS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`多余的位置参数：${flag}（只接受 --env/--out/--users）`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} 缺少取值`);
    }
    i += 1;
    if (flag === "--env") {
      // 导出侧刻意不开放 local：产物实例必须来自真实源库，否则「导出的那一份」无法复核。
      if (value !== "staging" && value !== "prod") {
        throw new Error(`--env 只接受 staging / prod，收到 ${value}`);
      }
      args.env = value;
    } else if (flag === "--out") {
      args.out = resolve(process.cwd(), value);
    } else if (flag === "--users") {
      args.users = value.split(",").map((part) => {
        const id = Number(part.trim());
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`--users 只接受正整数 id 列表，收到 ${part}`);
        }
        return id;
      });
    } else {
      throw new Error(`未识别的参数：${flag}`);
    }
  }
  return args;
}

/** DB 行（snake_case）→ 产物行（camelCase = Drizzle 属性名；AC-A1 与 design §5 都用这套名字）。 */
function toArtifactUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    // 角色覆盖 → 其余照抄（R-A6）
    role: ROLE_OVERRIDES[row.id] ?? row.role,
    status: row.status,
    // 余额一律归零（D7）：prod 从零起算，stg 的余额不搬（也不补发赠金）
    balance: 0,
    emailVerified: row.email_verified,
    image: row.image,
    githubId: row.github_id,
    signupBonusGrantedAt: row.signup_bonus_granted_at,
    emailVerifyBonusGrantedAt: row.email_verify_bonus_granted_at,
    welcomeSeenAt: row.welcome_seen_at,
    // 时间戳**原样搬 D1 里的秒级整数**（design §3）：不做 ISO/毫秒转换，产物是给 INSERT 用的
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toArtifactAccount(row) {
  const account = {
    id: row.id,
    issuer: row.issuer,
    accountId: row.account_id,
    providerId: row.provider_id,
    userId: row.user_id,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    scope: row.scope,
    password: row.password,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  for (const column of ACCOUNT_TOKEN_COLUMNS) {
    account[column] = null;
  }
  return account;
}

function toArtifactProvider(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    // 密文不可搬（D3/R-A8）：prod 的 GATEWAY_SECRET_KEY 与 stg 不同 ⇒ 搬过去也解不开。
    // 列本身 NOT NULL ⇒ 空串；http_options_enc 可空 ⇒ NULL。
    apiKeyEnc: "",
    apiKeyPrefix: "",
    httpOptionsEnc: null,
    models: row.models,
    weight: row.weight,
    thinkingMode: row.thinking_mode,
    reasoningRoundtrip: row.reasoning_roundtrip,
    upstreamTimeoutMs: row.upstream_timeout_ms,
    // enabled=0（D10）：proxy 的候选池按 enabled=1 过滤 ⇒ 未重填密钥时干净 404；
    // 若留 enabled=1 配空密文，解密失败分支每次都 500 且**不 failover**。
    enabled: 0,
    createdAt: row.created_at,
  };
}

/** 落盘前的自检（AC-A1 / implement §3：「自检并 fail-fast」）。 */
function validateArtifact(artifact) {
  const problems = [];
  const allowlist = new Set(artifact.userAllowlist);

  if (artifact.users.length !== artifact.userAllowlist.length) {
    problems.push(
      `users 行数 ${artifact.users.length} ≠ 白名单 ${artifact.userAllowlist.length}`,
    );
  }
  for (const user of artifact.users) {
    if (!allowlist.has(user.id)) {
      problems.push(`产物含白名单外的 user id=${user.id}`);
    }
    if (user.balance !== 0) {
      problems.push(`user id=${user.id} 的 balance=${user.balance}（应为 0）`);
    }
  }
  for (const account of artifact.accounts) {
    if (!allowlist.has(account.userId)) {
      problems.push(`accounts 含白名单外的 user_id=${account.userId}`);
    }
    for (const column of ACCOUNT_TOKEN_COLUMNS) {
      if (account[column] !== null) {
        problems.push(`accounts id=${account.id} 的 ${column} 非 null（OAuth 凭据不得进产物）`);
      }
    }
  }
  for (const provider of artifact.providers) {
    if (provider.apiKeyEnc !== "" || provider.apiKeyPrefix !== "" || provider.httpOptionsEnc !== null) {
      problems.push(`provider id=${provider.id} 的密文列非空（apiKeyEnc/apiKeyPrefix/httpOptionsEnc）`);
    }
    if (provider.enabled !== 0) {
      problems.push(`provider id=${provider.id} 的 enabled=${provider.enabled}（应为 0）`);
    }
  }

  // 「全文件不含形如 base64:base64 的密文串」（AC-A1）。
  // **排除 accounts.password**：它是 scrypt 的 `hex:hex`（实测 32 位盐 + 128 位派生物），
  // 形状与 base64:base64 同族，是 R-A7 明确要求保留的内容 —— 不排除的话这条自检会对
  // 每个 credential 账号误报，等于把真警报淹掉。
  const scanned = JSON.stringify(artifact, (key, value) => (key === "password" ? "<hash-redacted>" : value));
  const leaked = scanned.match(CIPHERTEXT_SHAPE);
  if (leaked) {
    problems.push(`产物里出现密文形状的串：${leaked[0].slice(0, 24)}…`);
  }

  if (problems.length > 0) {
    throw new Error(`产物自检未通过：\n  - ${problems.join("\n  - ")}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { db } = TARGETS[args.env];
  const query = (sql) => d1Query(sql, { target: args.env });
  const idList = args.users.join(",");

  // 白名单缺人必须**当场停**，不能悄悄少导一个：少导 = prod 少一个人，而产物看起来
  // 一切正常（这正是"恒真绿"最贵的形态）。补救是显式改 --users，不是让脚本自己猜。
  const foundUsers = query(
    `SELECT\n${selectList(columnsOf(USER_FIELDS))}\n       FROM users WHERE id IN (${idList}) ORDER BY id;`,
  );
  const foundIds = new Set(foundUsers.map((row) => row.id));
  const missing = args.users.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `源库 ${db} 里找不到白名单用户 id=${missing.join(",")}。\n` +
        `  这不是可以忽略的差异：产物少一行 ⇒ prod 少一个人。请先确认该用户是否已被删除，\n` +
        `  再用 --users ${args.users.filter((id) => foundIds.has(id)).join(",")} 显式收窄白名单。`,
    );
  }

  // token 三列**不进 SELECT**（值不进内存就没有写进产物的机会），只要"是否非空"的布尔。
  const accountSelectColumns = columnsOf(ACCOUNT_FIELDS).filter(
    (column) => !ACCOUNT_TOKEN_DB_COLUMNS.includes(column),
  );
  const foundAccounts = query(
    `SELECT\n${selectList(accountSelectColumns)},
            (access_token IS NOT NULL) AS has_access_token,
            (refresh_token IS NOT NULL) AS has_refresh_token,
            (id_token IS NOT NULL) AS has_id_token
       FROM accounts WHERE user_id IN (${idList}) ORDER BY id;`,
  );

  // 密文列同样只取布尔（provider 的 api_key_enc 不 SELECT，产物里写死空串）。
  const providerSelectColumns = columnsOf(PROVIDER_FIELDS).filter(
    (column) => column !== "api_key_enc" && column !== "http_options_enc",
  );
  const foundProviders = query(
    `SELECT\n${selectList(providerSelectColumns)},
            (api_key_enc <> '') AS has_api_key_enc,
            (http_options_enc IS NOT NULL) AS has_http_options_enc
       FROM providers ORDER BY id;`,
  );

  const artifact = {
    generatedAt: new Date().toISOString(),
    source: { env: args.env, db },
    userAllowlist: [...args.users],
    roleOverrides: { ...ROLE_OVERRIDES },
    users: foundUsers.map(toArtifactUser),
    accounts: foundAccounts.map(toArtifactAccount),
    providers: foundProviders.map(toArtifactProvider),
  };
  // 下面两个「源库里有、产物里没有」的量只用于报告（产物自检在 validateArtifact 里）
  artifact.sourceStats = {
    providersWithCiphertext: foundProviders.filter((row) => row.has_api_key_enc).length,
    providersWithHttpOptions: foundProviders.filter((row) => row.has_http_options_enc).length,
    // = 发布窗口里要手工重填密钥的条数（R-A8：密钥不可跨环境搬）
    providersWithApiKeyPrefix: foundProviders.filter((row) => row.api_key_prefix !== "").length,
    accountsWithOAuthTokens: foundAccounts.filter(
      (row) => row.has_access_token || row.has_refresh_token || row.has_id_token,
    ).length,
  };

  validateArtifact(artifact);

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const byProvider = {};
  for (const account of artifact.accounts) {
    byProvider[account.providerId] = (byProvider[account.providerId] ?? 0) + 1;
  }
  console.log(`[export-seed] 源库 ${db}（${args.env}，只读）`);
  console.log(`[export-seed] users ${artifact.users.length}（id ${artifact.userAllowlist.join(",")}）`);
  console.log(
    `[export-seed] accounts ${artifact.accounts.length}` +
      `（${Object.entries(byProvider).map(([k, v]) => `${k} ${v}`).join(" + ")}）`,
  );
  console.log(`[export-seed] providers ${artifact.providers.length}（密文列已清空、enabled 全 0）`);
  console.log(
    `[export-seed] 源库里被丢弃的：密文 ${artifact.sourceStats.providersWithCiphertext} 行 /` +
      ` httpOptions ${artifact.sourceStats.providersWithHttpOptions} 行 /` +
      ` OAuth token ${artifact.sourceStats.accountsWithOAuthTokens} 行`,
  );
  console.log(
    `[export-seed] 提示：${artifact.sourceStats.providersWithApiKeyPrefix}/${artifact.providers.length}` +
      ` 个 provider 在源库配过上游密钥 ⇒ 发布窗口需在管理台手工重填同样条数`,
  );
  console.log(`[export-seed] 已写入 ${args.out}`);
}

main();
