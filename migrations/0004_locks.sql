-- Serialization lock for batch operations (rate-batch/book-all/export-all can
-- race if triggered concurrently by two users) plus the token-gated escape
-- hatch to clear a lock that gets stuck (e.g. a request dies mid-operation
-- without reaching its release step) without requiring a redeploy.
CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  acquired_by INTEGER REFERENCES users(id)
);
