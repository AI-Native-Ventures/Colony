-- Gateway admission is deliberately a four-call safety ceiling.  Existing
-- account overrides are normalized before the constraint is tightened so an
-- additive upgrade remains deployable on databases that used the old
-- positive-only policy.
UPDATE accounts
SET max_in_flight = 4,
    updated_at = now()
WHERE max_in_flight > 4;

ALTER TABLE accounts
    DROP CONSTRAINT IF EXISTS accounts_max_in_flight_check,
    ADD CONSTRAINT accounts_max_in_flight_check
        CHECK (max_in_flight IS NULL OR max_in_flight BETWEEN 1 AND 4);
