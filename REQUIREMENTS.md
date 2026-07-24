# Inbound Freight Tool — Requirements

**Status:** Draft v2
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

### 5.1 Rollout approach (confirmed)

Phase 1 launches as a **parallel run**: the shipping manager keeps doing the current manual process as the system of record while using the tool alongside it, so extraction accuracy and estimated rates can be validated against real outcomes before the tool becomes primary. Exit criteria for ending the parallel run (e.g. an accuracy threshold, a minimum number of shipments validated) should be defined before Phase 1 build starts.

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
- FR-3.3: Phase 2: rates are retrieved from live carrier rating APIs for both negotiated-account carriers and open-market LTL carriers. Negotiated-account API access (UPS, FedEx, XPO) does not exist yet and must be procured/set up as a prerequisite for Phase 2.
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
- FR-5.3: During the Phase 1 parallel run, reporting should support comparing tool-estimated rates/extraction against the manual process's actual outcomes, to evaluate exit criteria.

### 6.6 Acumatica integration (Phase 3)
- FR-6.1: Match an inbound shipment to an open Purchase Order in Acumatica (by vendor + item + expected date, with manual override if no confident match).
- FR-6.2: On booking, write shipment and expected receipt information back to the associated Acumatica PO/receipt record.
- FR-6.3: Vendor and item identifiers used for PO matching should be sourced from Acumatica (as the ERP of record for POs/vendors). Freight-class and material defaults remain owned by this tool per FR-2.2 and are not synced from Acumatica.
- FR-6.4: Any write-back to Acumatica must be reviewable/undoable by a user before it is treated as final (no silent automated posting without a review step, at least initially).
- FR-6.5: Phase 2 go-live and Phase 3 go-live each require explicit sign-off from the business owner (Chris Chesebro) before enabling live carrier booking or Acumatica write-back, given the financial and ERP-data impact.

## 7. Data Requirements

Core shipment record (minimum fields to be retained per shipment, across phases):

- Material / product type, freight class
- Weight (lbs), dimensions (L x W x H, inches), pallet/piece count
- Hazmat flag
- Origin address, destination address
- Ready date, requested/actual pickup date
- Carrier options presented (carrier, price, transit time) and which was selected
- Linked PO number (Phase 3+)
- Booking/decision timestamp and user

No payroll or HR data is involved in this system. Any supplier contact information carried in emails should be limited to what's operationally necessary (company name, pickup contact/phone) and not expanded into a broader contacts database without a clear business need.

## 8. Integration Requirements

| System | Purpose | Phase |
|---|---|---|
| Anthropic Claude API | Extract structured shipment data from unstructured supplier emails/PDFs | 1 |
| Carrier rating APIs (UPS, FedEx, XPO — negotiated; SAIA, Estes, Old Dominion, R+L — open market) | Live rate quotes and, later, booking. No credentials/API access exist today — must be set up before Phase 2. | 2 |
| Acumatica 2025R2 (ACM) | Purchase orders and vendor/item identifiers for PO matching; shipment/receipt write-back | 3 |

Acumatica integration should use the standard Acumatica web service endpoints / Generic Inquiries appropriate to 2025R2, consistent with how other Wigwam Acumatica integrations are built. Freight-class/material default data is explicitly **not** part of this integration (see FR-2.2/FR-6.3) — it stays owned by this tool.

## 9. Non-Functional Requirements

- **Performance:** Batch of 50+ shipments should rate-shop concurrently, not sequentially; a full batch should complete in well under the time it takes to process shipments manually today.
- **Reliability:** AI extraction failures must degrade gracefully (regex fallback, manual entry) rather than blocking the workflow.
- **Auditability:** Every rate decision and (later) Acumatica write-back should be traceable to a user and timestamp.
- **Access control:** Tool access limited to shipping/logistics staff and relevant IT admins; Acumatica write-back (Phase 3) restricted further to avoid unauthorized PO/receipt changes.
- **Data handling:** No PII beyond ordinary business contact info; no payroll or HR data of any kind is stored or processed by this tool.

## 10. Success Metrics

- Average processing time per shipment (target: under 1 minute of manager time, down from 4–6 minutes).
- Freight cost savings vs. historical average (via best-rate selection).
- Extraction accuracy (% of shipments requiring no manual field correction) — tracked explicitly during the Phase 1 parallel run.
- Phase 3: % of shipments successfully auto-matched to a PO.

## 11. Decisions

Resolved during requirements review (2026-07-24):

- **Carrier API access:** None exists today for any carrier (UPS, FedEx, XPO, or LTL market carriers). Procuring/setting up API access is a Phase 2 prerequisite, owned by IT/Systems Admin.
- **Freight-class/material default data ownership:** Maintained inside this tool, not sourced from or synced with Acumatica.
- **Phase 1 rollout:** Parallel run alongside the existing manual process, not a hard cutover.
- **Phase 2/3 sign-off owner:** Chris Chesebro.

## 12. Remaining Open Items

- Exit criteria for ending the Phase 1 parallel run (e.g. minimum shipments validated, accuracy threshold) — needs to be defined before Phase 1 build starts.
- Which carrier(s) to prioritize first when setting up real API access for Phase 2 (negotiated accounts vs. open-market LTL), and expected timeline for that procurement.
- Whether Acumatica vendor/item data is already structured in a way that supports confident automatic PO matching (FR-6.1), or whether vendor/item cleanup is needed first.

## 13. Assumptions

- Single fixed destination facility (Sheboygan, WI) for the foreseeable future.
- Current three material types (wool, synthetic/polyester, cotton yarn) represent the large majority of inbound volume; other materials are handled via manual override initially.
- Acumatica 2025R2 is and will remain the ERP of record for this integration.
