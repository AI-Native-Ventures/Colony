-- Colony Credits admission policy overrides.
--
-- NULL means "use the relay's deployment-global default". Keeping the
-- defaults in config (rather than copying them into every account row) lets an
-- operator tighten the deployment policy without a data migration, while
-- account-specific fraud/trial tiers can override each dimension from day one.
ALTER TABLE accounts
    ADD COLUMN typical_call_cost_nanousd BIGINT
        CHECK (typical_call_cost_nanousd IS NULL OR typical_call_cost_nanousd > 0),
    ADD COLUMN max_in_flight SMALLINT
        CHECK (max_in_flight IS NULL OR max_in_flight > 0),
    ADD COLUMN hourly_burn_cap_nanousd BIGINT
        CHECK (hourly_burn_cap_nanousd IS NULL OR hourly_burn_cap_nanousd > 0);
