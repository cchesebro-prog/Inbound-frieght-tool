# Inbound Freight Tool

Internal tool for automating Wigwam Mills' inbound raw-material freight quoting and, in later phases, booking.

- `REQUIREMENTS.md` — product requirements and phased roadmap (Phase 1 → 2 → 3).
- `PHASE1_BUILD_PLAN.md` — technical scope for the current Phase 1 build (architecture, data model, API routes, milestones).

This is the Phase 1 scaffold: a Cloudflare Worker (Hono) with a D1 database, server-side Claude API extraction, and estimated (not live) carrier rate calculation. See `PHASE1_BUILD_PLAN.md` for what's in and out of scope.

## Stack

- [Hono](https://hono.dev) on Cloudflare Workers
- Cloudflare D1 for persistence
- Anthropic Claude API for shipment-detail extraction (server-side only — the key is a Worker secret, never exposed to the browser)
- Plain HTML/JS frontend in `public/` (no build step)

## Local setup

```bash
npm install

# Create the D1 database once (real command, run from your own Cloudflare account):
npx wrangler d1 create inbound-freight-tool-db
# Copy the returned database_id into wrangler.toml

# Apply migrations locally:
npm run db:migrate:local

# Secrets used by the Worker (never commit these):
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SESSION_SECRET

# Run locally. Login sets a `Secure` cookie, so use https for local testing:
npx wrangler dev --local-protocol https
```

There's no signup flow by design (see `PHASE1_BUILD_PLAN.md` section 2) — accounts are inserted directly into D1. First, generate a password hash locally (this never sends your password anywhere, including to this repo — it just prints a salted hash to your terminal):

```bash
node scripts/hash-password.mjs "your password"
```

Then insert the user against the **local** D1 (for `wrangler dev` testing):

```bash
npx wrangler d1 execute inbound-freight-tool-db --local --command \
  "INSERT INTO users (name, email, password_hash) VALUES ('Your Name', 'you@wigwam.com', '<hash from above>')"
```

## Deploying

```bash
npm run db:migrate:remote
npm run deploy
```

After the first deploy, create your first real user against the **remote** D1 (drop `--local`) so you can actually log in to the deployed Worker:

```bash
npx wrangler d1 execute inbound-freight-tool-db --remote --command \
  "INSERT INTO users (name, email, password_hash) VALUES ('Your Name', 'you@wigwam.com', '<hash from scripts/hash-password.mjs>')"
```

## What's not built yet

- Live carrier rating APIs (Phase 2) — rates are estimated using the freight-class/zone logic in `src/rating.ts`.
- Acumatica integration (Phase 3) — no PO matching or ERP write-back yet; the `shipments` table intentionally leaves room for the future PO columns.
- Full UI polish — `public/index.html` is a functional but minimal shell (login, add shipment, rate all, list) to prove out the API end-to-end; the richer batch/results UI described in `PHASE1_BUILD_PLAN.md` section 5 is still to be built out.
