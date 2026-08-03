-- Durable multi-source plans for Businesses Discovery.
--
-- Campaign configuration remains mutable for future runs. Every accepted run
-- receives its own immutable source snapshot and per-source progress rows.
-- Provider credentials, headers, and raw responses never enter relay storage.

ALTER TABLE discovery_campaigns
    ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'waterfall'
        CHECK (source_mode IN ('waterfall', 'concurrent')),
    ADD COLUMN source_keys TEXT[] NOT NULL DEFAULT ARRAY['google_maps']::TEXT[]
        CHECK (
            cardinality(source_keys) BETWEEN 1 AND 3
            AND source_keys <@ ARRAY['google_maps', 'brave_search', 'exa_search']::TEXT[]
            AND array_position(source_keys, source_keys[1], 2) IS NULL
            AND (
                cardinality(source_keys) < 2
                OR array_position(source_keys, source_keys[2], 3) IS NULL
            )
        );

CREATE TABLE discovery_run_source_plans (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    source_mode TEXT NOT NULL CHECK (source_mode IN ('waterfall', 'concurrent')),
    source_keys TEXT[] NOT NULL CHECK (
        cardinality(source_keys) BETWEEN 1 AND 3
        AND source_keys <@ ARRAY['google_maps', 'brave_search', 'exa_search']::TEXT[]
        AND array_position(source_keys, source_keys[1], 2) IS NULL
        AND (
            cardinality(source_keys) < 2
            OR array_position(source_keys, source_keys[2], 3) IS NULL
        )
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

CREATE TABLE discovery_run_sources (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    source_key TEXT NOT NULL
        CHECK (source_key IN ('google_maps', 'brave_search', 'exa_search')),
    provider TEXT NOT NULL
        CHECK (provider IN ('outscraper', 'brave_search', 'exa_search')),
    position SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 2),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'active', 'completed', 'exhausted', 'failed', 'cancelled',
        'outcome_unknown', 'skipped_target_met'
    )),
    request_cursor TEXT CHECK (
        request_cursor IS NULL OR octet_length(request_cursor) BETWEEN 1 AND 256
    ),
    request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    returned_count INTEGER NOT NULL DEFAULT 0 CHECK (returned_count >= 0),
    retained_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_count >= 0),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN (
        'credential_rejected', 'billing_required', 'invalid_request',
        'rate_limited', 'provider_unavailable', 'response_too_large',
        'request_timed_out', 'malformed_response', 'outcome_unknown', 'cancelled'
    )),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id, source_key),
    UNIQUE (community_id, run_id, position),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE,
    CHECK ((status = 'pending' AND started_at IS NULL) OR started_at IS NOT NULL),
    CHECK ((status IN ('pending', 'active') AND finished_at IS NULL) OR finished_at IS NOT NULL)
);

-- Existing Outscraper runs predate source snapshots. Backfill them so they
-- remain readable and executable after the worker becomes capability-aware.
INSERT INTO discovery_run_source_plans (community_id, run_id, source_mode, source_keys, created_at)
SELECT community_id, id, 'waterfall', ARRAY['google_maps']::TEXT[], created_at
FROM discovery_runs;

INSERT INTO discovery_run_sources (
    community_id, run_id, source_key, provider, position, status,
    request_count, returned_count, retained_count, duplicate_count,
    started_at, finished_at, updated_at
)
SELECT
    r.community_id,
    r.id,
    'google_maps',
    'outscraper',
    0,
    CASE r.state
        WHEN 'queued' THEN 'pending'
        WHEN 'running' THEN 'active'
        WHEN 'succeeded' THEN 'completed'
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'failed'
    END,
    CASE WHEN c.sequence IS NULL THEN 0 ELSE 1 END,
    COALESCE(u.returned_count, 0),
    COALESCE(u.stored_count, 0),
    COALESCE(u.existing_count, 0),
    CASE WHEN r.state = 'queued' THEN NULL ELSE r.created_at END,
    CASE WHEN r.state IN ('queued', 'running') THEN NULL ELSE r.updated_at END,
    r.updated_at
FROM discovery_runs r
LEFT JOIN LATERAL (
    SELECT sequence
    FROM discovery_run_checkpoints
    WHERE community_id=r.community_id AND run_id=r.id
      AND checkpoint_kind='provider_submitted'
    ORDER BY sequence
    LIMIT 1
) c ON TRUE
LEFT JOIN discovery_usage u
  ON u.community_id=r.community_id AND u.run_id=r.id;

ALTER TABLE discovery_run_checkpoints
    DROP CONSTRAINT discovery_run_checkpoints_provider_check,
    ADD CONSTRAINT discovery_run_checkpoints_provider_check
        CHECK (provider IN ('outscraper', 'brave_search', 'exa_search'));

ALTER TABLE discovery_business_observations
    DROP CONSTRAINT discovery_business_observations_provider_check,
    ADD CONSTRAINT discovery_business_observations_provider_check
        CHECK (provider IN ('outscraper', 'brave_search', 'exa_search')),
    ADD COLUMN description TEXT CHECK (
        description IS NULL OR (
            octet_length(description) BETWEEN 1 AND 2048
            AND description = btrim(description)
            AND description !~ '[[:cntrl:]]'
        )
    );

ALTER TABLE discovery_usage
    DROP CONSTRAINT discovery_usage_provider_check,
    ADD CONSTRAINT discovery_usage_provider_check
        CHECK (provider IN ('outscraper', 'brave_search', 'exa_search'));

ALTER TABLE discovery_usage
    DROP CONSTRAINT discovery_usage_pkey,
    ADD CONSTRAINT discovery_usage_pkey PRIMARY KEY (community_id, run_id, provider);

ALTER TABLE discovery_observation_batches
    ADD COLUMN provider TEXT NOT NULL DEFAULT 'outscraper'
        CHECK (provider IN ('outscraper', 'brave_search', 'exa_search'));

ALTER TABLE discovery_observation_batches
    DROP CONSTRAINT discovery_observation_batches_pkey,
    ADD CONSTRAINT discovery_observation_batches_pkey
        PRIMARY KEY (community_id, run_id, provider, provider_request_id, batch_index);

ALTER TABLE discovery_workspace_action_claims
    DROP CONSTRAINT discovery_workspace_action_claims_operation_check,
    ADD CONSTRAINT discovery_workspace_action_claims_operation_check CHECK (operation IN (
        'access', 'create_campaign', 'update_campaign_sources',
        'get_campaign', 'list_campaigns', 'list_leads'
    ));
