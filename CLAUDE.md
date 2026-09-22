# CLAUDE.md — cf-ai-gateway

> 本文件是仓库知识入口（2026-08-28 重建）：合并了原 `docs/` 下 6 份文档的要点。
> 原文档已移管至本地 Trellis spec（`.trellis/spec/governance/`，**不入 git**）；全量细节在那里，本文档是已提交的权威摘要与索引。
> 开发任务流程另见 `.trellis/workflow.md`。

## 项目概览

OpenAI 兼容的 **AI API 网关**：单入口代理多家模型供应商（OpenAI 兼容 + Anthropic 原生格式转换），提供团队 key 管理、预付费余额计费、限流、响应缓存、用量分析、Web 管理台。**100% Cloudflare**（Workers / D1 / KV / Queues），无外部服务。SDK 只换 base URL 即可接入。

- 管理 API：`/api/*`（Better Auth 会话鉴权，角色 admin/member）；代理 API：`/v1/*`、`/anthropic/*`（网关 key 鉴权）。
- 技术栈：Cloudflare Workers（Wrangler v4+）、Hono、Drizzle ORM、D1（SQLite）、KV、Queues、Better Auth、Zod v4、React 19 + React Router v7 + Vite + Tailwind v4、Vitest + Miniflare。
- 已上线：生产 `https://router.lmlh.net`、staging `https://stg-router.lmlh.net`（资源完全隔离）。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run render:config` | 由 `wrangler.toml.template` + 两个值文件（`.dev.vars` / `.dev.vars.staging`，段感知）渲染 `wrangler.toml`（幂等；dev/test/deploy/db:* 前自动跑） |
| `npm run dev` | Vite dev server（Worker + SPA，Miniflare 绑定） |
| `npm run build` | 构建 React SPA 到 `dist/` |
| `npm test` | Vitest 全量（Miniflare：D1/KV/Queues） |
| `npm run typecheck` / `npm run lint` | 3 个 tsconfig 类型检查 / ESLint |
| `npm run db:generate` / `db:migrate` / `db:seed` | Drizzle 迁移生成 / 应用（本地 `--local`）/ 种子价格表 |
| `npm run seed:users` | 按 `.dev.vars` 的 `SEED_USERS` 造本地测试用户（dev only） |
| `npm run deploy` | build + `wrangler deploy` |

## Git 运用规范（最高约束）

> 全量：`.trellis/spec/governance/git-workflow.md`；分支职责/保护/历史事件：`governance/branching.md`。

### 分支模型

| 分支 | 职责 |
| --- | --- |
| `develop` | 唯一 trunk，始终可部署；只接受特性 merge 提交与治理 docs，**禁止直接提交特性代码** |
| `feat/<name>` | 特性开发，合并进 develop 后即删（短生命周期） |
| `staging` / `production` | 发布指针分支，平常不开发，发布时推进 |
| `main` | 仅大版本（语义断代） |

### 特性开发流程（强制 5 步）

```bash
git checkout develop && git pull origin develop    # ① 基于最新 trunk
git checkout -b feat/<kebab-case>                  # ② 开发（提交可多个）

git rebase develop && git reset --soft develop \
  && git commit -m "feat(scope): 一句话摘要 — 要点1、要点2"   # ③ squash 为单提交

git checkout develop && git merge --no-ff feat/<name> \
  -m "Merge feat/<name> into develop: <与 squash 摘要一致>"   # ④ --no-ff 合并

git branch -d feat/<name>                          # ⑤ 删除
```

每个特性在 develop 上 = **1 个 squash 提交 + 1 个 merge 节点**；merge 信息与 squash 摘要一致（`git log --first-parent develop` 可读）。

### 提交前缀

`feat` / `fix` / `test` / `docs` / `chore` / `release`；中文描述，` — ` 分隔要点，scope 可选（`fix(deploy)`）。大版本在 main 打 tag（`v2.0.0`）。

### 红线

1. 禁止直接向 develop 提交特性代码（治理 docs 除外）。
2. 禁止重写已共享历史（develop/staging/production 均已推送 origin）。
3. 历史重写前必须先建备份 tag `backup/<name>-<yyyymmdd>`，完成后更新 branching.md 历史事件记录。
4. stash 随用随清。
5. 删分支前核验已合并（`git diff develop <branch>` 为空或仅剩有意差异）。
6. 多会话协作：重写/删除/reset 前先 `git rev-parse` 校验分支状态，可能影响其他会话的操作先声明。

> push / PR / 发布由仓库所有者（limccn）执行；自动化与助手不得擅自 push。
> 分支保护规则（main/staging/production 转公开后启用）见 `governance/branching.md`。

## 环境与配置（env 三分类）

> 全量：`.trellis/spec/governance/config-inventory.md`（RENDER-ENV token 清单，2026-09-22 实测 **20 个**——段感知改造后 `STAGING` 前缀的孪生键已全删，一套 token 名两段各取一份值）。

1. **真实 secret**（`BETTER_AUTH_SECRET` / `GITHUB_CLIENT_SECRET` / `GATEWAY_SECRET_KEY`）→ 本地 `.dev.vars`、生产 `wrangler secret put`。**禁止出现在 wrangler.toml / 代码 / 文档值中**。
2. **PII 与环境差异值**（`GITHUB_ALLOWED_EMAILS` / `BETTER_AUTH_URL` / `GITHUB_CLIENT_ID` / `REQUEST_LOG_RETENTION_DAYS` / `API_KEY_PREFIX`）→ wrangler.toml `[vars]` 渲染烘焙，值在**基段 ← `.dev.vars`**、**`[env.*]` 段 ← `.dev.vars.staging`**（再回退 `.dev.vars`）/ 部署 shell export（`process.env` 优先）；缺失即 fail-fast。**策略开关**（`CACHE_ENABLED` / `EMAIL_VERIFICATION_ENABLED` / `EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED` 等）走同一机制，缺省一律**关闭**（fail-closed）。
3. **基础设施资源 ID**（D1 database_id、KV id、Queue 名、worker 名、自定义域名）→ toml 字面量，经 `wrangler.toml.template` 模板 token（`WORKER_NAME` / `DOMAIN` / `D1_DB_*` / `KV_ID` / `QUEUE_NAME` / `BILLING_QUEUE_NAME`）渲染管理，**两段同名**。

**关键坑（2026-08-26 实测）**：wrangler 4.x **不解析 `{KEY}` 占位符**——`[vars]` 值必须在构建期烘焙真实值（`npm run render:config`），否则占位符字面量进运行时。渲染脚本仅读白名单键、缺键 fail-fast、值含本地占位特征（localhost/placeholder-/@example.com）时 WARN。

- `wrangler.toml` 是**生成物**（gitignored），勿直改；改配置走两个值文件 + render。**渲染是段感知的**：一次 `npm run render:config` 同时产出两环境的正确内容，`--env` 渲染参数已移除（传入即 fail-fast）——部署哪个环境只由 `wrangler deploy [--env staging]` 决定。
- `.dev.vars.example` / `.dev.vars.staging.example` 是全部键的权威模板（提交入库）；本地 `cp .dev.vars.example .dev.vars` 填本地值，`cp .dev.vars.staging.example .dev.vars.staging` 填 staging 值（**同名键**）。`.dev.vars.staging` 缺失时环境段回退到 `.dev.vars`（只 WARN），**不可据此部署 staging**。
- **顶层 `[vars]` 就是生产值，来源是 `.dev.vars`（同时也服务本地 dev）**——本地为跑邮件链路填的开关/白名单会被 `predeploy` 原样烘焙进生产。发生产前须在部署 shell `export EMAIL_VERIFICATION_ENABLED` / `EMAIL_ALLOWED_RECIPIENTS` 覆盖并核对 deploy banner。详见 deployment.md「Production mail safety」。
- `SEED_USERS` 仅本地 dev 用（设置才注册 `POST /api/seed/users` 路由）；**生产/staging 切勿设置**。
- 改 env 相关代码后自查：`git grep` 真实值、`git status` 确认 `.dev.vars` 未跟踪、`git check-ignore` 复核忽略规则。

## 部署要点

> 全量从零手册：`.trellis/spec/governance/deployment.md`（9 步：D1 → KV → Queue → 迁移+seed → secrets/vars → GitHub OAuth App → 首个 admin → build+deploy → 验收清单）。

- **永远显式 `--config wrangler.toml`**（staging 加 `--env staging`）：vite 插件生成的 `dist/cf_ai_gateway/wrangler.json` 丢弃 `[env.*]` 段，不带 `--config` 时 `--env staging` 会静默部署生产配置。
- D1 迁移**只增不改**（保证 `wrangler rollback` 兼容旧版本）；回滚用 `wrangler rollback`，勿改已应用迁移。
- secrets 每环境独立（`--env staging`）；`GATEWAY_SECRET_KEY` / `BETTER_AUTH_SECRET` 分别生成独立随机值（`crypto.randomBytes(32)`），二者不得相同。
- 首个 admin 无自提升端点：GitHub OAuth 登录（白名单内）→ 直接 D1 `UPDATE users SET role='admin'`（唯一合法 bootstrap；**禁止 SQL INSERT 造用户**——Better Auth 哈希/绑定会被绕过）。
- `[env.staging]` 不继承顶层 `[vars]`；顶层 assets / compatibility_date 继承。
- GitHub OAuth 回调必须精确等于 `https://<origin>/api/auth/callback/github`（origin 与 `BETTER_AUTH_URL` 一致）；`GITHUB_ALLOWED_EMAILS` 为空 = 拒绝所有登录（fail-closed）。
- cron 每日 02:00 UTC 清理 `request_logs`（保留 `REQUEST_LOG_RETENTION_DAYS`，默认 30）。
- 本地 curl 验证线上可能需 `--ssl-no-revoke`（Windows schannel CRL）与自定义域名（workers.dev 域名在部分网络被 DNS 污染）。

## 验收状态（AC1–AC9 全部 PASSED）

> 全量证据与复跑命令：`.trellis/spec/governance/verification.md`。

- 本地：`npm test`（46 tests）+ `npm run lint` + `npm run typecheck` + `wrangler deploy --dry-run` 全绿。
- E2E：`node scripts/mock-upstream.mjs`（:8788）+ `npm run dev` + `node scripts/verify-m3.mjs` / `verify-m4.mjs`（auth → keys → providers → /v1/* → 计费/限流/缓存）。
- AC6/AC9 已线上验证（2026-08-25，prod + staging，真实 GitHub OAuth 账号登录、双 admin 经 D1 提升）。
- 已知偏差：`PATCH /api/admin/settings` 未实现（只读设计）；`recharge` 账目类型无端点写入（管理端充值记为 `adjust`）。

## 安全（公开 repo 准备）

> 全量：`.trellis/spec/governance/security-audit.md`。

- 2026-08-26 gitleaks 全历史 **0 命中**；历史 PII 已全量 squash 清除（`03352b0`），远程零 PII；备份在本地 tag `backup/develop-pre-reorg-20260827` + `/tmp/gw-backup.bundle`。
- 本仓库无 CI、无 .github 目录；转公开前执行 security-audit.md 的 checklist（分支保护、Secrets 检查、SEED_USERS 确认等）。

## Spec 索引与工作流

- Spec 主索引：`.trellis/spec/README.md`（backend / frontend / shared / guides / big-question / **governance**）。
- Governance 类目（本仓库治理/运维全量）：`.trellis/spec/governance/index.md`。
- 开发任务工作流（任务创建需用户同意）：`.trellis/workflow.md`。
- 原 `docs/` 目录已于 2026-08-28 删除（内容移管至此 + 本文件）。
