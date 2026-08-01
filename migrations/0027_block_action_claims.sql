-- Durable idempotency claims for Block actions.
--
-- A client retry may sign a fresh kind:40010 event while retaining the same
-- idempotency key. The community, referenced Block instance, and key form the
-- durable execution boundary. The winning claim and its action event are
-- inserted in one transaction by buzz-db, so a claim can never commit without
-- the event that won it.
CREATE TABLE block_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    instance_event_id BYTEA NOT NULL CHECK (octet_length(instance_event_id) = 32),
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, instance_event_id, idempotency_key)
);
