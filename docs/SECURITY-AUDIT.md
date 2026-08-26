# Security Audit — 公开 repo 准备（2026-08-26）

> 目标：确认仓库（含 git 历史与工作区）无真实凭据与个人 PII，允许转公开。
> 工具：gitleaks 8.30.1（官方 Windows 二进制）+ Bash 正则兜底（历史全量 + 工作区）。
> 说明：本审计文档同样遵守"不重述 PII"原则 —— 以下对发现的个人邮箱一律以"所有者邮箱/协作者邮箱"代称，不在仓库任何文件中出现真实地址。

## 扫描结果汇总

| 范围 | 工具 | 结果 |
| --- | --- | --- |
| git 全历史（14 commits，~1.46 MB，`--all`） | gitleaks | **0 命中** |
| 工作区（9.5 MB，含未跟踪文件） | gitleaks | 4 命中 → 全部为 `.trellis/.template-hashes.json` 的文件哈希指纹（SHA-256 路径→哈希映射表，工具内部状态，已被 `.gitignore` 忽略，非密钥） |
| 历史 + 工作区正则兜底 | 手工 | `sk-*` / `gh[pousr]_*` / `AKIA*` / `BEGIN PRIVATE KEY` / Bearer token（除测试假 key `gw_invalidkey...`）/ 硬编码密码：**零真实命中** |
| `.env` / `.dev.vars` 曾入史 | git log | **从未提交**（零历史） |
| 跟踪清单 | `git ls-files` | 全部为应用源码/文档；`.trellis/`、`.claude/`、`.dev.vars`、`.wrangler/`、`dist/` 均在 `.gitignore` |

## 已修复项

1. **`wrangler.toml` 个人 PII**：`GITHUB_ALLOWED_EMAILS` 真实邮箱 → 改为 `"{GITHUB_ALLOWED_EMAILS}"` 插值引用（值只存在于部署端与本地 .dev.vars）。
2. **`docs/VERIFICATION.md` 真实邮箱** → 打码（"accounts redacted for public repo"）。
3. **GitHub OAuth Client ID** 从 toml 移除 → 插值引用。注：OAuth Client ID 本身是公开标识符（GitHub 设计如此），移除属于治理统一，非必需。
4. 新增 `.dev.vars.example` 模板（占位符值）入库；`.gitignore` 补 `.env*` 系列 + `.dev.vars.example` 豁免。

## 无需处理项（判定理由）

- **D1/KV/Queue 资源 ID**：基础设施标识符（非秘密）；wrangler 要求 toml 字面量，为 Cloudflare 官方惯例。泄露影响面 = 可枚举资源名，不构成访问凭据。
- **`.dev.vars.example` 内的 "change-me" 占位符**：非真实凭据，被 gitleaks 正常放行。
- **历史中的 GitHub Client ID**：公开标识符（同第 3 条理由）。

## 历史 PII 处置：已完成（最终方案）

- 2026-08-26 用户拍板清除历史 PII，最终执行方式 = **全量 squashing**：
  - `develop` 全部历史压为**单一提交** `03352b0`（M1~M8 + 仓库治理全部内容，无 PII、无中间历史）。
  - 远程 `develop` 已指向 `03352b0`；远程 `staging` / `production` 分支已**删除**；远程 `main` 重置至初始提交 `c76a57e`。
  - 旧提交对象（含 PII）仅存于本地作为备份：`feature/migrate-from-store` 分支 + `/tmp/gw-backup.bundle`，**远程仓库已无任何 PII 历史**。
- 后续如需要，在本地备份上可用 `git filter-repo` 温和清除（当前无必要——远程已干净）。

## 公开前 checklist（转公开时执行）

1. [x] 历史 PII 处置已定案并执行（2026-08-26 squash 方案，远程零 PII 历史）。
2. [ ] Branching.md 内分支保护命令执行（私有免费版受限，转公开后可用）—— main/staging/production 需 PR + 线性历史（staging/production 重建后再配置）。
3. [ ] 确认 GitHub 远端无 workflow 泄露（无 .github 目录，无 CI 配置泄漏面）。
4. [ ] 公开后在 Settings 确认 Secrets/Deploy Keys/Webhooks 等信息干净。
5. [ ] 删除或停用本地调试 `SEED_USERS` 生产端配置（理应从未配置过；双保险）。
6. [ ] 若日后公开中 CI：deploy 用 `CF_API_TOKEN` 走 secret（本仓库无 CI，未来新增时遵守 spec backend/environment.md 分类）。

## 复扫命令（保留备查；仅通用模式，不含真实地址）

```bash
# 全历史
gitleaks git . --log-opts="--all" --redact
# 工作区
gitleaks dir .
# 历史/工作区邮箱形态复扫（公开前应 0 命中）
git log -p --all | grep -niE "[a-z0-9._%+-]+@(gmail|qq|163|outlook)\.com"
git grep -niE "[a-z0-9._%+-]+@(gmail|qq|163|outlook)\.com" $(git rev-list --all) 2>/dev/null | head
```