# Inbound Freight Tool — Requirements

**Status:** Draft v5
**Owner:** Shipping / Logistics (Wigwam Mills)
**Business owner (Phase 2/3 sign-off):** Chris Chesebro
**Last updated:** 2026-07-24
**Scope of this document:** Inbound raw-material transportation management only. Outbound (customer/DTC) shipping is explicitly out of scope for this phase and will be defined as a separate project once inbound is in production.

---

## 1. Background & Problem Statement

Wigwam Mills receives 50+ inbound raw-material shipments per week from yarn and fiber suppliers (wool, synthetic/polyester, cotton). Today the process is manual:

1. Supplier sends shipment details by email or PDF (weight, dimensions, pallet count, origin, ready date).
2. The shipping manager reads each message and manually extracts the shipment fields.
3. The shipping manager manually requests/looks up rates across multiple carriers.
4. The shipping manager picks a carrier and books the shipment.

This takes an estimated 4–6 minutes per shipment and does not scale well as volume grows or when the shipping manager is out. There is no system of record for inbound freight decisions, no consistent way to compare carrier rates, and no tie-back to the purchase order or the ERP.

This effort formalizes and extends the existing `inbound-routing` proof-of-concept (an AI-assisted email-extraction + rate-shopping widget) into a supported internal tool.

## 2. Goals

- Reduce manual time spent per inbound shipment from ~5 minutes to under 1 minute of manager review/approval time.
- Standardize freight class, carrier, and rate decisions so results are consistent regardless of who processes the shipment.
- Give visibility into inbound freight spend and carrier performance over time (something that doesn't exist today).
- Reduce the number of manually mis-keyed shipment fields (weight, class, dimensions) that lead to rate/billing surprises.
- Lay a foundation that can later connect to live carrier rates and to Acumatica, without requiring a rebuild.

### Non-goals (for this phase)

- Outbound / customer shipment routing.
- Replacing Acumatica as the system of record — this tool assists the shipping manager and, in later phases, writes results back to Acumatica; it does not replace PO or AP workflows.
- Carrier contract negotiation or rate management (rates are shopped, not negotiated, by this tool).

## 3. Users & Stakeholders

| Role | Interaction |
|---|---|
| Shipping Manager (primary user) | Adds/reviews shipments, reviews extracted data, selects/books carrier rates |
| Purchasing | Source of the original PO; wants shipment status tied back to the PO |
| Accounts Payable / Finance | Wants freight cost to reconcile against vendor bills in Acumatica |
| IT / Systems Admin | Owns integration with Acumatica and any carrier API credentials |
| Business owner (Chris Chesebro) | Signs off on Phase 2 (live rates/booking) and Phase 3 (Acumatica write-back) before each goes live |

## 4. Current State (Phase 0 — proof of concept)

The existing `inbound-routing` skill/widget already establishes:

- Fixed destination: 5300 WI-42, Sheboygan, WI 53083 (single facility).
- Primary materials and freight classes: wool yarn (class 60), synthetic/polyester yarn (class 60), cotton yarn (class 55).
- Batch queue model — shipments are added to a queue and rate-shopped together, not one at a time.
- AI extraction of shipment fields from pasted supplier emails via the Claude API, with a regex fallback if extraction fails.
- Simulated rate calculation across six carriers (XPO, Old Dominion, SAIA, Estes, R+L, UPS Freight) using dimensional weight, freight class multipliers, and an origin-state-to-Wisconsin zone table.
- A results view that highlights the best (lowest) rate and shows batch-level cost/savings metrics.

This proof of concept validates the workflow but uses simulated rates and has no connection to real carrier pricing, no persistence beyond a session, and no tie-in to Acumatica.

**Carrier API status (confirmed):** No carrier rating/booking API credentials exist today for UPS, FedEx, or XPO (or any other carrier). Phase 1 must run on simulated/estimated rates; setting up real API access is a prerequisite for Phase 2, not something already available to build against.

## 5. Scope & Phased Roadmap

| Phase | Description | Rate source | ERP integration |
|---|---|---|---|
| **Phase 1** | Formalize the current proof of concept into a supported tool: AI extraction from pasted/forwarded supplier emails, freight-class assignment, simulated/estimated rate shopping, manual booking decision | Simulated (rules-based estimate) | None |
| **Phase 2** | Connect real carrier rating APIs for live, bookable rates | Live carrier APIs (negotiated + LTL market) | None |
| **Phase 3** | Automate intake (monitor a shared mailbox instead of manual paste), match shipments to open POs, write shipment/receipt data back to Acumatica | Live carrier APIs | Acumatica 2025R2 |

This document defines requirements primarily for **Phase 1**, with Phase 2/3 requirements captured so the Phase 1 design doesn't foreclose them.

**Update (2026-07-27):** FR-6.1 (PO-number-driven matching, section 6.6) has been pulled forward from Phase 3 into active Phase 1 work — see section 11 for why and `PHASE1_BUILD_PLAN.md` for the build status. FR-6.2 (Acumatica write-back) remains Phase 3.

### 5.1 Rollout approach (confirmed)

Phase 1 launches as a **parallel run**: the shipping manager keeps doing the current manual process as the system of record while using the tool alongside it, so extraction accuracy and estimated rates can be validated against real outcomes before the tool becomes primary. There is no fixed time-box or accuracy threshold for ending the parallel run — it ends when the shipping manager, as the primary user, judges the tool trustworthy enough to rely on. Reporting (FR-5.3) should give them what they need to make that call, not enforce a rule on their behalf.

## 6. Functional Requirements

### 6.1 Shipment intake
- FR-1.1: User can add a shipment by pasting supplier email text or uploading a PDF.
- FR-1.2: System extracts: material, freight class, weight (lbs), piece/pallet count, dimensions (L/W/H), hazmat flag, origin address, ready date.
- FR-1.3: If AI extraction fails or returns incomplete data, fall back to regex-based extraction and flag any fields that could not be determined for manual entry.
- FR-1.4: User can review and correct any extracted field before rate shopping.
- FR-1.5: Destination is fixed to the Sheboygan facility by default and is editable only via an explicit override (for the rare non-standard delivery).
- FR-1.6: Shipments are queued; the tool supports adding multiple shipments before running rate shopping (batch mode is the primary flow, not one-at-a-time).

### 6.2 Freight classification
- FR-2.1: System defaults freight class by material type (wool = 60, synthetic/polyester = 60, cotton = 55) and allows manual override.
- FR-2.2: Freight class and material defaults are **owned and maintained inside this tool** (a simple editable config/table), not sourced from Acumatica. New material types not in the default table require manual freight class entry by the shipping manager, who can add them to the table directly.

### 6.3 Rate shopping
- FR-3.1: System calculates/retrieves rates for all queued shipments concurrently (not sequentially), across all configured carriers.
- FR-3.2: Phase 1: rates are estimated using dimensional weight vs. actual weight, freight class multiplier, and an origin-to-Sheboygan zone table.
- FR-3.3: Phase 2: rates are retrieved from live carrier rating APIs for both negotiated-account carriers and open-market LTL carriers. No API access exists yet for any carrier; setup is prioritized **open-market LTL first** (SAIA, Estes, Old Dominion, R+L), with negotiated-account carriers (UPS, FedEx, XPO) following.
- FR-3.4: Results are sorted by price ascending and the lowest rate is visually highlighted.
- FR-3.5: Each result shows carrier, price, transit estimate (when available), and destination.

### 6.4 Decision & booking
- FR-4.1: User can select and confirm ("book") the best or any other rate for a shipment.
- FR-4.2: User can export a quote/confirmation per shipment.
- FR-4.3: Batch actions: book all best rates, export all quotes.
- FR-4.4: Phase 2+: "book" should call the carrier's booking API where available rather than only recording a decision.

### 6.5 Reporting
- FR-5.1: Tool shows daily/batch metrics: shipments processed, total cost at chosen rates, savings vs. highest quoted rate.
- FR-5.2: Tool retains historical shipment/rate/decision records (not just in-session) so spend and carrier performance can be reviewed over time.
- FR-5.3: During the Phase 1 parallel run, reporting should support comparing tool-estimated rates/extraction against the manual process's actual outcomes, so the shipping manager has what they need to judge when to rely on the tool as primary (see 5.1).
  - FR-5.3a: The manual process's actual outcome (carrier booked, charge paid, LTL vs. Truckload mode, transit time) is captured per shipment, entered by the shipping manager once the manual booking/pickup is complete — not required before other actions in the tool.
  - FR-5.3b: The tool flags when the actual charge diverges from its own booked/best quote by more than a variance threshold — mirroring the reasonableness check the manual process already did by eyeballing invoices against quotes. The threshold is a value the shipping manager can adjust, not a hardcoded constant.

### 6.6 Acumatica integration (Phase 3)
- FR-6.1: PO matching is **PO-number-driven, not fuzzy-matched**: vendors are expected to reference the Acumatica PO number in their shipment communication. System extracts the PO number from the email/PDF alongside the other shipment fields.
- FR-6.1a: Vendor-quoted PO numbers commonly need cleanup/normalization (extra characters, reformatting, or a vendor-side reference number that isn't the raw Acumatica PO number) before lookup. Extraction must normalize the referenced number and attempt an Acumatica PO lookup, not require an exact raw-string match.
- FR-6.1b: Once a PO is found, the tool surfaces the matching PO line(s) and their quantity so the shipping manager can manually verify the line and quantity in-house before confirming the match. This human verification step is required — the system proposes a match, it does not auto-confirm one.
- FR-6.1c: Partial shipments against a single PO line are normal and expected (a line may be fulfilled across multiple deliveries). Quantity on this shipment being less than the PO line's remaining/open quantity is **not** an error condition and should not be flagged as a mismatch by default.
- FR-6.1d: If the referenced PO number isn't found in Acumatica (not entered yet, typo, wrong number), the shipment proceeds through extraction/rate-shopping/booking **unlinked** rather than being blocked, but is flagged for manual reconciliation later (e.g. a "needs PO reconciliation" status/queue). Ownership of clearing this queue is shared/case-by-case rather than assigned to a single role — the queue should be visible to both Shipping and Purchasing so either can pick it up.
- FR-6.2: On booking, write shipment and expected receipt information back to the associated Acumatica PO/receipt record (once a PO match has been confirmed per FR-6.1b).
- FR-6.3: Vendor and item identifiers, and PO line/quantity data used for matching, should be sourced live from Acumatica (as the ERP of record for POs/vendors). Freight-class and material defaults remain owned by this tool per FR-2.2 and are not synced from Acumatica.
- FR-6.4: Any write-back to Acumatica must be reviewable/undoable by a user before it is treated as final (no silent automated posting without a review step, at least initially).
- FR-6.5: Phase 2 go-live and Phase 3 go-live each require explicit sign-off from the business owner (Chris Chesebro) before enabling live carrier booking or Acumatica write-back, given the financial and ERP-data impact.
- FR-6.6: Landed cost — something the manual process never did — is calculated by tying a shipment's actual freight charge (FR-5.3a) to the Acumatica PO/line it was matched to (FR-6.1b). Because a PO line is often fulfilled across multiple partial shipments (FR-6.1c), landed cost is aggregated **per PO line**, not per shipment, and only finalized once every shipment against that line has both arrived (cumulative quantity shipped meets the line's ordered quantity) and has its actual charge recorded — not exposed as a partial/interim figure before then.

## 7. Data Requirements

Core shipment record (minimum fields to be retained per shipment, across phases):

- Material / product type, freight class
- Weight (lbs), dimensions (L x W x H, inches), pallet/piece count
- Hazmat flag
- Origin address, destination address
- Ready date, requested/actual pickup date
- Carrier options presented (carrier, price, transit time) and which was selected
- Vendor-referenced PO number as extracted (raw), and the normalized/matched Acumatica PO number + line, if found (Phase 3+)
- PO reconciliation status: matched, unlinked/needs reconciliation, or not applicable (Phase 3+)
- Booking/decision timestamp and user
- Actual outcome once the manual process completes: actual carrier, actual charge, actual mode (LTL/Truckload), actual transit days (FR-5.3a)
- Charge-variance threshold (shipping-manager-configurable, FR-5.3b) and, per matched PO line, aggregated material cost + freight-to-date + landed cost once complete (FR-6.6)

No payroll or HR data is involved in this system. Any supplier contact information carried in emails should be limited to what's operationally necessary (company name, pickup contact/phone) and not expanded into a broader contacts database without a clear business need.

## 8. Integration Requirements

| System | Purpose | Phase |
|---|---|---|
| Anthropic Claude API | Extract structured shipment data from unstructured supplier emails/PDFs | 1 |
| Carrier rating APIs (SAIA, Estes, Old Dominion, R+L — open market, prioritized first; UPS, FedEx, XPO — negotiated, second) | Live rate quotes and, later, booking. No credentials/API access exist today — must be set up before Phase 2. | 2 |
| Acumatica 2025R2 (ACM) | Purchase orders and vendor/item identifiers for PO matching; shipment/receipt write-back | 3 |

Acumatica integration should use the standard Acumatica web service endpoints / Generic Inquiries appropriate to 2025R2, consistent with how other Wigwam Acumatica integrations are built. Freight-class/material default data is explicitly **not** part of this integration (see FR-2.2/FR-6.3) — it stays owned by this tool.

## 9. Non-Functional Requirements

- **Performance:** Batch of 50+ shipments should rate-shop concurrently, not sequentially; a full batch should complete in well under the time it takes to process shipments manually today.
- **Reliability:** AI extraction failures must degrade gracefully (regex fallback, manual entry) rather than blocking the workflow.
- **Auditability:** Every rate decision and (later) Acumatica write-back should be traceable to a user and timestamp.
- **Access control:** Tool access limited to shipping/logistics staff and relevant IT admins; Acumatica write-back (Phase 3) restricted further to avoid unauthorized PO/receipt changes.
- **Data handling:** No PII beyond ordinary business contact info; no payroll or HR data of any kind is stored or processed by this tool.
- **Operability:** Any internal lock used to serialize concurrent operations (e.g. the batch rate/book/export actions) must have an operator-triggerable reset, so a stuck lock never requires a full redeploy to clear.
- **Reliability:** Every outbound network call to a third-party API (Anthropic, Acumatica, and future carrier APIs) must have an explicit timeout, so a slow or unresponsive external service cannot hang a request indefinitely.

## 10. Success Metrics

- Average processing time per shipment (target: under 1 minute of manager time, down from 4–6 minutes).
- Freight cost savings vs. historical average (via best-rate selection).
- Extraction accuracy (% of shipments requiring no manual field correction) — tracked explicitly during the Phase 1 parallel run.
- Phase 3: % of shipments successfully auto-matched to a PO.

## 11. Decisions

Resolved during requirements review (2026-07-24):

- **Carrier API access:** None exists today for any carrier (UPS, FedEx, XPO, or LTL market carriers). Procuring/setting up API access is a Phase 2 prerequisite, owned by IT/Systems Admin.
- **Freight-class/material default data ownership:** Maintained inside this tool, not sourced from or synced with Acumatica.
- **Phase 1 rollout:** Parallel run alongside the existing manual process, not a hard cutover. No fixed exit criteria — ends when the shipping manager judges the tool trustworthy enough to rely on (see 5.1).
- **Phase 2/3 sign-off owner:** Chris Chesebro.
- **Phase 2 carrier priority:** Open-market LTL carriers (SAIA, Estes, Old Dominion, R+L) get API access set up first; negotiated-account carriers (UPS, FedEx, XPO) follow.
- **PO matching approach (Phase 3):** Driven by the PO number vendors reference in their shipment communication, not fuzzy vendor/item/date matching. Vendor-quoted PO numbers often need cleanup/normalization before an Acumatica lookup (FR-6.1a). Once found, the shipping manager manually verifies the PO line and quantity in-house before the match is confirmed (FR-6.1b) — this is by design, not a fallback.
- **Partial shipments (Phase 3):** Normal and expected; a shipment quantity less than the PO line's remaining quantity is not treated as a mismatch (FR-6.1c).
- **No PO match found (Phase 3):** Shipment proceeds unlinked through the rest of the workflow and is flagged for manual reconciliation, visible to both Shipping and Purchasing rather than assigned to one owner (FR-6.1d).
- **PO number normalization rules:** Deliberately deferred — will be catalogued from a sample of real supplier emails once Phase 3 design starts, rather than guessed now.
- **PO matching scope pull-forward (2026-07-27):** With material identification proving unreliable via hardcoded buckets + AI guesswork, FR-6.1 (PO lookup/matching) was pulled forward into active Phase 1 build rather than waiting for Phase 3. FR-6.2 (Acumatica write-back) stays in Phase 3 — this pull-forward is read-only against Acumatica.
- **Acumatica findings grounding FR-6.1 (sample PO `P000513` pulled during design):** PO numbers follow a `P` + 6-digit zero-padded format; `VendorClass = "YARN"` distinguishes raw-material yarn vendors from other vendor types (e.g. `MACHPART`); real inventory items use specific construction/blend/color codes (e.g. `Y5750-057`), not the Wool/Synthetic/Cotton buckets in the Phase 0 proof of concept — confirming material should be sourced from the matched PO line once confirmed (FR-6.1b), not the AI's guess from email text; freight class (NMFC) is not tracked in Acumatica at all, reconfirming FR-2.2.
- **Acumatica API credentials for FR-6.1:** An existing Acumatica API integration credential/pattern is available and can be obtained from IT (confirmed by the business owner); exact connection details (endpoint version, OAuth client) still need to be provisioned for this Worker specifically — tracked as a setup blocker in `PHASE1_BUILD_PLAN.md` / `README.md`, same pattern as the `ANTHROPIC_API_KEY` blocker.
- **Acumatica endpoint version confirmed, vendor-name bug fixed (2026-07-28):** Using the read-only Acumatica connection available in this environment (separate from the Worker's own not-yet-provisioned OAuth client), verified the contract-based endpoint version directly against Wigwam's instance: `25.200.001`, matching the 2025R2 designation. This is not sensitive data, so it's now a plain `wrangler.toml` variable rather than a fourth secret — only `ACUMATICA_BASE_URL`, `ACUMATICA_CLIENT_ID`, and `ACUMATICA_CLIENT_SECRET` remain outstanding. Separately, the same verification caught that `lookupPurchaseOrder()` was reading `vendorName` off the PurchaseOrder entity's `VendorRef` field, which is actually a free-text vendor-reference number (confirmed blank on the real `P000513` PO) — not the vendor's name. Fixed by resolving `vendorName` with a second call to the `Vendor` entity by `VendorID` instead.
- **Stuck-lock recovery and outbound timeouts (2026-07-27):** the batch endpoints (rate-batch/book-all/export-all) share a serialization lock (see `PHASE1_BUILD_PLAN.md` section 3) with no escape hatch other than redeploying if a request dies mid-operation and never releases it. Added a token-gated reset endpoint as the escape hatch, and added an explicit timeout to every outbound `fetch()` call (Anthropic, Acumatica) so a slow/unresponsive external service can't hang a request — see the Operability/Reliability NFRs added to section 9.
- **Metrics/history dashboard scope (2026-07-27):** FR-5.1 (stat metrics) and FR-5.2 (history retention/view) are built as a "Metrics" panel in the UI. FR-5.3 was initially deferred (no capture mechanism existed) — see the follow-up decision below for how it was resolved.
- **FR-5.3 design, resolved (2026-07-27):** The manual process being replaced was: get and compare carrier rates/service times, decide LTL vs. Truckload (a simple, calculable threshold — the exact number is still open, see section 12), book the load, create and send pickup documentation to the vendor, and check the actual invoiced charge against the quote within a reasonable tolerance before treating it as settled. This maps onto: (a) actual-outcome fields (carrier, charge, mode, transit days) entered inline on each shipment once the manual process completes (FR-5.3a) — reusing the existing field-edit UI rather than a separate reconciliation screen or requiring a separate view; (b) a charge-variance flag against the booked/best quote, with the tolerance a shipping-manager-configurable value rather than a hardcoded percentage or dollar amount (FR-5.3b) — because "reasonable" was explicitly called out as something the manager, not the system, should set.
- **Landed cost, added scope (2026-07-27):** Not part of the original manual process, but explicitly wanted now that PO/line matching (FR-6.1) already exists: tie each shipment's actual freight charge to its matched PO/line and compute landed cost = PO line material cost + freight. Because PO lines are commonly fulfilled across multiple partial shipments (FR-6.1c), landed cost is aggregated **per PO line** once every shipment against it has both arrived and been charge-reconciled, not computed per-shipment or shown as a running partial figure (FR-6.6).

## 12. Remaining Open Items

- **LTL vs. Truckload threshold:** The manual process used a simple, calculable rule to decide mode (e.g. a weight or pallet-count cutoff), but the exact number hasn't been provided. `actual_mode` is currently just a manually-recorded field (FR-5.3a) — the rate engine itself (`src/rating.ts`) doesn't yet branch on mode at all, so this threshold is needed both to validate `actual_mode` entries and, eventually, to have the tool make this call itself rather than only recording it after the fact.

Expect further open items to surface once Phase 1 build starts and, later, during Phase 3 design (e.g. the PO-number normalization catalogue above).

## 13. Assumptions

- Single fixed destination facility (Sheboygan, WI) for the foreseeable future.
- Current three material types (wool, synthetic/polyester, cotton yarn) represent the large majority of inbound volume; other materials are handled via manual override initially.
- Acumatica 2025R2 is and will remain the ERP of record for this integration.
