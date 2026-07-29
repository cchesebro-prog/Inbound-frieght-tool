-- Pulls FR-6.1 (PO-number-driven matching) forward from Phase 3 into Phase 1.
-- Additive columns only, per PHASE1_BUILD_PLAN.md section 3.

ALTER TABLE shipments ADD COLUMN po_number_raw TEXT;
ALTER TABLE shipments ADD COLUMN po_number_matched TEXT;
ALTER TABLE shipments ADD COLUMN po_line_id TEXT;
ALTER TABLE shipments ADD COLUMN po_reconciliation_status TEXT NOT NULL DEFAULT 'not_applicable';
-- Snapshot (JSON) of the Acumatica PO + line data returned at lookup time, so the
-- manual-verification UI (FR-6.1b) can render it without a live Acumatica call on
-- every page load. Cleared/overwritten on each new lookup.
ALTER TABLE shipments ADD COLUMN po_match_data TEXT;
