# AI API Gateway

[![CI](https://github.com/limccn/cf-ai-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/limccn/cf-ai-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An **OpenAI-compatible AI API gateway** that proxies multiple model vendors
(OpenAI-compatible APIs + Anthropic native) through a single entry point, with
team key management, prepaid balance billing, rate limiting, response caching,
usage analytics, and a full web admin console — **100% on Cloudflare**
(Workers / D1 / KV / Queues), no external services.

Applications keep using the OpenAI SDK and only switch the base URL to the
gateway. The gateway authenticates requests with its own API keys
(`Authorization: Bearer`), routes `model` names to configured upstream
providers, converts requests/responses to/from the Anthropic Messages format
when needed, and settles billing per token from the price table.

## Features

- **Unified proxy (OpenAI-compatible)**: `POST /v1/chat/completions`,
  `POST /v1/completions`, `POST /v1/embeddings`, `GET /v1/models`; non-streaming
  and streaming (SSE passthrough).
- **Pluggable upstream adapters**: `openai` (OpenAI / DeepSeek / Qwen / Moonshot
  / Gemini-compatible base URLs) and `anthropic` (full request/response/SSE
  format conversion). Adding a provider type only requires a new adapter.
- **Model disguise mapping**: a provider's `models` map (`internal name → upstream
  name`) works in both directions — the request is sent upstream under the mapped
  name, while every model name in the response is rewritten back to the internal
  name the client requested (non-streaming `model` field, every SSE chunk,
  `message_start.message.model`, error-message text, and `owned_by` in
  `/v1/models`). Identity mappings (`internal === upstream`) are zero-overhead.
- **Team & keys**: GitHub OAuth login (email whitelist, fail-closed) +
  email/password registration with admin invite codes; roles `admin` / `member`;
  per-user API keys (SHA-256 hashed at rest, plaintext shown once) with per-key
  `qps_limit` and caching settings. An account-security switch
  (`EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED`, default **off**) governs whether
  email-registered accounts may be promoted to `admin` at all.
- **Prepaid billing (per token)**: price table seeded with common models and
  admin-overridable; conditional-UPDATE atomic deduction (no overcharge under
  concurrency); `balance_tx` ledger; failures are never charged; cache hits are
  never charged.
- **Rate limiting**: KV fixed-window counter per key (default 60 req/min,
  configurable per key) → `429`.
- **Response cache**: normalized-body hash → KV (per key, TTL per key, default
  3600s); hits return without forwarding and without charging.
- **Usage analytics**: every request writes a `request_logs` detail row (tokens,
  cost, latency, upstream latency, status); a Queues consumer aggregates into
  `usage_daily`; member sees own reports, admin sees global reports filterable
  by user / key / model / time range.
- **Ledger & settings**: member transaction history
  (`/api/me/transactions`) and admin global ledger (`/api/admin/transactions`);
  admin read-only runtime defaults (`/api/admin/settings`).
- **Web console (React SPA)**: login/register, dashboard, keys, billing,
  usage, providers, models, users, settings — all served by the same Worker
  (`/api/*` + `/*` same-origin).
- **Retention**: daily cron purges `request_logs` older than
  `REQUEST_LOG_RETENTION_DAYS` (default 30).

## Tech stack

| Layer | Technology |
| --- | --- |
| Runtime | Cloudflare Workers (single Worker, `nodejs_compat`), Hono |
| Data | D1 (SQLite via Drizzle ORM), KV (cache + rate-limit counters), Queues (usage aggregation) |
| Auth | Better Auth (email/password + GitHub OAuth, D1 adapter) |
| Validation | Zod (`zod` v4 + `@hono/zod-validator`) |
| Frontend | React 19, React Router v7, Vite, Tailwind CSS v4, shadcn-style UI, React Query |
| Quality | TypeScript strict, ESLint (flat config), Vitest + Miniflare, drizzle-kit migrations |

## Requirements

- Node.js >= 20, npm
- No Cloudflare account needed for local development (Miniflare emulates D1/KV/Queues)

## Local quick start

> Branching model & release flow: see [CLAUDE.md](CLAUDE.md) — trunk-style dev on `develop`, `staging`/`production` as deploy pointer branches, `main` for major versions only.

```bash
git clone <your-repo-url> cf-ai-gateway
cd cf-ai-gateway
npm install

# 1. Create .dev.vars (gitignored) from the committed template —
#    cp .dev.vars.example .dev.vars and fill in local values (see CLAUDE.md §环境与配置)

# 2. Render wrangler.toml from the template (gitignored generated file —
#    never edit it by hand; infra values come from .dev.vars, see CLAUDE.md §环境与配置)
npm run render:config

# 3. Prepare the local D1 database
npm run db:migrate     # apply Drizzle migrations
npm run db:seed        # seed the default model price table (idempotent)

# 4. Start the dev server (Worker API + React SPA + Miniflare bindings)
npm run dev            # http://localhost:5173
```

Open <http://localhost:5173> and register with an invite code. To create the
first admin locally, promote a user in the local D1:

```bash
npx wrangler d1 execute cf-ai-gateway-db --local \
  --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
```

> `npm run dev` needs `.dev.vars` to exist for Better Auth to start. GitHub
> OAuth is optional locally — email/password registration with an invite code
> works standalone.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run render:config` | Render `wrangler.toml` from `wrangler.toml.template` + both value files (`.dev.vars` / `.dev.vars.staging`, segment-aware; idempotent; auto-runs before dev/test/deploy/db:*) |
| `npm run dev` | Vite dev server (Worker + SPA, Miniflare bindings) |
| `npm run build` | Build the React SPA (Vite) into `dist/` |
| `npm test` | Vitest suite (unit + integration, Miniflare: D1/KV/Queues) |
| `npm run typecheck` | TypeScript across 3 configs (worker / app / tests) |
| `npm run lint` | ESLint over `src/` + `app/` + `tests/` |
| `npm run db:generate` | Generate a Drizzle migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to the local D1 (`--local`) |
| `npm run db:seed` | Seed the local model price table (`seed.sql`) |
| `npm run seed:users` | Seed local test users via `SEED_USERS` in `.dev.vars` (dev only) |
| `npm run deploy` | `npm run build` + `wrangler deploy` |

## Testing & verification

- **Unit + integration tests** (`tests/`): billing (`billing.test.ts`),
  rate limiting (`rate-limit.test.ts`), response cache (`cache.test.ts`),
  usage/aggregation/cleanup (`usage.test.ts`), unified zod error format
  (`error-format.test.ts`), runtime settings (`settings.test.ts`), transaction
  ledger (`transactions.test.ts`). Run with `npm test`.
- **End-to-end scripts** (`scripts/`): full-chain verification against a mock
  upstream (OpenAI-compatible + Anthropic):

  ```bash
  node scripts/mock-upstream.mjs     # terminal 1: mock upstream on :8788
  npm run dev                        # terminal 2: the gateway
  node scripts/verify-m3.mjs         # terminal 3: auth → keys → providers → /v1/* (incl. Anthropic streaming)
  node scripts/verify-m4.mjs         # billing, rate limit, cache, admin balance
  ```

- **Acceptance verification record**: `CLAUDE.md §验收状态` maps every PRD
  acceptance criterion (AC1–AC9) to its verification method, commands, and
  result. AC6/AC9 (GitHub OAuth end-to-end + live deployment) are recorded as
  executed against production and staging. (The extended verification spec
  lives in an internal, gitignored spec store and is not shipped with this
  repository.)

## Deployment

Live environments: **staging** `https://stg-platform.lmlh.net` (public API
`https://stg-api.lmlh.net`) and **production** `https://platform.lmlh.net`
(public API `https://api.lmlh.net`). The legacy hostnames stay bound as
forwarding sources, so existing `base_url` values keep working unchanged.
Fully isolated resources — separate D1 / KV / Queues / secrets. Deploy with:

```bash
npm run build
npx wrangler deploy --config wrangler.toml          # production (top-level config)
npx wrangler deploy --config wrangler.toml --env staging
```

> Always pass `--config wrangler.toml`: the generated
> `dist/cf_ai_gateway/wrangler.json` drops the `[env.*]` sections, so
> `--env staging` would silently deploy the production config.

Deployment from scratch (create D1 / KV / Queue → migrate → secrets → GitHub
OAuth App → first admin bootstrap → deploy → verify) is documented in
**[`CLAUDE.md`](./CLAUDE.md) §部署要点** (the extended manual lives in an
internal, gitignored spec store and is not shipped with this repository).
The repository ships with
`wrangler.toml.template` + `.dev.vars.example` — `wrangler.toml` is a gitignored
generated file, so run `npm run render:config` (or `npm install` + pre-hooks)
before any deploy. Validate without uploading via
`npx wrangler deploy --dry-run --config wrangler.toml`.

## API overview

Management API (session auth, roles `admin`/`member`):

| Endpoint | Access | Description |
| --- | --- | --- |
| `/api/auth/*` | public | Better Auth (email/password, GitHub OAuth) |
| `/api/invites/validate` | public | Pre-check an invite code before sign-up (`valid: true/false`, non-consuming, rate-limited) |
| `/api/me/usage` | member | Own usage aggregates + details (paged) |
| `/api/me/transactions` | member | Own balance ledger (paged, type/time filters) |
| `/api/keys` | member/admin | Own gateway keys CRUD (admin sees all) |
| `/api/users` | admin | User list/role/status, invites, balance adjust |
| `/api/providers` | admin | Upstream providers CRUD (keys AES-GCM encrypted, masked in responses) |
| `/api/models` | member/admin | Model price table (read-only for member; admin CRUD + per-row free/hidden flags) |
| `/api/admin/usage` | admin | Global usage with user/key/model/time filters |
| `/api/admin/transactions` | admin | Global ledger with optional `userId` filter |
| `/api/admin/settings` | admin | Runtime defaults (read-only) |
| `/api/health` | public | Liveness probe |

Role changes on `/api/users` are subject to the deployment's account-security
switch: with `EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED` off (the default),
promoting an email-registered account to `admin` is refused with `403` and the
console disables the action for those rows. Demotions, status changes, existing
admins and the first-admin bootstrap (direct D1 `UPDATE`) are unaffected.

Proxy API (gateway-key auth, three protocol entry points):

| Endpoint | Protocol | Description |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | Chat completions (streaming + non-streaming) |
| `POST /v1/completions` | OpenAI | Text completions |
| `POST /v1/embeddings` | OpenAI | Embeddings |
| `GET /v1/models` | OpenAI | Configured model list |
| `POST /v1/messages` | Dual auto-detect | Anthropic Messages **or** OpenAI Chat Completions — detected per request (hard signals, else `claude-*` → Anthropic / otherwise OpenAI) |
| `POST /v1/responses` | OpenAI Responses | Responses API (streaming SSE has no `[DONE]` terminator, per official protocol) |
| `POST /anthropic/v1/messages` | Anthropic Messages | Anthropic Messages API — official Anthropic SDK baseURL target |
| `POST /anthropic/messages` | Anthropic Messages | Alias of the above (pathless SDK baseURLs) |

Errors follow the protocol of the entry point: OpenAI style
`{ "error": { "message": "..." } }` on the `/v1/*` surfaces (including Zod
validation failures), Anthropic style `{ "type": "error", "error": { "type": ..., "message": ... } }`
on the `/anthropic/*` surfaces. `/v1/messages` errors follow the *detected* protocol:
Anthropic-detected requests get Anthropic error shapes, OpenAI-detected requests get
OpenAI error shapes; requests that mix both protocols are rejected with `400`.

### SDK baseURL conventions

Point official SDKs at the gateway with a gateway API key
(`Authorization: Bearer sk-…` or Anthropic SDK's `x-api-key`):

```ts
// Anthropic TS SDK
const anthropic = new Anthropic({ apiKey: "sk-…", baseURL: "https://<gateway>/anthropic" });
await anthropic.messages.create({ model, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] });

// OpenAI TS SDK (Responses API)
const openai = new OpenAI({ apiKey: "sk-…", baseURL: "https://<gateway>/v1" });
await openai.responses.create({ model, input: "hi" });
```

Anthropic SDK requests carry `x-api-key` + `anthropic-version` headers natively;
both are accepted at every proxy entry point (`x-api-key` falls back when
`Authorization: Bearer` is absent).

## Known deviations

- **`PATCH /api/admin/settings` is not implemented.** The values exposed by
  `GET /api/admin/settings` (default cache TTL 3600s, rate-limit window 60s,
  `request_logs` retention 30d) are code constants — there is no runtime
  mechanism to change them (per-key `cache_ttl`/`qps_limit` remain configurable
  per key). The Settings page is read-only by design.
- **`recharge` ledger type is not written by any endpoint.** The type exists in
  the schema/enum (design §2); admin top-ups are recorded as `adjust`.
- **Live environments require user-provided credentials** (GitHub OAuth App
  client secrets via `wrangler secret put`, real upstream provider keys
  configured through the admin console) — see `CLAUDE.md §部署要点` for the
  production checklist. Live deployment is done (staging
  `stg-platform.lmlh.net`; production `platform.lmlh.net` + `api.lmlh.net`,
  with `router.lmlh.net` kept as a legacy forwarding source).

## Project layout

```
src/                 Worker backend (Hono)
  routes/            API modules (usage, billing, settings, keys, providers, models, users, v1)
  middleware/        requestContext, requireSession/adminOnly, gateway auth
  lib/               billing, rate limiting, cache, cleanup, security, adapters helpers
  providers/         openai / anthropic adapters + SSE conversion
  db/                Drizzle schema + D1 access
app/                 React SPA (React Router v7, React Query, Tailwind)
tests/               Vitest + Miniflare suite
scripts/             mock upstream + E2E verification scripts
CLAUDE.md            knowledge entry (git workflow / env config / deploy / AC summary; extended specs live in a local, gitignored store — not shipped)
drizzle/             SQL migrations
```
