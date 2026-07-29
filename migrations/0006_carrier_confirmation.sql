-- FR-4.5: recording the manual carrier confirmation step after booking a
-- quote. No live carrier booking API exists yet, so this is a manual
-- phone/email confirmation, with the carrier's confirmation/PRO number
-- entered back into the tool once received.
ALTER TABLE booking_decisions ADD COLUMN carrier_confirmation_nbr TEXT;
ALTER TABLE booking_decisions ADD COLUMN confirmed_by INTEGER REFERENCES users(id);
ALTER TABLE booking_decisions ADD COLUMN confirmed_at TEXT;
