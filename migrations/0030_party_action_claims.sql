-- Durable idempotency claims for relay-brokered Colony party actions.
--
-- Mirrors company_action_claims: the claim records the exact owner-signed
-- action, the relay-authored head, and the relay-signed receipt that committed
-- as one transaction. Community leads the key so identical retry UUIDs stay
-- independent across tenant boundaries, and a replayed action returns the
-- original result instead of creating a second record.
--
-- `alias_event_id` is the one difference from the company table. A merge writes
-- two heads at once, the surviving party and the pointer left at the retired
-- handle, and both have to be recoverable from a replay. A survivor without its
-- alias would strand every reference to the old handle; an alias without its
-- survivor would point at a record that never absorbed anything. Null for every
-- action that is not a merge.
CREATE TABLE party_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    head_event_id BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    alias_event_id BYTEA CHECK (alias_event_id IS NULL OR octet_length(alias_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key)
);
