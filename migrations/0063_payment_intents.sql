-- Payment top-up intents.
--
-- One row per checkout attempt, written before the user leaves for the
-- hosted payment page. The reference maps a later provider callback back to
-- the member and the amount we asked for; the callback's own numbers are
-- never trusted without this row to check them against.
--
-- Tenant scoped like every table here: the primary key leads with
-- community_id, so the same reference may exist in two communities.

CREATE TABLE payment_intents (
    community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    reference     TEXT NOT NULL,
    pubkey        BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    usd_cents     BIGINT NOT NULL CHECK (usd_cents >= 500),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'failed', 'abandoned')),
    paid_cents    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at    TIMESTAMPTZ,
    PRIMARY KEY (community_id, reference)
);

CREATE INDEX payment_intents_pubkey_idx ON payment_intents (community_id, pubkey);

SELECT attach_community_write_fence('payment_intents');
