# AI API Gateway

![AI API Gateway](doc/banner.png)

[![CI](https://github.com/limccn/cf-ai-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/limccn/cf-ai-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**[中文](README.md) | English**

**A self-hosted, OpenAI-compatible AI API gateway — one entry point that proxies multiple model vendors, 100% on Cloudflare, with no external services.**

## What is this

Converge multiple model vendors (OpenAI-compatible APIs and the Anthropic native format) into a single unified entry point: your application keeps using the official SDKs and only points its base URL at the gateway. The gateway handles authentication with its own issued API keys, prepaid pay-per-use billing, rate limiting and caching, and provides a web admin console for usage reports, keys, members and model pricing.

## Who is it for / What can it do

For individuals and teams who want to manage multiple model vendors in one place — especially if you are moving an existing OpenAI / Anthropic application to a self-hosted entry point, or need to hand out rate-limited keys to members with pay-per-use billing:

- One entry point for multiple models (OpenAI compatible + Anthropic native format)
- Nearly zero application-side changes: only switch the SDK's base URL, and change only the `model` parameter to switch models
- Team keys: issue a key per person, each individually rate-limited and revocable at any time
- Prepaid balance, billed per token; failed requests are never charged
- Built-in rate limiting and response caching: over-quota requests are rejected automatically, repeated requests are faster and cheaper
- Web admin console: view usage reports; manage keys, members and model prices
- Data and keys stay in your own Cloudflare account (self-hosted)

## Quick start

Deploy your own instance to Cloudflare in three steps:

1. **Clone and install**: `git clone <your-repo-url> cf-ai-gateway && cd cf-ai-gateway && npm install`
2. **Configure environment variables**: `cp .dev.vars.example .dev.vars`, then fill in the required values as described in the next section
3. **Deploy**: `npm run deploy` (builds the app, renders the config, and runs `wrangler deploy --config wrangler.toml` automatically)

> Before your first deployment you also need to create the D1 / KV / Queue resources on Cloudflare, apply the database migrations, write in the secrets, and set up the first admin — see the full from-scratch checklist in [CLAUDE.md](CLAUDE.md) §部署要点.

### Required environment variables and configuration

All configuration lives in `.dev.vars` (copied from `.dev.vars.example`; the file is gitignored — **never commit it**). Three categories:

**① Infrastructure identifiers** (no fallback values — any missing one fails the config render) — fill these in after creating your Cloudflare resources:

| Key | Description |
| --- | --- |
| `WORKER_NAME` | Worker name (resources follow the `<worker>-<purpose>` naming convention) |
| `DOMAIN` / `API_DOMAIN` / `LEGACY_DOMAIN` | Platform domain / public API domain / legacy forwarding domain |
| `D1_DB_NAME` / `D1_DB_ID` | D1 database name / id |
| `KV_ID` | KV namespace id |
| `QUEUE_NAME` / `BILLING_QUEUE_NAME` | Usage-aggregation / billing queue names |

**② Runtime values** (rendered into `wrangler.toml` `[vars]`):

| Key | Description |
| --- | --- |
| `BETTER_AUTH_URL` | Full platform URL (e.g. `https://platform.example.com`) — **required**; without it the admin console redirects to localhost |
| `GITHUB_CLIENT_ID` / `GITHUB_ALLOWED_EMAILS` | Optional — fill in only when GitHub sign-in is enabled (the callback URL must equal `https://<your-domain>/api/auth/callback/github`; an empty email whitelist = all logins rejected) |
| `API_KEY_PREFIX` / `REQUEST_LOG_RETENTION_DAYS` | Gateway key prefix (default `sk-`) / request-log retention in days |
| `CACHE_ENABLED`, `EMAIL_VERIFICATION_ENABLED` and other policy switches | All have safe defaults (default = off); leave empty and enable as needed |

**③ Real secrets** (must **never** enter a file or the repo; write them per key on the deploy side with `wrangler secret put`):

- `BETTER_AUTH_SECRET`, `GATEWAY_SECRET_KEY` — both required (the latter encrypts upstream vendor keys; generate independent random values, they must differ)
- `GITHUB_CLIENT_SECRET` — only needed when GitHub sign-in is enabled

Authoritative comments for each key live in `.dev.vars.example`; the full three-category rules and complete key list are in [CLAUDE.md](CLAUDE.md) §环境与配置.

## Integration examples

Official SDKs need only two changes: point the base URL at the gateway, and use a key created in the gateway:

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "sk-…",                          // gateway API key
  baseURL: "https://<gateway>/v1",         // only this line changes
});

const completion = await openai.chat.completions.create({
  model: "gpt-…",                          // any model configured in the gateway
  messages: [{ role: "user", content: "hi" }],
});
```

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: "sk-…",                          // gateway API key
  baseURL: "https://<gateway>/anthropic",  // only this line changes
});

const message = await anthropic.messages.create({
  model: "claude-…",                       // any model configured in the gateway
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
});
```

Both authentication headers (`Authorization: Bearer` and Anthropic's native `x-api-key`) are accepted by the gateway. See [CLAUDE.md](CLAUDE.md) for full protocols and endpoints.

## Run locally

**Requirements**: Node.js ≥ 20 and npm; no Cloudflare account is needed for local development.

Four steps to start:

```bash
git clone <your-repo-url> cf-ai-gateway
cd cf-ai-gateway
npm install

# 1. Create local config from the committed template (gitignored)
cp .dev.vars.example .dev.vars   # fill in local values — see CLAUDE.md §环境与配置

# 2. Render wrangler.toml (generated file, never edit by hand)
npm run render:config

# 3. Prepare the local database
npm run db:migrate     # apply migrations
npm run db:seed        # seed the default model price table (idempotent)

# 4. Start the dev server
npm run dev            # http://localhost:5173
```

`npm run dev` requires `.dev.vars` to exist in order to start; GitHub OAuth is optional — the gateway runs without configuring it.

**Where the first account comes from**: email/password registration requires an invite code, and the first admin has no code-issuing entry point yet — two options for local setup:

- **Seed accounts (recommended, fastest)**: set `SEED_USERS` in `.dev.vars` (format documented in the comments in `.dev.vars.example`, local use only), keep `npm run dev` running, then run `npm run seed:users` in another terminal — this creates test accounts including an admin.
- **GitHub OAuth**: configure the GitHub app credentials and email whitelist in `.dev.vars`, sign in, then promote yourself to admin:

  ```bash
  npx wrangler d1 execute cf-ai-gateway-db --local \
    --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
  ```

Once an admin is signed in, they can generate invite links in the admin console; members open a link and register with email and password.

## Self-hosting and technical docs

- **Deployment essentials** (commands for both environments, the `--config` warning, the from-scratch checklist) → [CLAUDE.md](CLAUDE.md) (Chinese) §部署要点
- **API reference / common commands / tests & acceptance / project structure** → [CLAUDE.md](CLAUDE.md) (Chinese)

Live environments: staging `https://stg-platform.lmlh.net` (public API `https://stg-api.lmlh.net`) and production `https://platform.lmlh.net` (public API `https://api.lmlh.net`); the legacy domains remain as forwarding sources.

## License

MIT, see [LICENSE](LICENSE).
