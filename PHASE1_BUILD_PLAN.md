# Phase 1 Build Plan — Inbound Freight Tool

**Status:** Draft v2
**Last updated:** 2026-07-27
**Depends on:** `REQUIREMENTS.md` (Phase 1 functional requirements, FR-1.x through FR-5.x, plus FR-6.1 pulled forward from Phase 3)

This document scopes the actual Phase 1 build: architecture, data model, component breakdown, and implementation order. It does not cover Phase 2 (live carrier APIs) or Phase 3 (Acumatica) beyond making sure Phase 1 doesn't block them.

---

## 1. Architecture

**Confirmed:** Cloudflare Workers + D1.

- A single Cloudflare Worker serves both the frontend (static assets) and the backend API routes — no separate server to manage.
- **D1** (SQL) is the persistence layer: shipments, rate quotes, booking decisions, freight-class config, and user accounts all live there. This replaces the current proof-of-concept's in-browser-only state (required by FR-5.2).
- The **Anthropic API key moves server-side**, called from Worker code with the key stored as a Worker secret. The current proof-of-concept widget calls the Claude API directly from the browser, which would expose the key — that pattern is not carried into Phase 1.
- Carrier rate calculation (dimensional weight, freight class multiplier, zone table) runs as plain Worker logic, ported from the existing `inbound-routing` skill's JS — no external calls yet, since this is still the simulated/estimated rate phase.

```
Browser (shipping manager) ──HTTPS──> Cloudflare Worker
                                         ├─ static frontend (queue UI, results, config, login)
                                         ├─ /api/* routes (auth, shipments, rating, config, metrics)
                                         ├─ Anthropic API call (server-side, key as Worker secret)
                                         └─ D1 database (users, shipments, quotes, config, sessions)
```

## 2. Access & Auth

Phase 1 needs to support the shipping manager plus a small number of other staff (confirmed), not just one user. Proposed approach, simple by design since this is a handful of known internal users:

- Accounts are created manually in D1 by IT/Systems Admin (no self-service signup).
- Username + password login; passwords hashed (e.g. via Workers-compatible bcrypt/argon2 library or Web Crypto PBKDF2) — never stored in plaintext.
- Session identified by a signed, HTTP-only cookie; session record (or a signed token) validated on each API request.
- No role differentiation planned for Phase 1 (all logged-in users can do everything) — revisit if Purchasing/AP need view-only access later.

*(Flagged as an assumption to confirm with IT before build: is there an existing internal auth pattern for other Wigwam internal tools — e.g. Cloudflare Access / Zero Trust — that this should follow instead of a bespoke login?)*

## 3. Data Model (D1 schema, initial)

**`users`**
| column | type | notes |
|---|---|---|
| id | integer PK | |
| name | text | |
| email | text unique | |
| password_hash | text | |
| created_at | text (ISO) | |

**`freight_class_defaults`** (FR-2.2 — owned by this tool)
| column | type | notes |
|---|---|---|
| material | text PK | e.g. "wool yarn" |
| freight_class | real | e.g. 60 |
| updated_by | integer FK → users | |
| updated_at | text | |

**`shipments`**
| column | type | notes |
|---|---|---|
| id | integer PK | |
| status | text | queued / extracting / rated / booked / needs_review |
| raw_input | text | pasted email or PDF text, as submitted |
| material | text | |
| freight_class | real | |
| weight_lbs | real | |
| pieces | integer | |
| length_in / width_in / height_in | real | |
| hazmat | integer (bool) | |
| origin_address | text | |
| destination_address | text | default Sheboygan, editable per FR-1.5 |
| ready_date | text | |
| extraction_method | text | "ai" or "regex_fallback" |
| extraction_flagged_fields | text (JSON) | fields the extractor couldn't confidently fill |
| created_by | integer FK → users | |
| created_at | text | |

**`carrier_quotes`**
| column | type | notes |
|---|---|---|
| id | integer PK | |
| shipment_id | integer FK → shipments | |
| carrier | text | |
| price | real | |
| transit_estimate | text (nullable) | |
| is_best | integer (bool) | |
| created_at | text | |

**`booking_decisions`**
| column | type | notes |
|---|---|---|
| id | integer PK | |
| shipment_id | integer FK → shipments | |
| chosen_quote_id | integer FK → carrier_quotes | |
| booked_by | integer FK → users | |
| booked_at | text | |
| exported | integer (bool) | whether a quote/confirmation was exported |

**Update (2026-07-27): pulled forward from Phase 3.** `po_number_raw`, `po_number_matched`, `po_line_id`, `po_reconciliation_status`, and `po_match_data` (JSON snapshot of the matched Acumatica PO/line, added beyond the original plan so the review UI doesn't need a live Acumatica call per render) were added to `shipments` in migration `0003_po_matching.sql` and are live in the build (see `src/acumatica.ts`, FR-6.1). `po_reconciliation_status` values: `not_applicable` (default), `pending_review`, `confirmed`, `unmatched`.

Real Acumatica data pulled during design (sample PO `P000513`, vendor North Carolina Spinning Mills Inc):
- PO numbers are `P` + 6-digit zero-padded sequence (`normalizePoNumber()` in `src/acumatica.ts` extracts this pattern from free text per FR-6.1a).
- `VendorClass = "YARN"` reliably distinguishes raw-material yarn vendors from other vendor types (e.g. `MACHPART`) — not used in the matching code itself (matching is PO-number-driven, not vendor-driven, per FR-6.1) but useful context for anyone validating matches.
- Real yarn inventory items are specific construction/blend/color codes (e.g. `Y5750-057` = "20/1 50Cot/50Poly 057 Charcoal"), not generic Wool/Synthetic/Cotton buckets — confirms material should come from the matched PO line, not the AI's guess from email text, once a match is confirmed.
- Freight class (NMFC) is not tracked anywhere in Acumatica — reconfirms FR-2.2 (freight-class defaults stay owned by this tool).

Acumatica write-back (FR-6.2) is still Phase 3 — this build only reads PO/vendor/item data for matching.

**`locks`** (added 2026-07-27, migration `0004_locks.sql`)
| column | type | notes |
|---|---|---|
| name | text PK | e.g. `batch_operations` |
| acquired_at | text | |
| acquired_by | integer FK → users | |

Serializes `rate-batch`/`book-all`/`export-all` (see `src/locks.ts`) since all three read/write overlapping shipment, quote, and booking rows and would otherwise race if two users triggered them at the same time. A stuck row (holder crashed before release) is cleared via `POST /api/admin/reset-lock`, a token-gated endpoint — see section 4 and `README.md` "Clearing a stuck batch-operations lock". This is the escape hatch called for in the Operability NFR (REQUIREMENTS.md section 9): no lock should ever require a redeploy to clear.

**Update (2026-07-27): FR-5.3 actuals + landed cost.** `shipments` gained `actual_carrier`, `actual_charge`, `actual_mode`, `actual_transit_days` (migration `0005_actuals_and_settings.sql`) — captured inline via the existing PATCH-based field-edit UI, same pattern as extracted fields, no new entry screen. The same migration adds a singleton `settings` table:

**`settings`**
| column | type | notes |
|---|---|---|
| id | integer PK (CHECK id=1) | singleton row |
| charge_variance_threshold_pct | real | default 5; shipping-manager-configurable via `/api/config/settings` (FR-5.3b) — deliberately not hardcoded |
| updated_by | integer FK → users | |
| updated_at | text | |

Landed cost (FR-6.6) needed one addition to the Acumatica client: `MatchedPoLine` (`src/acumatica.ts`) now also captures `unitCost`/`extendedCost` off each PO line (previously omitted — the real `P000513` PO fetched during design had `UnitCost: 5.68`, `ExtendedCost: 17040`, but the mapping only pulled `inventoryId`/`lineDescription`/`orderQty`/`uom`). Since `po_match_data` already persists the full matched-PO snapshot per shipment, this cost data is available for landed-cost calculation with no extra Acumatica call.

## 4. API Routes (Worker)

| Route | Method | Purpose |
|---|---|---|
| `/api/login` | POST | Authenticate, set session cookie |
| `/api/logout` | POST | Clear session |
| `/api/shipments` | POST | Create a shipment from pasted text/PDF; triggers AI extraction (FR-1.1–1.4) |
| `/api/shipments` | GET | List/history, with filters (status, date range) (FR-5.2) |
| `/api/shipments/:id` | PATCH | Manual correction of extracted fields (FR-1.4) |
| `/api/shipments/rate-batch` | POST | Run rate calculation concurrently for all queued shipment IDs (FR-3.1–3.2) |
| `/api/shipments/:id/book` | POST | Record chosen carrier/rate as booked (FR-4.1) |
| `/api/shipments/:id/export` | GET | Export quote/confirmation (FR-4.2) |
| `/api/shipments/book-all` / `/export-all` | POST | Batch actions (FR-4.3) |
| `/api/config/freight-classes` | GET/PUT | View/edit freight-class default table (FR-2.2) |
| `/api/metrics` | GET | Processed count, total booked cost, savings vs. highest quote (FR-5.1) |
| `/api/shipments/:id/po-lookup` | POST | Look up a (typed or extracted) PO number against Acumatica; stores a pending match for review (FR-6.1, FR-6.1a) |
| `/api/shipments/:id/po-confirm` | POST | Shipping manager confirms a specific matched PO line; pulls that line's material into the shipment (FR-6.1b) |
| `/api/shipments/:id/po-flag-unmatched` | POST | Proceed unlinked, flag for Shipping/Purchasing reconciliation (FR-6.1d) |
| `/api/admin/reset-lock` | POST | Clear a stuck `locks` row (all, or one by `lockName`); gated by the `x-admin-token` header matching `ADMIN_RESET_TOKEN`, not session auth |
| `/api/config/settings` | GET/PUT | View/edit the charge-variance threshold percentage (FR-5.3b) |
| `/api/landed-cost` | GET | Landed cost aggregated per matched PO line: material cost + freight-to-date, finalized once qty shipped ≥ ordered and every linked shipment has an actual charge (FR-6.6) |

## 5. Frontend Components

- **Login page** — simple username/password form.
- **Destination bar** — persistent, pre-filled Sheboygan address, editable (FR-1.5), carried over from the PoC.
- **Shipment queue** — add via paste/upload, sample material buttons, per-shipment status (Queued → Extracting → Rated → Booked), matches PoC UX (FR-1.6).
- **Extraction review panel** — shows extracted fields per shipment with inline correction before rating (FR-1.4), flags any fields the AI/regex couldn't fill.
- **Rate results view** — sorted carrier list, best-rate highlight, book/export actions per shipment and batch-wide (FR-3.4, FR-4.x), ported visually from the PoC.
- **Freight-class config page** — simple editable table for FR-2.2, restricted to logged-in users (no separate admin role in Phase 1).
- **Metrics/history dashboard** — batch metrics plus a parallel-run comparison view (tool estimate vs. manual-process actual) so the shipping manager can judge readiness to exit the parallel run (FR-5.3, section 5.1 of REQUIREMENTS.md).

## 6. Milestones

1. ✅ **Foundation** — D1 schema + migrations, Worker skeleton, login/session, deploy pipeline. Deployed to `https://inbound-freight-tool.cchesebro.workers.dev`.
2. ✅ **Intake & extraction** — paste/upload → server-side Claude API extraction (Haiku 4.5) → regex fallback → correction UI (FR-1.x). Correction UI is inline edit/save on each shipment card.
3. ✅ **Freight class config + rate engine** — rate engine (zone map, freight-class multiplier, dimensional weight) is done and running (FR-3.x). Config page UI for FR-2.2 is built: a "Freight classes" panel (toggle button in the batch-actions bar) listing the table with inline edit + an add/update row, backed by the existing `/api/config/freight-classes` API.
4. ✅ **Booking, export, batch actions** — book/export per shipment and batch-wide (FR-4.x): quote table with best-rate highlight, per-shipment Book/Export, batch Book all/Export all (combined text download).
5. ✅ **Reporting** — a "Metrics" panel (toggle button next to Freight classes) is built: stat tiles (shipments processed, total booked cost, savings vs. highest quote per FR-5.1) plus a compact history table (id/material/status/carrier/rate/added) sourced from the same shipment list already loaded for the queue (FR-5.2). FR-5.3 is now built: actual-outcome fields (carrier/charge/mode/transit days) editable inline on each shipment card, a charge-variance badge against the booked/best quote using a shipping-manager-configurable threshold (FR-5.3b), and a "Landed cost by PO line" table aggregating material cost + freight-to-date per matched Acumatica PO line (FR-6.6, pulled forward alongside this since it builds directly on FR-6.1's PO/line matching). Still open: the actual LTL-vs-Truckload threshold used to validate/eventually auto-decide `actual_mode` (see section 8).
6. **Multi-user rollout** — add remaining users' accounts, confirm auth approach with IT, begin the Phase 1 parallel run.
7. ⏳ **PO matching (pulled forward from Phase 3, FR-6.1)** — code complete (`src/acumatica.ts`, PO-related routes, UI lookup/confirm/flag panel), blocked on IT provisioning the four `ACUMATICA_*` secrets (see `README.md`). Acumatica write-back (FR-6.2) remains out of scope until Phase 3.
8. ✅ **Operational hardening** — batch-operations lock (`src/locks.ts`, migration `0004_locks.sql`) serializing rate-batch/book-all/export-all, with a token-gated `/api/admin/reset-lock` escape hatch; explicit timeouts added to every outbound `fetch()` (Anthropic in `src/extraction.ts`, Acumatica in `src/acumatica.ts`). Satisfies the Operability/Reliability NFRs added to REQUIREMENTS.md section 9.

## 7. Explicitly Out of Scope for Phase 1

- Live carrier rating/booking APIs (Phase 2).
- Acumatica write-back (FR-6.2, still Phase 3) — PO/vendor/item **read** access for matching (FR-6.1) was pulled forward; see milestone 7.
- Role-based permissions beyond a single access level.

## 8. Open Items

- Confirm whether Wigwam already has a standard auth pattern for internal Cloudflare-hosted tools (e.g. Cloudflare Access) that should replace the bespoke username/password login proposed in section 2.
- Confirm the initial list of users who need Phase 1 access beyond the shipping manager.
- Confirm Worker/D1 naming and which Cloudflare account/environment this should deploy under.
- **Phase 2 (Estes Express) groundwork, 2026-07-27:** reviewed the full Estes Cloud API OpenAPI spec (v1.26.30) ahead of getting real account access. Key findings, not yet built: auth needs both a provisioned `apikey` header (one-time via `POST /v1/api-key`, Basic auth) and a per-session bearer JWT (`POST /authenticate`, Basic auth); `POST /v1/rate-quotes` maps directly onto our shipment fields (weight/dims/class/hazmat/origin/destination) and returns `totalCharges`/`transitDays`; booking is two separate calls — `POST /v1/bol` tenders the shipment for a PRO number, then `POST /v1/pickup-requests` schedules the actual truck; `GET /v1/shipments/history` supports lookup by PRO **or by PO number**, which could reuse the same PO number captured for Acumatica matching (FR-6.1). Open questions before writing code: Wigwam's Estes account number, payor/terms convention (prepaid/collect, shipper/consignee/third-party), and whether handling-unit type needs a new shipment field. Each additional Phase 2 carrier (SAIA, Old Dominion, R+L) will need the same spec-review exercise once their docs are available.
- **LTL vs. Truckload threshold:** The manual process decided mode via a simple, calculable rule (per the shipping manager), but the exact cutoff (weight, pallet count, or otherwise) hasn't been confirmed. `actual_mode` (FR-5.3a) is currently freeform-recorded only; `src/rating.ts` doesn't branch on mode at all yet.

## 9. Status

- D1 database provisioned (`inbound-freight-tool-db`) and migrations 0001/0002 applied in the Wigwam Cloudflare account.
- `ANTHROPIC_API_KEY` and `SESSION_SECRET` set as Worker secrets — extraction (FR-1.1/1.2) runs against Claude Haiku 4.5.
- Deployed and live at `https://inbound-freight-tool.cchesebro.workers.dev`. First user created; login confirmed working.
- End-to-end loop confirmed working: intake → AI extraction → inline correction → batch rate shopping → per-shipment/batch booking → single/combined quote export.
- Freight-class config page UI (FR-2.2) is now built (see milestone 3).
- Metrics/history dashboard UI (FR-5.1/5.2/5.3) is now built (see milestone 5): stat tiles, compact history table, actual-outcome fields + charge-variance badge, and a landed-cost-by-PO-line table (FR-6.6), behind a "Metrics" toggle and inline shipment-card fields. Migration `0005_actuals_and_settings.sql` added the `actual_*` shipment columns and the `settings` table. Still open: the LTL-vs-Truckload threshold (section 8).
- PO matching (FR-6.1) pulled forward from Phase 3: migration `0003_po_matching.sql` and PO-lookup/confirm/flag routes + UI are built (see milestone 7). Blocked on IT provisioning `ACUMATICA_BASE_URL`, `ACUMATICA_ENDPOINT_VERSION`, `ACUMATICA_CLIENT_ID`, `ACUMATICA_CLIENT_SECRET` as Worker secrets — flagged as a setup blocker, same pattern as `ANTHROPIC_API_KEY`.
- Operational hardening (see milestone 8) is live: migration `0004_locks.sql`, `src/locks.ts`, `/api/admin/reset-lock`, and outbound-fetch timeouts. Requires `ADMIN_RESET_TOKEN` as a new Worker secret (see `README.md` "Clearing a stuck batch-operations lock") before the reset endpoint can be used — flagged as a setup item, though its absence only blocks the reset endpoint, not normal app operation.
