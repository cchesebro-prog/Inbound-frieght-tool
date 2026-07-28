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

## Acumatica setup (FR-6.1 PO matching)

PO matching was pulled forward from Phase 3 into active Phase 1 work. The Worker calls Acumatica directly (OAuth 2.0 client-credentials grant against the standard Acumatica contract-based REST API), which needs four secrets **not yet set**:

```bash
npx wrangler secret put ACUMATICA_BASE_URL        # e.g. https://acm.wigwam.com (site root, no path)
npx wrangler secret put ACUMATICA_ENDPOINT_VERSION # the contract-based endpoint version published for this instance, e.g. 24.200.001
npx wrangler secret put ACUMATICA_CLIENT_ID
npx wrangler secret put ACUMATICA_CLIENT_SECRET
```

**Setup blocker:** IT needs to register (or confirm) an OAuth 2.0 client-credentials client against the Wigwam Acumatica 2025R2 instance for this Worker, and confirm which contract-based endpoint version is published — this repo does not assume either already exists. Until these are set, `/api/shipments/:id/po-lookup` will fail with a 502 (`Acumatica auth failed`); everything else in the app works without them.

Until this is wired up, `po_number_raw` can still be captured (typed or AI-extracted from the email) and corrected like any other field — only the live lookup/match step depends on these secrets.

## Clearing a stuck batch-operations lock

`rate-batch`, `book-all`, and `export-all` all read/write overlapping shipment and quote rows, so they share one serialization lock (`src/locks.ts`) — at most one of them runs at a time. If a request holding the lock dies before releasing it (a crash, a timeout, a Worker eviction), the lock is stuck and every batch action starts failing with 409 "already in progress" — normally you'd need to redeploy to reset in-memory state, but this lock lives in D1, so a real reset endpoint works instead:

```bash
npx wrangler secret put ADMIN_RESET_TOKEN   # any long random value, e.g. `openssl rand -hex 32`

curl -X POST https://inbound-freight-tool.cchesebro.workers.dev/api/admin/reset-lock \
  -H "x-admin-token: <the ADMIN_RESET_TOKEN value>"
```

This clears all locks (or pass `{"lockName": "batch_operations"}` as the body to target one specifically — there's currently only the one). It intentionally does not require a logged-in session, since the point is to recover when normal app flow is broken.

## What's built

- Login, shipment intake (paste or sample-email buttons), AI extraction with inline correction, batch rate shopping, per-shipment and batch-wide booking, and quote export (single shipment or all as one combined text file).
- PO-number-driven Acumatica matching (FR-6.1): extract/enter a PO number, look it up, manually confirm the matching PO line (pulls the real Acumatica item description into `material`), or flag as unmatched for Shipping/Purchasing reconciliation — pending the Acumatica secrets above.
- Freight-class config page (FR-2.2): a "Freight classes" panel (toggle button next to the batch actions) to view, edit, and add material/freight-class defaults, backed by `/api/config/freight-classes`.
- A D1-backed serialization lock for the batch endpoints (rate-batch/book-all/export-all), with a token-gated reset endpoint (see "Clearing a stuck batch-operations lock" above) so a stuck lock never requires a redeploy. Every outbound `fetch()` (Anthropic, Acumatica) now has an explicit timeout so a slow/unresponsive external service can't hang a request indefinitely.
- Metrics/history dashboard (FR-5.1/5.2/5.3): a "Metrics" panel (toggle button next to Freight classes) with stat tiles (shipments processed, total booked cost, savings vs. highest quote), a compact history table, a shipping-manager-configurable charge-variance threshold, and a landed-cost-by-PO-line table. Each shipment card also has inline "actual outcome" fields (actual carrier, charge, mode, transit days) filled in once the manual process completes, with a variance badge if the actual charge diverges from the quote beyond the threshold.
- Landed cost (FR-6.6): once a shipment is matched to an Acumatica PO/line (FR-6.1) and its actual charge is recorded, the Metrics panel aggregates material cost + freight-to-date per PO line, finalizing once every shipment against that line has arrived and been charge-reconciled.

## What's not built yet

- Live carrier rating APIs (Phase 2) — rates are estimated using the freight-class/zone logic in `src/rating.ts`. Estes Express's Cloud API has been reviewed ahead of getting real access (rate-quotes, BOL/booking, pickup requests, tracking), but no integration code exists yet — see `PHASE1_BUILD_PLAN.md` section 8 open items.
- Acumatica write-back (still Phase 3, per FR-6.2) — this build only reads PO/vendor/item data for matching; it never writes to Acumatica.
- The actual LTL-vs-Truckload threshold — `actual_mode` is currently a manually-recorded field only; `src/rating.ts` doesn't branch on mode at all yet.
- Visual polish — functional but plain; no design pass yet.
