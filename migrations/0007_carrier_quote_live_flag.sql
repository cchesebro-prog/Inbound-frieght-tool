-- Explicit signal for the shipping manager to distinguish a real Estes
-- Cloud API quote from every other still-simulated carrier estimate,
-- rather than relying on the presence of transit_estimate as a proxy
-- (which breaks if Estes ever omits transit days on a real quote).
ALTER TABLE carrier_quotes ADD COLUMN is_live INTEGER NOT NULL DEFAULT 0;
