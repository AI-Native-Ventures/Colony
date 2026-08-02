-- Private, relay-owned state for Colony business Discovery.
--
-- Nostr carries signed commands and safe receipts. Entitlements, actor grants,
-- worker leases, and run progress stay in these community-scoped tables and
-- are never exposed through generic event queries.

CREATE TABLE discovery_entitlements (
    community_id UUID NOT NULL PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE discovery_actor_grants (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor_pubkey BYTEA NOT NULL CHECK (octet_length(actor_pubkey) = 32),
    capability TEXT NOT NULL CHECK (capability = 'discovery.run'),
    granted_by BYTEA NOT NULL CHECK (octet_length(granted_by) = 32),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, actor_pubkey, capability)
);

CREATE TABLE discovery_runs (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    requested_by BYTEA NOT NULL CHECK (octet_length(requested_by) = 32),
    start_idempotency_key UUID NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'running', 'succeeded', 'cancelled', 'failed')),
    completed_steps INTEGER NOT NULL DEFAULT 0 CHECK (completed_steps >= 0),
    total_steps INTEGER NOT NULL CHECK (total_steps > 0),
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    claim_id UUID,
    lease_until TIMESTAMPTZ,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    terminal_reason TEXT
        CHECK (terminal_reason IN ('cancelled_by_actor', 'entitlement_revoked', 'executor_failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, start_idempotency_key),
    CHECK (completed_steps <= total_steps),
    CHECK ((claim_id IS NULL) = (lease_until IS NULL))
);

CREATE INDEX discovery_runs_claimable_idx
    ON discovery_runs (state, lease_until, created_at)
    WHERE state IN ('queued', 'running');

CREATE INDEX discovery_runs_community_created_idx
    ON discovery_runs (community_id, created_at DESC);

CREATE TABLE discovery_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('start', 'status', 'cancel')),
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    run_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key),
    UNIQUE (community_id, action_event_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

-- Existing databases can have either the historical negative skip-list or the
-- fresh-install positive allowlist. Wrap the installed expression rather than
-- replacing it, preserving every pre-existing operator choice while making
-- Discovery actions and receipts mathematically unsearchable.
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
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (CASE WHEN kind IN (40017, 40018) THEN NULL::tsvector ELSE (%s) END) STORED',
        existing_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;
