# Phase 1 Build Plan — Inbound Freight Tool

**Status:** Draft v1
**Last updated:** 2026-07-24
**Depends on:** `REQUIREMENTS.md` (Phase 1 functional requirements, FR-1.x through FR-5.x)

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

Phase 3 will add `po_number_raw`, `po_number_matched`, `po_line_id`, and `po_reconciliation_status` to `shipments` per FR-6.x — not built now, but the schema should leave room for these as additive columns rather than requiring a redesign.

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
| `/api/metrics` | GET | Daily/batch metrics, parallel-run comparison data (FR-5.1, FR-5.3) |

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
3. **Freight class config + rate engine** — rate engine (zone map, freight-class multiplier, dimensional weight) is done and running (FR-3.x). Config **API** exists (`/api/config/freight-classes`); the config **page** UI for FR-2.2 is not built yet.
4. ✅ **Booking, export, batch actions** — book/export per shipment and batch-wide (FR-4.x): quote table with best-rate highlight, per-shipment Book/Export, batch Book all/Export all (combined text download).
5. **Reporting** — `/api/metrics` exists; metrics bar, history view, and parallel-run comparison UI (FR-5.x) not built yet.
6. **Multi-user rollout** — add remaining users' accounts, confirm auth approach with IT, begin the Phase 1 parallel run.

## 7. Explicitly Out of Scope for Phase 1

- Live carrier rating/booking APIs (Phase 2).
- Any Acumatica read/write (Phase 3) — schema leaves room for it (section 3) but no integration code is written now.
- Role-based permissions beyond a single access level.

## 8. Open Items

- Confirm whether Wigwam already has a standard auth pattern for internal Cloudflare-hosted tools (e.g. Cloudflare Access) that should replace the bespoke username/password login proposed in section 2.
- Confirm the initial list of users who need Phase 1 access beyond the shipping manager.
- Confirm Worker/D1 naming and which Cloudflare account/environment this should deploy under.

## 9. Status

- D1 database provisioned (`inbound-freight-tool-db`) and migrations 0001/0002 applied in the Wigwam Cloudflare account.
- `ANTHROPIC_API_KEY` and `SESSION_SECRET` set as Worker secrets — extraction (FR-1.1/1.2) runs against Claude Haiku 4.5.
- Deployed and live at `https://inbound-freight-tool.cchesebro.workers.dev`. First user created; login confirmed working.
- End-to-end loop confirmed working: intake → AI extraction → inline correction → batch rate shopping → per-shipment/batch booking → single/combined quote export.
- Not yet built: freight-class config page UI (FR-2.2), metrics/history dashboard UI (FR-5.x). Both have working APIs already.
