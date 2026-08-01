-- Durable idempotency claims for relay-brokered Colony Company Actions.
--
-- Mirrors block_catalog_action_claims: the claim records the exact owner-signed
-- action, the relay-authored canonical head, and the relay-signed receipt that
-- committed as one transaction. Community leads the key so identical retry
-- UUIDs stay independent across tenant boundaries, and a replayed action can
-- return the original result instead of creating a second record.
CREATE TABLE company_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    head_event_id BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key)
);
