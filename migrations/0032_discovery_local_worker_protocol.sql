-- Durable, private control plane for user-owned local Discovery workers.
-- Provider credentials and provider payloads never enter relay storage.

ALTER TABLE discovery_runs
    ADD COLUMN worker_id UUID,
    ADD COLUMN lease_owner_pubkey BYTEA CHECK (octet_length(lease_owner_pubkey) = 32),
    ADD COLUMN last_checkpoint_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (last_checkpoint_sequence >= 0),
    ADD CONSTRAINT discovery_runs_worker_lease_shape CHECK (
        (claim_id IS NULL AND lease_until IS NULL AND worker_id IS NULL AND lease_owner_pubkey IS NULL)
        OR
        (claim_id IS NOT NULL AND lease_until IS NOT NULL AND (
            (worker_id IS NULL AND lease_owner_pubkey IS NULL)
            OR (worker_id IS NOT NULL AND lease_owner_pubkey IS NOT NULL)
        ))
    );

CREATE TABLE discovery_run_checkpoints (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    checkpoint_kind TEXT NOT NULL
        CHECK (checkpoint_kind IN ('provider_submitted', 'provider_results_ready')),
    provider TEXT NOT NULL CHECK (provider = 'outscraper'),
    provider_request_id TEXT
        CHECK (
            provider_request_id IS NULL
            OR (
                length(provider_request_id) BETWEEN 1 AND 128
                AND provider_request_id ~ '^[A-Za-z0-9_-]+$'
            )
        ),
    item_count INTEGER CHECK (item_count >= 0),
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id, sequence),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE,
    CHECK (
        (checkpoint_kind = 'provider_submitted' AND provider_request_id IS NOT NULL AND item_count IS NULL)
        OR
        (checkpoint_kind = 'provider_results_ready' AND provider_request_id IS NULL AND item_count IS NOT NULL)
    )
);

CREATE UNIQUE INDEX discovery_checkpoint_provider_request_once_idx
    ON discovery_run_checkpoints (community_id, provider, provider_request_id)
    WHERE provider_request_id IS NOT NULL;

CREATE TABLE discovery_worker_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    operation TEXT NOT NULL
        CHECK (operation IN ('claim', 'heartbeat', 'checkpoint', 'complete')),
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    run_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key),
    UNIQUE (community_id, action_event_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

-- Preserve the installed search expression while excluding the worker's
-- author-only actions and requester-private receipts from storage-level FTS.
DO $$
DECLARE
    existing_expression TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO existing_expression
      FROM pg_attrdef d
      JOIN pg_attribute a
        ON a.attrelid = d.adrelid
       AND a.attnum = d.adnum
     WHERE d.adrelid = 'events'::regclass
       AND a.attname = 'search_tsv';

    IF existing_expression IS NULL THEN
        RAISE EXCEPTION 'events.search_tsv generated expression not found';
    END IF;

    ALTER TABLE events DROP COLUMN search_tsv;
    EXECUTE format(
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (CASE WHEN kind IN (40019, 40020) THEN NULL::tsvector ELSE (%s) END) STORED',
        existing_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;
