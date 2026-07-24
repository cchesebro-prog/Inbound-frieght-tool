CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE freight_class_defaults (
  material TEXT PRIMARY KEY,
  freight_class REAL NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'queued',
  raw_input TEXT NOT NULL,
  material TEXT,
  freight_class REAL,
  weight_lbs REAL,
  pieces INTEGER,
  length_in REAL,
  width_in REAL,
  height_in REAL,
  hazmat INTEGER NOT NULL DEFAULT 0,
  origin_address TEXT,
  destination_address TEXT NOT NULL DEFAULT '5300 WI-42, Sheboygan, WI 53083',
  ready_date TEXT,
  extraction_method TEXT,
  extraction_flagged_fields TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE carrier_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  carrier TEXT NOT NULL,
  price REAL NOT NULL,
  transit_estimate TEXT,
  is_best INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE booking_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  chosen_quote_id INTEGER NOT NULL REFERENCES carrier_quotes(id),
  booked_by INTEGER REFERENCES users(id),
  booked_at TEXT NOT NULL DEFAULT (datetime('now')),
  exported INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_carrier_quotes_shipment ON carrier_quotes(shipment_id);
CREATE INDEX idx_shipments_status ON shipments(status);
