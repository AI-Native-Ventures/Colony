-- Durable attribution for every admitted hosted-gateway call. This is an
-- intent, not a balance reservation: it records which account/ref must be
-- reconciled if provider usage arrives after a relay/database failure.
CREATE TABLE gateway_settlement_intents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    reference TEXT NOT NULL,
    model TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'admitted'
        CHECK (state IN ('admitted', 'provider_completed', 'debited', 'reconciliation', 'resolved')),
    provider_request_id TEXT,
    observed_cost BIGINT CHECK (observed_cost IS NULL OR observed_cost >= 0),
    provider_status SMALLINT,
    reason TEXT,
    correction_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    UNIQUE (pubkey, reference)
);

CREATE INDEX gateway_settlement_intents_pending_idx
    ON gateway_settlement_intents (updated_at)
    WHERE state <> 'resolved';

ALTER TABLE gateway_reconciliation_outcomes
    ADD COLUMN intent_id BIGINT REFERENCES gateway_settlement_intents(id),
    ADD COLUMN provider_request_id TEXT,
    ADD COLUMN observed_cost BIGINT CHECK (observed_cost IS NULL OR observed_cost >= 0),
    ADD COLUMN correction_ref TEXT;

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('gateway_settlement_intents', 'durable identity and provider-export correlation for hosted gateway settlement')
ON CONFLICT (table_name) DO NOTHING;
