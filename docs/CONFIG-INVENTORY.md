# 配置资产清单（CONFIG-INVENTORY）

日期: 2026-08-26 · 范围: 全仓"除代码逻辑外的一切参数/常量/配置" · 配套: [wrangler-config-extract](../.trellis/tasks/08-26-wrangler-config-extract/prd.md) C1

## 分类定义

| 分类 | 含义 | 去向 |
| --- | --- | --- |
| RENDER-ENV | infra 结构性配置，wrangler 要求 toml 字面量但可经模板渲染自 env | 本次 C2 移管至 `.dev.vars` → `npm run render:config` |
| NATIVE-KEY | 运行时 vars/secret，部署端需可覆盖（fail-fast） | 维持 wrangler 原生 `{KEY}` / secret put，不渲染 |
| KEEP-CODE | 业务默认值/安全策略常量 | 留在代码（已 spec 化） |
| KEEP-LITERAL | 工具链路径/平台契约/版本钉住/绑定名等 | 保留 toml/配置字面量 |

分类依据：wrangler v4 `{KEY}` 插值仅 `[vars]` 段生效；`database_id` / KV `id` / `routes` / `queue` 名 / `name` 等绑定级字段加载时必须为 TOML 字面量 → 这些值要脱离字面量管理只能走构建时模板渲染（见 C2 design.md）。

---

## 1. wrangler.toml（顶层 = production）

| 条目 | 位置 | 值来源 | 分类 | 理由 |
| --- | --- | --- | --- | --- |
| `name = "cf-ai-gateway"` | L6 | 部署名，环境差异 | RENDER-ENV → `WORKER_NAME` | 非秘密但属部署数据；改名需改字面量 |
| `main = "src/index.ts"` | L7 | 代码入口路径 | KEEP-LITERAL | 路径契约，非环境数据 |
| `compatibility_date` / `flags` | L8-9 | 平台契约 | KEEP-LITERAL | 版本钉住（nodejs_compat），漂移有风险 |
| `routes[].pattern = "router.lmlh.net"` | L14 | 自定义域名，环境差异 | RENDER-ENV → `DOMAIN` | 域名属环境数据；`custom_domain = true` 保留字面量 |
| `assets = { binding, directory, ... }` | L24 | 静态资源绑定 | KEEP-LITERAL | `binding="ASSETS"` 为代码引用契约；`directory="dist/client"` 构建产物路径 |
| `[[d1_databases]] database_name = "cf-ai-gateway-db"` | L30 | 资源名，环境差异 | RENDER-ENV → `D1_DB_NAME` | 见 package.json `db:migrate` 关联引用 |
| `[[d1_databases]] database_id` | L31 | dashboard 生成的资源 ID | RENDER-ENV → `D1_DB_ID` | 基础设施标识符（非秘密），wrangler 要求字面量 |
| `migrations_dir = "drizzle"` | L32 | 迁移目录 | KEEP-LITERAL | 工具链路径契约 |
| `binding = "DB"` / `"CACHE_KV"` / `"USAGE_QUEUE"` | 多处 | 代码引用名 | KEEP-LITERAL | env 类型字段名（src/env.d.ts 契约），改名需同步代码 |
| `[[kv_namespaces]] id` | L38 | dashboard 生成的资源 ID | RENDER-ENV → `KV_ID` | 同 D1 database_id |
| `[[queues.producers]] queue = "usage-aggregation"` | L43 | 队列名（创建时指定），环境差异 | RENDER-ENV → `QUEUE_NAME` | producers/consumers 两处同名引用 |
| `[[queues.consumers]] max_batch_size / max_retries` | L47-48 | 消费策略 | KEEP-LITERAL | 非环境数据，调优钉住 |
| `[triggers] crons = ["0 2 * * *"]` | L52 | 调度策略 | KEEP-LITERAL | UTC 固定时间策略，非环境数据 |
| `[vars]` 四项（`BETTER_AUTH_URL` / `GITHUB_CLIENT_ID` / `GITHUB_ALLOWED_EMAILS` / `REQUEST_LOG_RETENTION_DAYS`） | L61-64 | .dev.vars / 部署端 vars | NATIVE-KEY | 原生 `{KEY}`，部署端可运行时覆盖（repo-governance C3 定案） |

## 2. [env.staging] 段

| 条目 | 位置 | 值来源 | 分类 | 理由 |
| --- | --- | --- | --- | --- |
| `name = "cf-ai-gateway-staging"` | L71 | 部署名 | RENDER-ENV → `STAGING_WORKER_NAME` | 同顶层 |
| `routes[].pattern = "stg-router.lmlh.net"` | L73 | 自定义域名 | RENDER-ENV → `STAGING_DOMAIN` | 同顶层 |
| `database_name = "cf-ai-gateway-db-staging"` | L78 | 资源名 | RENDER-ENV → `STAGING_D1_DB_NAME` | 同顶层 |
| `database_id` | L79 | dashboard 生成的资源 ID | RENDER-ENV → `STAGING_D1_DB_ID` | 同顶层 |
| `kv id` | L84 | dashboard 生成的资源 ID | RENDER-ENV → `STAGING_KV_ID` | 同顶层 |
| `queue = "usage-aggregation-staging"` | L89/91 | 队列名 | RENDER-ENV → `STAGING_QUEUE_NAME` | producers/consumers 两处 |
| `migrations_dir` / `binding` / `crons` / `max_batch_size` / `max_retries` / `custom_domain` | 多处 | 同上 | KEEP-LITERAL | 契约/策略，同顶层 |
| `[env.staging.vars]` 四项 | L99-102 | .dev.vars / 部署端 vars | NATIVE-KEY | 不继承顶层，与顶层同键名同语义 |

## 3. drizzle.config.ts

| 条目 | 位置 | 分类 | 理由 |
| --- | --- | --- | --- |
| `schema: "./src/db/schema.ts"` / `out: "./drizzle"` | L10-11 | KEEP-LITERAL | 路径契约 |
| `dialect: "sqlite"` / `driver: "d1-http"` | L12-13 | KEEP-LITERAL | 技术选型钉住 |
| `dbCredentials: { accountId/databaseId/token = "local-dev" }` | L15-17 | KEEP-LITERAL | 本地离线校验占位假值（非真实凭据）；真实远程操作在 M7 部署时注入 |

## 4. vite.config.ts

| 条目 | 位置 | 分类 | 理由 |
| --- | --- | --- | --- |
| `@/` alias → `./app` | L10-13 | KEEP-LITERAL | 构建路径契约（spec directory-structure） |
| react/react-dom 单实例钉住（6 项） | L23-27 | KEEP-LITERAL | 构建修复契约，勿动 |
| `advancedChunks` react 分组 | L39-46 | KEEP-LITERAL | 构建策略 |

## 5. vitest.config.ts

| 条目 | 位置 | 分类 | 理由 |
| --- | --- | --- | --- |
| `testTimeout: 30_000` | L16 | KEEP-CODE | 测试策略（miniflare 内不可达上游超时） |
| `configPath: "./wrangler.toml"` | L20 | KEEP-LITERAL | 路径契约；生成物路径不变是渲染设计决策 |
| miniflare bindings 测试固定值（`GATEWAY_SECRET_KEY` / `BETTER_AUTH_SECRET` / `GITHUB_*` / `SEED_USERS` / `TEST_MIGRATIONS`） | L22-45 | KEEP-CODE | 仅存在于测试绑定的假值/种子，不落盘；与 .dev.vars 无关 |

## 6. package.json

| 条目 | 位置 | 分类 | 理由 |
| --- | --- | --- | --- |
| `name` / `version` / `private` / `engines.node` | L2-7 | KEEP-LITERAL | 包元数据/运行时要求 |
| scripts（dev/build/test/typecheck/lint/db:*/deploy 等） | L9-21 | KEEP-LITERAL | 命令契约；C2 追加 render:config + pre-* 钩子 |
| `db:migrate` / `db:seed` 内联 `cf-ai-gateway-db` | L17-18 | ⚠️ 关联引用 | 数据库名硬编码，与 `D1_DB_NAME` 耦合：改 D1_DB_NAME 需同步（C3 文档标注） |
| dependencies / devDependencies | L22-55 | KEEP-LITERAL | 版本契约 |

## 7. scripts/*.mjs

| 条目 | 位置 | 分类 | 理由 |
| --- | --- | --- | --- |
| `PORT = MOCK_PORT ?? 8788` | mock-upstream.mjs:12 | KEEP-CODE | mock 专用工具，env 可覆盖带默认 |
| `OPENAI_KEY = "sk-mock-openai"` / `ANTHROPIC_KEY = "sk-mock-anthropic"` | mock-upstream.mjs:13-14 | KEEP-CODE | mock 固定凭据（非真实 secret） |
| `BASE = BASE_URL ?? "http://localhost:5173"`（verify-m3/m4、seed-users） | 多处 | KEEP-CODE | 验证/种子脚本，env 覆盖带默认 |
| `DB_NAME = "cf-ai-gateway-db"`（verify-m3/m4） | verify-m3.mjs:12, verify-m4.mjs:17 | ⚠️ 关联引用 | 历史验证脚本，与 `D1_DB_NAME` 耦合；一次性工具，不再演进 |
| `ADMIN_EMAIL` / `MEMBER_EMAIL` / `PASSWORD` / `INVITE_*` / provider 常量 | verify-m3/m4 | KEEP-CODE | 验证脚本固定夹具（example.com 占位，非 PII） |
| `INPUT_PRICE` / `OUTPUT_PRICE` / `CHAT_COST` | verify-m4.mjs:36-38 | KEEP-CODE | 验证夹具（与 seed.sql gpt-4o-mini 价格一致） |

## 8. src/lib 与路由常量

| 条目 | 位置 | 分类 | 理由 |
| --- | --- | --- | --- |
| `DEFAULT_CACHE_TTL_SECONDS = 3600` | src/db/schema.ts:160 | KEEP-CODE | 业务默认值（M4 spec） |
| `DEFAULT_RETENTION_DAYS = 30` | src/lib/cleanup.ts:9 | KEEP-CODE | 保留期缺省；`REQUEST_LOG_RETENTION_DAYS` env 为运行时覆盖（缺省语义在代码） |
| `DELETE_CHUNK_SIZE = 500` / `MAX_CHUNKS = 400` | cleanup.ts:11-12 | KEEP-CODE | 清理批处理策略 |
| `PRICE_PER_MILLION = 1_000_000` | billing.ts:18 | KEEP-CODE | 计价单位换算常量 |
| `ANTHROPIC_MESSAGES_PATH` / `DEFAULT_MAX_TOKENS = 4096` | providers/anthropic.ts:18-20 | KEEP-CODE | 协议路径/缺省（spec） |
| `CODE_CHARS`（invites / security） | lib/invites.ts:8, lib/security.ts:5 | KEEP-CODE | 邀请码/密钥字符集策略 |
| `WINDOW_SECONDS = 60` / `COUNTER_TTL_SECONDS` | routes/v1/rate-limit.ts:9-11 | KEEP-CODE | 限流窗口策略（M4 spec） |
| `INVITE_CODE_REQUIRED` / `INVITE_CODE_INVALID` / `GITHUB_EMAIL_NOT_ALLOWED` | lib/auth.ts:20-22 | KEEP-CODE | 错误码契约 |
| `DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000` | lib/upstream.ts:5 | KEEP-CODE | 上游超时策略 |
| `UPSERT_CHUNK_SIZE = 100` | lib/usage-aggregation.ts:100 | KEEP-CODE | 聚合批处理策略 |
| `GATEWAY_KEY_PREFIX = "gw_"` / `RANDOM_LENGTH = 32` / `PREFIX_LENGTH = 10` | lib/api-keys.ts:5-8 | KEEP-CODE | API Key 格式策略（spec M3；前缀自定义属 feature/api-key-prefix 分支，不入本任务） |
| `CACHE_PREFIX = "resp:"` | lib/response-cache.ts:6 | KEEP-CODE | KV 键前缀约定 |
| `AGG_COLUMNS` / `PATH_BY_KIND` / `ADAPTERS` / `INPUT_SCHEMAS` | 多处 | KEEP-CODE | 协议映射/查询列映射（逻辑，非配置） |

## 9. seed.sql

| 条目 | 位置 | 分类 | 理由 |
| --- | --- | --- | --- |
| 模型默认价格表（19 行 INSERT OR IGNORE） | L4-28 | KEEP-CODE | 默认业务数据，admin 可在后台覆盖（M6）；幂等种子 |

## 10. .dev.vars.example（env 全键对照）

| 键 | 分类 | 理由 |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` / `GITHUB_CLIENT_SECRET` / `GATEWAY_SECRET_KEY` | NATIVE-KEY | 真实 secrets：仅 secret put / .dev.vars，禁入 toml，不渲染 |
| `BETTER_AUTH_URL` / `GITHUB_CLIENT_ID` / `GITHUB_ALLOWED_EMAILS` / `REQUEST_LOG_RETENTION_DAYS` | NATIVE-KEY | [vars] 原生 `{KEY}`（见 §1） |
| `SEED_USERS` | NATIVE-KEY | dev-only 初始化数据（生产禁止设置），仅 .dev.vars 注入，不进 toml 不渲染 |

## 11. docs 部署参数引用

| 条目 | 位置 | 分类 | 理由 |
| --- | --- | --- | --- |
| DEPLOY.md §1-3/§5 中 `router.lmlh.net` / `cf-ai-gateway-db(-staging)` / `usage-aggregation(-staging)` / `database_id` 复制指引 | DEPLOY.md L44-350 | RENDER-ENV | 流程文档须同步为"写入 .env/.dev.vars → render"（C3 处理） |
| VERIFICATION.md 验证记录（真实域名等） | VERIFICATION.md L7/116-117/152 | KEEP-LITERAL | 历史验证事实记录，保留 |

---

## RENDER-ENV 移管清单（与 C2 模板 token 对齐）

| Token | 值语义 | 模板出现位置（wrangler.toml.template） |
| --- | --- | --- |
| `WORKER_NAME` | 顶层 worker 名 | L6 `name` |
| `DOMAIN` | 顶层自定义域名 | L14 `routes[].pattern` |
| `D1_DB_NAME` | 顶层 D1 数据库名 | L30 `database_name` |
| `D1_DB_ID` | 顶层 D1 database_id | L31 |
| `KV_ID` | 顶层 KV namespace id | L38 |
| `QUEUE_NAME` | 顶层队列名 | L43（producers）+ L47（consumers） |
| `STAGING_WORKER_NAME` | staging worker 名 | L71 |
| `STAGING_DOMAIN` | staging 域名 | L73 |
| `STAGING_D1_DB_NAME` | staging D1 数据库名 | L78 |
| `STAGING_D1_DB_ID` | staging D1 database_id | L79 |
| `STAGING_KV_ID` | staging KV namespace id | L84 |
| `STAGING_QUEUE_NAME` | staging 队列名 | L89 + L91 |

共 12 token；本清单 RENDER-ENV 项与 C2 模板 token 集合一一对应（AC2）。渲染范围之外的键（secrets、NATIVE-KEY、SEED_USERS）不进渲染产物（红线）。

## 关联引用与一致性约束

1. **D1_DB_NAME ↔ package.json `db:migrate`/`db:seed` 内联名**：npm 脚本用数据库名定位 binding，D1_DB_NAME 变更须同步 package.json（C3 文档标注；不改渲染机制）。
2. **D1_DB_NAME ↔ verify-m3/m4 `DB_NAME`**：一次性历史验证脚本，不再演进，仅记录约束。
3. **生成物 wrangler.toml 路径不变**：vitest `configPath`、vite 插件默认、docs 命令全兼容（C2 design 决策）。
4. **双环境隔离**：STAGING_* token 独立，防止串环境；`.dev.vars.staging` 缺键回退 `.dev.vars` 共享键（仅限白名单内）。

## 零 PII / 凭据声明

- 本清单不含任何真实 secret 值、真实邮箱或资源 ID（D1/KV ID 仅以字段名+token 名表述，不粘贴值）。
- 真实 secrets（`BETTER_AUTH_SECRET` / `GITHUB_CLIENT_SECRET` / `GATEWAY_SECRET_KEY`）不在此清单值中，仅记录管理方式。
