-- Durable idempotency claims for relay-brokered Colony ledger actions.
--
-- Mirrors party_action_claims without its alias column: a ledger action writes
-- exactly one head (a price book, rulebook, correction book, or one cost
-- centre's budget), so there is no second record that has to be recoverable
-- alongside it.
--
-- Community leads the key so identical retry UUIDs stay independent across
-- tenant boundaries, and a replayed action returns the original result instead
-- of appending the same price entry, rule, or correction twice.
CREATE TABLE ledger_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    head_event_id BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key)
);
