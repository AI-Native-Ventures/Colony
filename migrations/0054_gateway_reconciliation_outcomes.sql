-- Durable backstop for successful provider responses that the relay cannot
-- parse (unsupported content encoding, malformed usage, or a settle failure).
-- The row is an outcome, not a reservation or a balance mutation; daily
-- reconciliation resolves it against the provider export.
CREATE TABLE gateway_reconciliation_outcomes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    reference TEXT NOT NULL,
    model TEXT NOT NULL,
    http_status SMALLINT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    UNIQUE (pubkey, reference)
);

CREATE INDEX gateway_reconciliation_outcomes_pending_idx
    ON gateway_reconciliation_outcomes (created_at)
    WHERE resolved_at IS NULL;

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('gateway_reconciliation_outcomes', 'successful gateway calls needing durable daily reconciliation');
