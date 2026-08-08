-- Gateway settle basis: HOW a debit's cost was determined.
--
-- 'observed' — the provider (Vercel AI Gateway) stated the cost on the wire;
-- the ledger line equals the charge (critique finding 6, checkout model).
-- 'estimated' — the provider stated no usable cost (unfamiliar usage shape)
-- and the gateway priced the call from the price book instead.
--
-- Reconciliation compares daily ledger debits against Vercel usage export:
-- estimated lines are expected to drift and must be inspectable, not just
-- summable, so the basis rides on the entry itself. NULL on non-debit rows
-- (credits, seeds, corrections), where no cost was determined at all.
ALTER TABLE credit_ledger
    ADD COLUMN settle_basis TEXT
    CHECK (settle_basis IS NULL OR settle_basis IN ('observed', 'estimated'));

-- Seed the default provisioned model catalog. Without rows a fresh deploy
-- serves no models at all (the gateway gates every request on this table).
-- DeepSeek V4 Flash/Pro are the Phase 1 default leg (spec: upstream revision,
-- catalog verified 2026-08-07 against DeepSeek list prices; the same rates
-- ship in the price book). `ON CONFLICT DO NOTHING` keeps an operator's
-- hand-tuned rows: this file only ever supplies the defaults.
--
-- display_price_nanousd is a pre-call display estimate only — it never
-- drives a debit. Stated as the input rate per million tokens in nanoUSD:
-- Flash $0.14/MTok = 140_000_000 nanoUSD; Pro $0.435/MTok = 435_000_000.
INSERT INTO model_catalog (model_id, vercel_slug, enabled, display_price_nanousd) VALUES
    ('deepseek-v4-flash', 'deepseek/deepseek-v4-flash', true, 140000000),
    ('deepseek-v4-pro', 'deepseek/deepseek-v4-pro', true, 435000000)
ON CONFLICT (model_id) DO NOTHING;
