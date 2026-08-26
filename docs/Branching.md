# 分支策略（Repo Governance）

> 生效日期：2026-08-26。trunk 式开发 + 部署分支模型。
> 大版本/发布推进均通过 PR 合入（见文末"保护规则"），普通提交只直接推 `develop`。

## 分支职责

| 分支 | 用途 | 写入方式 |
| --- | --- | --- |
| `develop` | 日常开发与本地调试（默认分支） | 直接 push |
| `staging` | 上线前版本准备（可部署验收） | 发布准备时从 `develop` 推进 |
| `production` | 最终版本发布（线上环境） | 验收通过后从 `staging` 推进 |
| `main` | **仅大版本升级**（如 M6→M7 语义断代）；普通迭代不走 main | 大版本时从 `production` 合并 + 打 tag |

## 生命周期（如何推进一次上线）

```bash
# 1. 日常开发直接推 develop
git push origin develop

# 2. 上线前准备 → staging
git push origin develop:staging        # 或开一个 develop→staging 的 PR

# 3. 发布 → production
git push origin staging:production     # 或开一个 staging→production 的 PR

# 4. 大版本（罕见，语义断代才做）
git push origin production:main        # 或 PR；随后打 tag，如 v2.0.0
```

`staging` / `production` 本质上是指向"该环境正在运行代码"的指针分支：平常不开发；发布时推进一次并部署对应的 wrangler 环境（staging 用 `wrangler deploy --env staging`，production 用 `wrangler deploy`，见 docs/DEPLOY.md）。

## 保护规则

目标状态：`main` / `staging` / `production` 禁止直接 push，须 PR 合入；`develop` 不设限（trunk 日常开发）。

> **当前限制**：本仓库为私有仓库（免费版）——GitHub 对私有仓库的分支保护/Rulesets 需要 Pro 或公开仓库。因此规则当前仅记录于此，**转公开时（公开前 checklist 见 docs/SECURITY-AUDIT.md）按下方命令启用**。

```bash
# 转公开后启用（三个分支各执行一次）
gh api -X PUT repos/limccn/cf-ai-gateway/branches/{main,staging,production}/protection --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
JSON
```

要点：

- `required_approving_review_count: 0`：单人开发不会被 review 卡死，但仍强制走 PR（GitHub 要求 PR 才能合入）。
- `required_linear_history: true`：禁 merge-commit，保持 trunk 线性历史。
- `allow_force_pushes: false` / `allow_deletions: false`：防误删重建事件重演（2026-08-26 曾为重置分支重建过一次）。

## 历史事件记录

- 2026-08-26：远程 `develop` / `staging` / `production` 三个分支曾指向同一提交（语义失真），按本策略删除后重建。
- 2026-08-26（同日，公开 repo 准备）：为彻底清除历史 PII（见 docs/SECURITY-AUDIT.md），`develop` 全部历史压为**单一提交** `03352b0` 并推送；远程 `staging` / `production` 分支删除（下次发布时从 develop 按本页流程重建）；远程 `main` 重置至初始提交 `c76a57e`。旧提交对象备份于本地分支 `feature/migrate-from-store`。