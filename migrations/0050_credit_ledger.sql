-- Colony Credits Phase 1: the money layer.
--
-- accounts: pubkey -> nanoUSD credit balance. The balance is usage credits;
-- every model call debits the provider's OBSERVED cost 1:1 (critique finding
-- 6). Colony's fee is charged once at purchase time and never appears in this
-- ledger. Negative balance is representable: bounded overdraft on settle is
-- legal, hard-block happens at admission (a later ticket).
--
-- credit_ledger: append-only journal of every balance change. The (pubkey,
-- ref) uniqueness is the idempotency contract: a replayed webhook, seed, or
-- settle is a no-op returning the original entry.
--
-- gateway_tokens: pubkey-bound provisioned-mode tokens (token hash, TTL,
-- session scope, revocation). model_catalog: allowlisted model -> Vercel AI
-- Gateway slug, with display price as a pre-call ESTIMATE only — the catalog
-- never drives a debit.

CREATE TABLE accounts (
    pubkey BYTEA PRIMARY KEY CHECK (octet_length(pubkey) = 32),
    balance BIGINT NOT NULL DEFAULT 0,
    -- Phase 2 trial stubs (grant is model-locked, expiring, concurrency 1).
    trial_model TEXT,
    trial_expires_at TIMESTAMPTZ,
    trial_concurrency SMALLINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    delta BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('debit', 'credit', 'seed', 'correction')),
    ref TEXT NOT NULL,
    model TEXT,
    observed_cost BIGINT CHECK (observed_cost IS NULL OR observed_cost >= 0),
    request_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pubkey, ref)
);

CREATE INDEX credit_ledger_created_at_idx ON credit_ledger (created_at);

CREATE TABLE gateway_tokens (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    expires_at TIMESTAMPTZ NOT NULL,
    session_scope TEXT NOT NULL DEFAULT 'session'
        CHECK (session_scope IN ('session', 'provisioned')),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX gateway_tokens_pubkey_idx ON gateway_tokens (pubkey);

CREATE TABLE model_catalog (
    model_id TEXT PRIMARY KEY,
    vercel_slug TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    display_price_nanousd BIGINT NOT NULL CHECK (display_price_nanousd >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credits tables are deployment-global (identity-scoped, not community-
-- scoped): balances, the money journal, provisioned tokens, and the model
-- allowlist all span relay communities.
INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('accounts', 'credit balances are identity-global, not community-scoped'),
    ('credit_ledger', 'append-only money journal is identity-global, not community-scoped'),
    ('gateway_tokens', 'provisioned-mode tokens are identity-global, not community-scoped'),
    ('model_catalog', 'model allowlist is deployment-global');
