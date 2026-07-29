-- Persists the last Estes rate-quotes failure/no-rate reason per shipment,
-- so it can be inspected directly (e.g. via a D1 query) instead of requiring
-- `wrangler tail` to have been running at the exact moment of the request.
-- NULL means the last rate-batch call either got a live quote or hasn't run
-- the Estes call yet.
ALTER TABLE shipments ADD COLUMN estes_last_error TEXT;
