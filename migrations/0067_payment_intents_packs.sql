-- Credit packs on payment intents.
--
-- Colony sells Credits, denominated in USD because its own costs are: model
-- providers bill dollars. But no South African payment gateway may charge in
-- dollars — SARB permits ZAR-denominated processing only, which is why both
-- PayFast and Paystack settle a South African merchant in Rands.
--
-- Resolving that with an exchange rate would put the currency risk on us: a
-- rate goes stale between the charge and the settlement, and the difference
-- is a loss nobody chose. So a pack instead carries an explicit price in each
-- currency, set deliberately, and nothing here is ever computed from a rate.
--
-- Three columns say what an intent actually is:
--   pack_id             which pack was bought
--   charge_minor_units  what we asked the gateway to collect
--   charge_currency     the currency those units are in
--   grant_nanousd       the Credits settlement grants, fixed at purchase
--
-- grant_nanousd is recorded here rather than looked up at settlement time so
-- a price edit between checkout and callback cannot change what an in-flight
-- purchase is worth. It also means a callback reporting an unexpected amount
-- can never mis-credit: the grant comes from this row, never from the wire.
--
-- usd_cents stays as the pack's USD list price. Its existing CHECK (>= 500)
-- and every reader keep working, and it remains the honest answer to "what is
-- this top-up worth in dollars".

ALTER TABLE payment_intents
    ADD COLUMN pack_id TEXT,
    ADD COLUMN charge_minor_units BIGINT
        CHECK (charge_minor_units IS NULL OR charge_minor_units > 0),
    ADD COLUMN charge_currency TEXT
        CHECK (charge_currency IS NULL OR charge_currency IN ('ZAR', 'USD')),
    ADD COLUMN grant_nanousd BIGINT
        CHECK (grant_nanousd IS NULL OR grant_nanousd > 0);

-- Nullable because rows predating packs have no pack: they were free-amount
-- top-ups priced in USD. A NULL grant_nanousd means "fall back to usd_cents",
-- which is exactly what those rows meant. New rows always carry all four.
--
-- The four travel together or not at all; a row holding some but not others
-- would be a bug in the writer, not a state any reader should have to model.
ALTER TABLE payment_intents
    ADD CONSTRAINT payment_intents_pack_columns_travel_together
    CHECK (
        (pack_id IS NULL
            AND charge_minor_units IS NULL
            AND charge_currency IS NULL
            AND grant_nanousd IS NULL)
        OR (pack_id IS NOT NULL
            AND charge_minor_units IS NOT NULL
            AND charge_currency IS NOT NULL
            AND grant_nanousd IS NOT NULL)
    );
