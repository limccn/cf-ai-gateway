# AI API Gateway — Production Deployment Guide

This guide walks through deploying the AI API Gateway to Cloudflare Workers from scratch:

1. Create the D1 database, KV namespace, and Queue
2. Apply migrations and seed the model price table
3. Configure secrets and variables
4. Register the GitHub OAuth App
5. Bootstrap the first admin user
6. Build and deploy the Worker
7. Verify the production deployment against the project acceptance criteria (AC1–AC9)

**Runtime model.** The Worker is a single Hono application serving the admin API (`/api/*`), the OpenAI-compatible proxy (`/v1/*`), and the React SPA (static assets). All runtime configuration is read from the request context (`c.env.*`) — never from build-time constants — so every value below is set either in `wrangler.toml` (`[vars]`) or as a Workers secret. **`wrangler.toml` is a generated artifact**: `npm run render:config` renders it from `wrangler.toml.template` + `.dev.vars` (bindings-level names/IDs/domains are managed in `.dev.vars`, never hand-edited in the generated file). See `wrangler.toml.template`, `.dev.vars.example`, and `src/env.d.ts` for the authoritative list.

---

## Prerequisites

- **Node.js >= 20** and npm (see `package.json` `engines`)
- A **Cloudflare account** with the Workers free or paid plan enabled
- **Wrangler** — installed as a project devDependency; use `npx wrangler ...` from the repository root
- A **GitHub account** with access to [GitHub OAuth Apps settings](https://github.com/settings/developers)
- The repository checked out locally, `npm install` completed

### Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser and stores credentials locally. For CI, use a token instead:

```bash
export CLOUDFLARE_API_TOKEN=your-api-token
```

### Local development (reference)

The same configuration works locally with Miniflare — no Cloudflare account required:

```bash
npm install
# create .dev.vars with local values (see Step 5) — the file is gitignored
npm run render:config   # render wrangler.toml from wrangler.toml.template + .dev.vars
npm run db:migrate      # wrangler d1 migrations apply cf-ai-gateway-db --local
npm run db:seed         # wrangler d1 execute cf-ai-gateway-db --local --file=./seed.sql
npm run dev             # Vite dev server: http://localhost:5173 (API at /api/*, /v1/*)
```

`npm run render:config` is idempotent and runs automatically before `dev`/`test`/`deploy`/`db:*` (pre-hooks); re-run it explicitly whenever you change infra values in `.dev.vars`. During `wrangler dev`, values from `.dev.vars` take precedence over `[vars]` in `wrangler.toml`, so the placeholder values below do not affect local development.

---

## Step 1 — Create the D1 database

```bash
npx wrangler d1 create cf-ai-gateway-db
```

The output includes a `database_id`. Add it to `.dev.vars` as `D1_DB_ID` (fill `D1_DB_NAME`/`WORKER_NAME`/`DOMAIN` and the `STAGING_*` variants too — see `.dev.vars.example`), then regenerate the config:

```bash
npm run render:config   # wrangler.toml.template + .dev.vars -> wrangler.toml (gitignored)
```

> The `D1_DB_NAME` value must stay in sync with the npm scripts (`db:migrate`/`db:seed` reference `cf-ai-gateway-db` literally) and the remote commands in Step 4. `migrations_dir = "drizzle"` tells wrangler where the migrations live. The full token list is in `docs/CONFIG-INVENTORY.md`.

---

## Step 2 — Create the KV namespace

The KV namespace backs response caching (keys `resp:<keyId>:<model>:<hash>`) and the rate-limit fixed-window counters (keys `rate:<keyId>:<windowStart>`).

```bash
npx wrangler kv namespace create CACHE_KV
```

Copy the returned `id` into `.dev.vars` as `KV_ID` (staging: `STAGING_KV_ID`), then re-run `npm run render:config` (or rely on the pre-hooks — the next `npm run dev` / `npm test` / `npm run deploy` re-renders automatically).

---

## Step 3 — Create the Queue

The Queue carries usage events from the request path to the aggregation consumer (same Worker, `queue` handler in `src/index.ts`).

```bash
npx wrangler queues create usage-aggregation
```

No id needs to be copied — set the queue name in `.dev.vars` as `QUEUE_NAME` (staging: `STAGING_QUEUE_NAME`); the template declares both the producer (`USAGE_QUEUE`) and the consumer from that value. Verify the name matches:

```bash
grep -A2 '\[\[queues.producers\]\]' wrangler.toml   # queue = "<QUEUE_NAME>"
```

---

## Step 4 — Apply migrations and seed the price table

Apply all migrations to the remote D1 database:

```bash
npx wrangler d1 migrations apply cf-ai-gateway-db --remote
```

Seed the default model price table (idempotent — safe to re-run):

```bash
npx wrangler d1 execute cf-ai-gateway-db --remote --file=./seed.sql
```

Verify:

```bash
npx wrangler d1 execute cf-ai-gateway-db --remote --command "SELECT COUNT(*) AS model_count FROM models;"
```

> **Migrations are additive only** (create tables / add columns, never drop or rename). This guarantees that `wrangler rollback` to an older Worker version keeps working against the current schema — no schema rollback is ever required.

---

## Step 5 — Configure environment variables and secrets

Cloudflare Workers read runtime values through the request context (`c.env.*`). The repo keeps **no individual-person data or credentials in `wrangler.toml`**: PII/environment-specific values are declared as `"{KEY}"` placeholders resolved from `.dev.vars` (local), Cloudflare side vars/secrets, or shell exports at deploy time. Sensitive values are set with `wrangler secret put` (encrypted, never stored in the repo). Resource names/IDs (D1/KV/Queue), the Worker name, and custom domains are infrastructure identifiers (not secrets) but Wrangler requires them as TOML literals — since `wrangler.toml` is generated, manage them in `.dev.vars` (tokens `WORKER_NAME` / `DOMAIN` / `D1_DB_NAME` / `D1_DB_ID` / `KV_ID` / `QUEUE_NAME` + `STAGING_*` variants) and run `npm run render:config`.

### 5.1 Variables (`wrangler.toml [vars]`, `"{KEY}"` placeholders)

Declared as placeholders in `wrangler.toml` — **set each value on the Worker side before deploying** (dashboard → Settings → Variables, as a plain-text var or encrypted secret; a secret with the same name also resolves the placeholder).

| Variable | Required | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_URL` | Yes | Base URL of Better Auth (session cookies, OAuth redirects). Must equal the deployed origin, e.g. `https://cf-ai-gateway.<your-subdomain>.workers.dev` or your custom domain. A missing value breaks all authentication. |
| `GITHUB_CLIENT_ID` | GitHub login | Client ID of the GitHub OAuth App (public identifier — not secret). |
| `GITHUB_ALLOWED_EMAILS` | GitHub login | Comma-separated email whitelist. Empty means **all GitHub logins are rejected** (fail-closed). |
| `REQUEST_LOG_RETENTION_DAYS` | No (default `30`) | Retention in days for `request_logs` detail rows, enforced by the daily cleanup cron. |
| `API_KEY_PREFIX` | No (default `sk-`) | Prefix of newly created gateway API keys (`prefix` + 32-char Base62). Blank counts as unset; only affects keys created after the value is set. |

> Missing placeholders fail the deploy (fail-fast) — a good safety net. For CI deploys you can also `export BETTER_AUTH_URL=...` etc. in the shell; `.dev.vars` is only read for local commands, **not** for `wrangler deploy`.

### 5.2 Sensitive secrets (`wrangler secret put`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `GATEWAY_SECRET_KEY` | Yes | AES-GCM key used to encrypt upstream provider API keys at rest. Any string, recommend >= 32 random characters. |
| `BETTER_AUTH_SECRET` | Yes | Better Auth session-signing secret. Must be a fresh random value (not the same as `GATEWAY_SECRET_KEY`). |
| `GITHUB_CLIENT_SECRET` | GitHub login | Client secret of the GitHub OAuth App (created in Step 6). |

Generate two independent random secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Run once for `GATEWAY_SECRET_KEY`, once more for `BETTER_AUTH_SECRET`. Then set them:

```bash
npx wrangler secret put GATEWAY_SECRET_KEY
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Secrets are per environment. Verify names with:

```bash
npx wrangler secret list
```

> Secrets can be changed without a redeploy. Values in `[vars]` are baked in at deploy time — if you expect to change `BETTER_AUTH_URL`, `GITHUB_ALLOWED_EMAILS`, or `GITHUB_CLIENT_ID` frequently, set them with `wrangler secret put` instead (a secret with the same name overrides the `[vars]` value).

### 5.3 Local development equivalent

Copy the committed template (placeholder values) and edit:

```bash
cp .dev.vars.example .dev.vars   # then fill in your own local values
npm run render:config            # render wrangler.toml from the template + your .dev.vars
```

`.dev.vars` must contain every key the Worker reads (local values; the template spells out each one with comments): the infra tokens from Steps 1–3 (top-level + `STAGING_*`), the §5.1 variable placeholders, the §5.2 secrets, and the optional `SEED_USERS` for seeding local test users — see §5.4 below:

### 5.4 Seeding local test users (`SEED_USERS`, dev only)

Set `SEED_USERS` (JSON array string) in `.dev.vars` and the dev worker exposes `POST /api/seed/users` to create login-ready accounts through Better Auth (properly hashed passwords, optional `role: "admin"` promotion). Idempotent — re-running skips existing emails.

```bash
SEED_USERS=[{"email":"admin@local.dev","password":"change-me-123","name":"Admin","role":"admin"},{"email":"member@local.dev","password":"change-me-123","name":"Member","role":"member"}]
```

Then, with `npm run dev` running:

```bash
npm run seed:users
```

> **Never set `SEED_USERS` in production/staging.** The route is only registered while the variable is present — with it absent the endpoint returns 404. See the `SEED_USERS` warning in `.dev.vars.example`.

---

## Step 6 — Register the GitHub OAuth App

1. Open <https://github.com/settings/developers> → **New OAuth App**.
2. **Homepage URL**: `https://<your-domain>/`
3. **Authorization callback URL** (exact, no trailing slash):
   ```
   https://<your-domain>/api/auth/callback/github
   ```
   The origin must match `BETTER_AUTH_URL` — this is the Better Auth social-provider callback path. A mismatch shows a `redirect_uri` error from GitHub.
4. Set the **Client ID** on the deployment as a Worker variable: dashboard → Settings → Variables (plain text) in the same environment, or export `GITHUB_CLIENT_ID` in the deploy shell — `wrangler.toml` resolves `"{GITHUB_CLIENT_ID}"` from either.
5. Generate a **Client secret** and set it:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
6. Put the email of every GitHub account that may log in into `GITHUB_ALLOWED_EMAILS` (comma-separated; set the variable like `GITHUB_CLIENT_ID` in step 4). The check is case-insensitive and compares against the verified email GitHub's API returns for the account (typically the primary email). The first account must be the future admin — see Step 7.
7. If you changed variables, redeploy (Step 8).

---

## Step 7 — Bootstrap the first admin user

**How this works in the codebase.** There is no auto-promotion: every new user is created with `role = 'member'` (database default). Admin-only features (user management, invite-code creation, provider configuration, balance adjustment) require an existing admin, so the very first admin must be promoted directly in D1.

The only from-scratch path is GitHub OAuth:

1. Deploy with `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_ALLOWED_EMAILS` configured (Steps 5–6).
2. Open `https://<your-domain>/login` and **Sign in with GitHub** using the whitelisted account. The user is created with `role = 'member'`.
3. Promote the account:
   ```bash
   npx wrangler d1 execute cf-ai-gateway-db --remote --command "UPDATE users SET role = 'admin' WHERE email = 'admin@example.com';"
   ```
4. Verify:
   ```bash
   npx wrangler d1 execute cf-ai-gateway-db --remote --command "SELECT id, email, role, status FROM users WHERE email = 'admin@example.com';"
   ```
5. Refresh the admin UI. The role is read from the database on every request, so no re-login is required.

**Afterwards.** The admin promotes/demotes users and manages invite codes from the admin panel (admin API: `PATCH /api/users/:id`, `POST /api/users/invites`). Email/password registration always requires an invite code; GitHub login always requires whitelisting.

> **Do not create users with direct SQL INSERT.** Password hashing and OAuth account linking are handled by Better Auth; manual inserts create unusable accounts. The `UPDATE users SET role = 'admin'` above is the only sanctioned direct-D1 operation, and it is one-time bootstrap.

---

## Step 8 — Build and deploy

Run the local quality gates first:

```bash
npm run typecheck
npm test
```

Build the SPA and validate the config without uploading:

```bash
npm run build                      # vite build -> dist/ (served as Worker assets)
npx wrangler deploy --dry-run --config wrangler.toml   # validates bindings/vars/crons
```

Deploy:

```bash
npx wrangler deploy --config wrangler.toml
```

Or use the combined script: `npm run deploy` (build + deploy). Prefer the explicit `--config wrangler.toml` — see the multi-environment note below.

> **Important (multi-environment).** The `@cloudflare/vite-plugin` generates
> `dist/cf_ai_gateway/wrangler.json` during `vite build` and wrangler
> automatically uses it as a *redirected configuration* — but that generated
> file drops the `[env.*]` sections. If you use environments, always pass the
> authoritative config explicitly:
> `npx wrangler deploy --env staging --config wrangler.toml`. See
> [Multi-environment](#multi-environment-staging--production) below.

The first deploy prints the Worker URL: `https://cf-ai-gateway.<your-subdomain>.workers.dev`. To use a custom domain, declare it in `wrangler.toml` as a route (the domain must be hosted on Cloudflare):

```toml
routes = [
  { pattern = "router.lmlh.net", custom_domain = true },
]
```

`custom_domain = true` auto-creates the domain (with TLS certificate) on the next `wrangler deploy`. Note: `wrangler v4` **removed** the `wrangler domains add` subcommand — configuration-declared routes are the supported path. If the final origin differs from `BETTER_AUTH_URL` (and the GitHub callback URL), update the variable on the deployment side (or `DOMAIN` in `.dev.vars` + `npm run render:config` for the route) and redeploy before continuing.

---

## Step 9 — Post-deploy verification checklist

Run these against the production URL after the first admin has completed onboarding (provider configured with a real upstream key, admin topped up the test user's balance, a gateway API key created). Each check maps to the project acceptance criteria (PRD AC1–AC9).

| # | AC | Check | Command / expected |
| --- | --- | --- | --- |
| 1 | AC1 | Health probe | `curl -s https://<your-domain>/api/health` → `{"ok":true,...}` |
| 2 | AC1 | Model list | `curl -s https://<your-domain>/v1/models -H "Authorization: Bearer <gateway-key>"` → configured models in OpenAI format |
| 3 | AC1 | Non-streaming proxy | `curl -s https://<your-domain>/v1/chat/completions -H "Authorization: Bearer <gateway-key>" -H "Content-Type: application/json" -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hi"}]}'` → correct completion, usage in response |
| 4 | AC1 | Streaming proxy | Same request with `"stream":true` (add `-N`) → SSE chunks (`data: ...` lines), final `usage` chunk |
| 5 | AC2 | Invalid key | Wrong/revoked key → `401` with OpenAI-style `{"error":{...}}` |
| 6 | AC2 | Insufficient balance | Set user balance to 0 (admin) → request returns `402` |
| 7 | AC2 | Rate limit | Raise a key's `qps_limit` to 1 (or script a burst) → subsequent request within the 60s window returns `429` |
| 8 | AC3 | Anthropic adapter | Configure an Anthropic provider; request a `claude-*` model in OpenAI format (streaming and non-streaming) → converted response works |
| 9 | AC4 | Billing deduction | Snapshot balance → one successful request → balance decreased by the price-table cost; admin usage page shows the request detail with token counts and cost |
| 10 | AC4 | No charge on failure | Point a provider at a dead URL → request fails, balance unchanged |
| 11 | AC5 | Response cache | Enable caching on a key; call the same non-streaming request twice → second response identical, balance unchanged, detail row status `cached` |
| 12 | AC6 | GitHub whitelist | Login attempt with a non-whitelisted email → rejected; whitelisted email → succeeds |
| 13 | AC6 | RBAC | Member: `GET /api/users` → `403`, provider keys masked/hidden; Admin: sees users and can configure providers |
| 14 | AC7 | Member reports | Member dashboard shows own usage, balance, and bill/transaction list |
| 15 | AC7 | Admin reports | Admin usage page filters by user / key / model over a time range; aggregated numbers match request details |
| 16 | AC9 | Queue aggregation | After traffic, `usage_daily` aggregates appear in reports within ~1 minute (consumer batch) |
| 17 | — | Cron retention | `npx wrangler tail` shows the daily `scheduled` event at 02:00 UTC; `request_logs` older than `REQUEST_LOG_RETENTION_DAYS` get deleted (verify by checking row counts decrease) |

> AC8 (tests + lint) is a deploy-side gate: `npm run typecheck` and `npm test` must be green before `wrangler deploy` — that is Step 8.

---

## Multi-environment (staging + production)

Two fully isolated environments are configured: **production** (top-level `wrangler.toml`, worker `cf-ai-gateway`) and **staging** (`[env.staging]`, worker `cf-ai-gateway-staging`). Every resource is per-environment — a staging deploy can never touch production data.

| Resource | production | staging |
| --- | --- | --- |
| Worker | `cf-ai-gateway` (`wrangler deploy`) | `cf-ai-gateway-staging` (`wrangler deploy --env staging`) |
| D1 | `cf-ai-gateway-db` | `cf-ai-gateway-db-staging` |
| KV | `CACHE_KV` (b2df81c4…) | `CACHE_KV` (f76273f5…) |
| Queue | `usage-aggregation` | `usage-aggregation-staging` |
| Custom domain | `router.lmlh.net` | `stg-router.lmlh.net` |
| `BETTER_AUTH_URL` | `https://router.lmlh.net` | `https://stg-router.lmlh.net` |

Environment-specific commands — repeat each step per environment with `--env`:

```bash
# create resources (once per environment) — copy ids into .dev.vars as STAGING_* tokens,
# then run `npm run render:config` (staging: `npm run render:config -- --env staging` reads .dev.vars.staging)
npx wrangler d1 create cf-ai-gateway-db-staging          # copy database_id into STAGING_D1_DB_ID
npx wrangler kv namespace create CACHE_KV --env staging  # copy id into STAGING_KV_ID
npx wrangler queues create usage-aggregation-staging     # set STAGING_QUEUE_NAME

# migrate + seed (per environment)
npx wrangler d1 migrations apply cf-ai-gateway-db-staging --remote --env staging
npx wrangler d1 execute cf-ai-gateway-db-staging --remote --env staging --file=./seed.sql

# secrets (per environment — independent values!)
npx wrangler secret put GATEWAY_SECRET_KEY --env staging
npx wrangler secret put BETTER_AUTH_SECRET --env staging

# deploy (per environment)
npm run build                                  # one build, assets shared
npx wrangler deploy --env staging --config wrangler.toml
npx wrangler deploy --config wrangler.toml     # production
```

**`[env.*]` sections are dropped by the Vite-plugin redirect.** `vite build` writes `dist/cf_ai_gateway/wrangler.json` and wrangler prefers it automatically, but that generated file contains only the top-level (production) config. Always deploy with `--config wrangler.toml` (as shown above) or delete `dist/cf_ai_gateway/` before deploying; otherwise `--env staging` silently deploys the production config.

`[env.staging]` does **not** inherit top-level `[vars]` — repeat all vars inside the env section. Top-level `assets`, `compatibility_date` and flags are inherited.

---

## Operations

### Rollback

```bash
npx wrangler rollback
```

Rolls the Worker back to the previous deployed version instantly. Because D1 migrations are strictly additive, an older Worker keeps working against the current schema. Never roll back or edit applied D1 migrations; add a new migration instead.

### Logs

```bash
npx wrangler tail --format pretty
```

Shows fetch, queue, and scheduled events with the application's structured logs (`request_id`, `user_id`, `role`, `path`, billing/rate-limit events). `wrangler tail` does not work with `wrangler deploy --dry-run` — use it on the live Worker.

### Cron (detail retention)

The `[triggers]` cron runs daily at 02:00 UTC: it deletes `request_logs` older than `REQUEST_LOG_RETENTION_DAYS` (default 30) in batches of 500. Production cron events cannot be triggered manually — observe them with `wrangler tail`. To test locally:

```bash
npx wrangler dev --test-scheduled
# then: curl "http://localhost:8787/__scheduled?cron=0+2+*+*+*"
```

### KV cache flush

- **Response cache**: keys `resp:<keyId>:<model>:<hash>`, TTL per key (`cache_ttl`, default 3600s). Entries expire on their own.
- **Rate-limit counters**: keys `rate:<keyId>:<windowStart>`, auto-expire after 120s (twice the 60s window, to avoid residue across window boundaries).
- To flush cached responses immediately: Cloudflare dashboard → Workers → KV → `CACHE_KV` → filter by prefix `resp:` → bulk delete. Cache expiry is the normal lifecycle; a flush is only needed when you must invalidate stale responses right away.

---

## Reference — environment variables

| Variable | Where it is set | Required | Used by |
| --- | --- | --- | --- |
| `BETTER_AUTH_URL` | `wrangler.toml [vars]` | Yes | `src/lib/auth.ts` — base URL / trusted origin / callbacks |
| `BETTER_AUTH_SECRET` | `wrangler secret put` | Yes | `src/lib/auth.ts` — session signing |
| `GATEWAY_SECRET_KEY` | `wrangler secret put` | Yes | `src/lib/security.ts` — AES-GCM encryption of upstream provider keys |
| `GITHUB_CLIENT_ID` | `wrangler.toml [vars]` | GitHub login | `src/lib/auth.ts` — OAuth client id |
| `GITHUB_CLIENT_SECRET` | `wrangler secret put` | GitHub login | `src/lib/auth.ts` — OAuth client secret |
| `GITHUB_ALLOWED_EMAILS` | `wrangler.toml [vars]` | GitHub login | `src/lib/github-whitelist.ts` — login whitelist (empty = fail-closed) |
| `REQUEST_LOG_RETENTION_DAYS` | `wrangler.toml [vars]` | No (default 30) | `src/lib/cleanup.ts` — cron retention |
| `DB` | `[[d1_databases]]` binding | Yes | `src/db/index.ts` |
| `CACHE_KV` | `[[kv_namespaces]]` binding | Yes | `src/routes/v1/rate-limit.ts`, `src/lib/response-cache.ts` |
| `USAGE_QUEUE` | `[[queues.producers]]` binding | Yes | `src/routes/v1/proxy.ts` — usage events |
| `ASSETS` | `assets` binding | Yes | `src/index.ts` — SPA fallback |

Bindings (`DB`, `CACHE_KV`, `USAGE_QUEUE`, `ASSETS`) are declared in `wrangler.toml` and require no further action. The `Env` types come from `worker-configuration.d.ts` (generated by `npx wrangler types`) merged with `src/env.d.ts`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| OAuth callbacks / links point at `localhost` or `REPLACE-ME` | `BETTER_AUTH_URL` not replaced in `wrangler.toml [vars]` | Set the real origin, redeploy (see big-question `env-configuration.md`) |
| GitHub error `redirect_uri` mismatch | Callback URL in GitHub ≠ `https://<your-domain>/api/auth/callback/github` exactly | Fix the callback URL in GitHub OAuth App settings; origin must match `BETTER_AUTH_URL` |
| All GitHub logins rejected | `GITHUB_ALLOWED_EMAILS` empty (fail-closed) or the email GitHub returns is not listed | Add the verified email to the whitelist; compare case-insensitively |
| `500` on login | `BETTER_AUTH_SECRET` or `GITHUB_CLIENT_SECRET` missing in the deployed environment | `npx wrangler secret list`; set missing secrets (secrets are per environment) |
| Deploy succeeds but D1/KV writes fail | Placeholder ids still in `wrangler.toml` | Replace `database_id` / KV `id` from Steps 1–2, redeploy |
| Works locally, breaks in production | `.dev.vars` overrides `[vars]` locally only | Check `[vars]` and secrets in the deployed environment |
| First request returns `402` | New user balance is 0 by default | Admin tops up the user via user management |
| `npm run dev` unaffected by `[vars]` | `.dev.vars` takes precedence in `wrangler dev` | Edit `.dev.vars`, not `wrangler.toml`, for local changes |
| `curl` fails with `CRYPT_E_REVOCATION_OFFLINE` | Windows schannel cannot reach the CRL endpoint | Add `--ssl-no-revoke` to curl |
| `*.workers.dev` times out / resolves to a foreign IP | `workers.dev` is DNS-poisoned on some networks; use the custom domain instead | Verify through the custom domain (`router.lmlh.net`); the custom domain resolves normally |
