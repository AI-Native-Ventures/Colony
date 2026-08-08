-- Durable outcome linked to a settlement intent when a successful provider
-- response cannot be billed inline (unsupported encoding, malformed usage, or
-- a settle failure). It is not a reservation or balance mutation; the exact
-- provider-export resolver closes it against the intent.
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
    ('gateway_reconciliation_outcomes', 'successful gateway calls needing durable attribution/reconciliation');
