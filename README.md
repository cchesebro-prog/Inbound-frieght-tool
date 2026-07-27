# Inbound Freight Tool

Internal tool for automating Wigwam Mills' inbound raw-material freight quoting and, in later phases, booking.

- `REQUIREMENTS.md` — product requirements and phased roadmap (Phase 1 → 2 → 3).
- `PHASE1_BUILD_PLAN.md` — technical scope for the current Phase 1 build (architecture, data model, API routes, milestones).

This is the Phase 1 scaffold: a Cloudflare Worker (Hono) with a D1 database, server-side Claude API extraction, and estimated (not live) carrier rate calculation. See `PHASE1_BUILD_PLAN.md` for what's in and out of scope.

## ⚠ Setup blocker: Anthropic API key

There is no Anthropic API key provisioned yet for this tool. Without one, `ANTHROPIC_API_KEY` can't be set (see Local setup below) and shipment extraction (FR-1.1/FR-1.2) will always fall through to the much cruder regex fallback (FR-1.3) instead of actually doing AI extraction. Getting a key — and deciding who owns/pays for it — needs to happen before Phase 1 can be meaningfully tested or used for real, though the rest of the flow (manual field entry, rate shopping, booking) can still be exercised without it.

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

# Secrets used by the Worker (never commit these).
# ANTHROPIC_API_KEY is currently a setup blocker — see the note above.
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SESSION_SECRET

# Run locally. Login sets a `Secure` cookie, so use https for local testing:
npx wrangler dev --local-protocol https
```

Create your first user directly against the local D1 database (there's no signup flow by design — see `PHASE1_BUILD_PLAN.md` section 2):

```bash
npx wrangler d1 execute inbound-freight-tool-db --local --command \
  "INSERT INTO users (name, email, password_hash) VALUES ('Your Name', 'you@wigwam.com', '<hash>')"
```

Generate a password hash with the `hashPassword` helper in `src/auth.ts` (e.g. via a one-off local script) — it uses PBKDF2 and is not a plain string you can type by hand.

## Deploying

```bash
npm run db:migrate:remote
npm run deploy
```

## What's not built yet

- Live carrier rating APIs (Phase 2) — rates are estimated using the freight-class/zone logic in `src/rating.ts`.
- Acumatica integration (Phase 3) — no PO matching or ERP write-back yet; the `shipments` table intentionally leaves room for the future PO columns.
- Full UI polish — `public/index.html` is a functional but minimal shell (login, add shipment, rate all, list) to prove out the API end-to-end; the richer batch/results UI described in `PHASE1_BUILD_PLAN.md` section 5 is still to be built out.
