-- Durable idempotency claims for relay-brokered global Block catalog actions.
--
-- The claim records the exact action, parameterized catalog head, and receipt
-- that committed as one transaction. Community leads the key so identical
-- retry UUIDs remain independent across tenant boundaries.
CREATE TABLE block_catalog_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    head_event_id BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key)
);
