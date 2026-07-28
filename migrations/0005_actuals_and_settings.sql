-- FR-5.3: capture the manual process's actual outcome per shipment (carrier
-- used, charge paid, mode, transit time) so the tool's estimate/extraction
-- can be compared against it, and so freight charges can be tied to the
-- matched Acumatica PO line for landed-cost calculation (FR-6.3-adjacent).
ALTER TABLE shipments ADD COLUMN actual_carrier TEXT;
ALTER TABLE shipments ADD COLUMN actual_charge REAL;
ALTER TABLE shipments ADD COLUMN actual_mode TEXT; -- 'LTL' or 'Truckload'
ALTER TABLE shipments ADD COLUMN actual_transit_days INTEGER;

-- Singleton settings row. charge_variance_threshold_pct is the shipping
-- manager's configurable tolerance for flagging actual_charge vs. the booked
-- quote (default 5%, adjustable via /api/config/settings, not hardcoded).
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  charge_variance_threshold_pct REAL NOT NULL DEFAULT 5,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO settings (id, charge_variance_threshold_pct) VALUES (1, 5);
