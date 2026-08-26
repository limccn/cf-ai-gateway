# AI API Gateway — Acceptance Verification Record (AC1–AC9)

This document records the per-acceptance-criteria verification of the project PRD
(AC1–AC9). Local verification was executed at the end of milestone M8 (final
quality gate) with the Miniflare vitest suite and the end-to-end mock-upstream
scripts. AC9 (real deployment + GitHub OAuth end-to-end) has since been executed
against live production (`router.lmlh.net`) and staging (`stg-router.lmlh.net`)
environments; the corresponding sections are marked **PASSED (live)** with
deploy evidence in [`docs/DEPLOY.md`](./DEPLOY.md).

## Local verification environment

| Component | Command | Notes |
| --- | --- | --- |
| Unit + integration tests (Miniflare: D1/KV/Queues + main worker) | `npm test` | 46 tests, all green (M1–M7: 29 + M8 additions: 17) |
| Static checks | `npm run lint` · `npm run typecheck` | ESLint 0 errors; 3 tsconfig passes green |
| Deploy config validation | `npx wrangler deploy --dry-run` | Bundles Worker, validates bindings/vars/crons/assets |
| E2E (mock upstream) | `node scripts/mock-upstream.mjs` then `npm run dev` (separate shell), then `node scripts/verify-m3.mjs` / `node scripts/verify-m4.mjs` | Full chain through the real Worker |

> The E2E scripts bootstrap their own admin/member, invite codes, providers
> (OpenAI-compatible + Anthropic mocks), gateway keys, and assert every stage.
> They require a local D1 prepared with `npm run db:migrate`.

## AC1 — Proxy works end-to-end (non-streaming + streaming + models list)

**Status: PASSED (local, Miniflare + mock upstream)**

Evidence:

- `node scripts/verify-m3.mjs` section [4]: `chat non-stream` — 200 with mock
  completion content; `chat stream` — SSE chunks with final `usage` + `[DONE]`.
- `node scripts/verify-m3.mjs` section [6]: `/v1/models` returns the configured
  model list in OpenAI format.
- `npm test`: `tests/cache.test.ts`, `tests/rate-limit.test.ts` exercise the
  full `/v1/chat/completions` chain (auth → rate limit → balance → routing →
  upstream) inside Miniflare.

## AC2 — 401 invalid/revoked key · 402 insufficient balance · 429 rate limit

**Status: PASSED (local)**

Evidence:

- Invalid / missing key → `401` with `{error:{message}}`:
  `node scripts/verify-m3.mjs` section [6] `invalid key → 401`, `missing key → 401`.
- Revoked key → `401`: section [9] `revoked key → 401`.
- Zero balance → `402`: section [8] `zero balance → 402`.
- QPS limit → `429` (OpenAI-style error body): section [7] `3 calls with limit 2 → [200,200,429]`,
  plus `tests/rate-limit.test.ts` (windowed counter, key isolation, default qps 60).

## AC3 — Anthropic adapter (conversion + streaming)

**Status: PASSED (local, mock Anthropic upstream)**

Evidence: `node scripts/verify-m3.mjs` section [5]:

- Non-streaming conversion: system prompt split, `max_tokens` injected,
  `{content:[{type:text}]}` → OpenAI choices.
- Streaming SSE conversion: `message_start` → role delta, content deltas joined,
  `finish_reason=stop`, usage tail (25/15) mapped, `[DONE]` emitted.
- Tools streaming: `tool_use` → OpenAI `tool_calls` delta (name, arguments, finish).

> A real Anthropic account is not required for the conversion logic; the mock
> upstream (`scripts/mock-upstream.mjs`, port 8788) reproduces the Anthropic
> Messages API event samples. Real-account execution is part of AC9.

## AC4 — Billing (correct deduction, detail rows, no charge on failure)

**Status: PASSED (local)**

Evidence:

- `tests/billing.test.ts`: `calcCost` per price table; `chargeUsage` writes
  `balance_tx(usage)` + `request_logs(success)`; `cost <= 0` → no charge but
  detail row kept; insufficient balance → `charged=false`; **concurrency: 50 ×
  cost 1 against balance 10 → exactly 10 charged, final balance 0**.
- `node scripts/verify-m4.mjs`: non-stream cost charged (`balance ≈ 60 − 2×cost`),
  stream settlement charged, **upstream 500 not charged**, `request_logs`
  status/`ref_request_id` checked via D1 SQL.
- `tests/transactions.test.ts`: the new ledger endpoints return these
  transactions with pagination and filters (AC7).

## AC5 — Response cache (hit → no forward, no charge)

**Status: PASSED (local)**

Evidence:

- `tests/cache.test.ts`: pre-seeded cache → hit returns cached body, balance
  unchanged, no `usage` tx, detail status `cached`; miss → real upstream path
  (502 against dead upstream, no charge, detail `error`).
- `node scripts/verify-m4.mjs` section [7]: cache miss charged, **cache hit not
  charged**, D1 shows `status='cached'`.

## AC6 — Authentication (GitHub OAuth whitelist + invite registration) and RBAC

**Status: PASSED**

Evidence:

- Invite-code email/password registration + login: `node scripts/verify-m3.mjs`
  sections [1]–[2] (invite codes, register, login, session cookie).
- RBAC enforcement (member vs admin) across the API — verified in the vitest
  suite with real Better Auth sessions:
  - `tests/usage.test.ts`: member → `/api/admin/usage` 403; member filters by
    someone else's `keyId` → 403; unauthenticated → 401.
  - `tests/settings.test.ts` (M8): `/api/admin/settings` 401 anon / 403 member /
    200 admin.
  - `tests/transactions.test.ts` (M8): `/api/admin/transactions` 401/403.
  - `node scripts/verify-m4.mjs`: member price-table write → 403, member balance
    adjust → 403.
- Provider API keys are masked in every API response (mask logic in
  `src/lib/mask.ts`; exercised by `scripts/verify-m3.mjs` provider creation).

> GitHub OAuth end-to-end executed live: real GitHub OAuth Apps registered for
> production and staging (callbacks `https://router.lmlh.net/api/auth/callback/github`
> and `https://stg-router.lmlh.net/api/auth/callback/github`); secrets set via
> `wrangler secret put` (never committed); whitelist fail-closed
> (`src/lib/github-whitelist.ts`). Login tested in both environments by two
> real accounts; first admin bootstrap done via direct D1 UPDATE (the only
> bootstrap path — no self-promotion endpoint by design).

## AC7 — Reports (member own / admin global with filters)

**Status: PASSED (local)**

Evidence:

- `tests/usage.test.ts`: member own aggregates + details with pagination;
  `groupBy=model`; `from/to` date filtering (UTC day bounds); admin global with
  `userId`/`keyId`/`model`/range filters; aggregation numbers match details.
- `tests/transactions.test.ts` (M8): `GET /api/me/transactions` (own ledger,
  pagination, type/time filters) and `GET /api/admin/transactions` (`userId`
  filter) — the billing page data source.
- M6 admin UI pages (Usage / Billing / Dashboard) consume these endpoints with
  React Query; the frontend is built green (`npm run build`).

## AC8 — All tests pass; CI has no eslint errors

**Status: PASSED**

Evidence (M8 quality gate, all green on this commit):

```bash
npm run lint        # ESLint 0 errors (src/ + app/ + tests/; no any, no !, no console.log)
npm run typecheck   # 3 tsconfigs (worker / app / tests)
npm test            # 46 tests, 7 files — all pass (vitest + Miniflare)
```

## AC9 — Deployable from scratch via the manual; deployed live

**Status: PASSED (live)** — production `router.lmlh.net` + staging `stg-router.lmlh.net`

Verified locally:

- `wrangler.toml` is complete: D1 / KV / Queues producer+consumer / cron /
  assets + vars; `npx wrangler deploy --dry-run` passes (bundles and validates).
- `docs/DEPLOY.md` is a from-scratch, executable manual: create D1 → KV → Queue
  → migrations → seed → secrets/vars → GitHub OAuth App → first admin bootstrap
  → build/deploy → post-deploy verification checklist (Step 9, AC1–AC9 mapped).

Executed live (2026-08-25, both environments, fully isolated resources —
separate D1 ×2 / KV ×2 / Queues ×2 / secrets ×4):

- Deployed with `npx wrangler deploy --config wrangler.toml` (+ `--env staging`);
  custom domains bound (routes with `custom_domain=true`, auto TLS).
- Post-deploy checks all passed: health ok, SPA loads, `/v1/models` + `/api/users`
  → 401, D1 seeded (19 models per env), `/login` renders (after the dual-React
  bundle fix, see git history `38b60f4`).
- GitHub OAuth login tested with real accounts in both environments; two users
  promoted to admin via direct D1 UPDATE (accounts redacted for public repo).
- Deploy gotchas recorded in DEPLOY.md: always `--config wrangler.toml`
  (generated `dist/cf_ai_gateway/wrangler.json` drops `[env.*]` sections);
  wrangler v4 removed `wrangler domains` (use `custom_domain = true` routes);
  local curl needs `--ssl-no-revoke` + `--resolve` (DNS pollution / offline CRL).

---

## M8 additions (this milestone)

| Addition | Verification |
| --- | --- |
| Unified zod validation errors (`{error:{message}}` for all 400s, API + proxy) | `tests/error-format.test.ts` (unit + HTTP on `/api/me/usage`, `/api/me/transactions`, `/v1/chat/completions`) |
| `GET /api/admin/settings` (admin read-only) | `tests/settings.test.ts` (401/403/200; values match code constants: cache TTL 3600s, rate window 60s, retention 30d) |
| `GET /api/me/transactions` + `GET /api/admin/transactions` | `tests/transactions.test.ts` (pagination, type/time filters, admin `userId` filter, 401/403, 400 unified format) |
| Settings page + Billing page read real data | `npm run build` green; typecheck green; no mocked data in `app/routes/settings.tsx` / `app/routes/billing.tsx` |

## Known deviations

- `PATCH /api/admin/settings` is not implemented (by design): the displayed
  defaults are code constants with no runtime mutation mechanism. Recorded in
  the README known-deviations section.
- The `recharge` transaction type exists in the schema/enum (design §2) but is
  not written by any endpoint; admin top-ups are recorded as `adjust`.
- GitHub OAuth end-to-end and production deployment are executed and recorded
  in AC6/AC9 above.
