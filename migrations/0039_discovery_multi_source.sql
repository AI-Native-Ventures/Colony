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

-- V1 relays omit this column. The database uses that explicit default to seed
-- only safe Outscraper plans during a rolling deploy or rollback; V2 writers
-- always store version two.
ALTER TABLE discovery_runs
    ADD COLUMN discovery_protocol_version SMALLINT NOT NULL DEFAULT 1
        CHECK (discovery_protocol_version IN (1, 2)),
    ADD COLUMN lease_worker_protocol_version SMALLINT
        CHECK (lease_worker_protocol_version IN (1, 2)),
    ADD COLUMN lease_worker_protocol_claim_id UUID;

-- Every pre-0039 lease belongs to the released V1 worker contract. Preserve
-- those in-flight leases so their signed heartbeat/checkpoint/terminal actions
-- remain valid after the protocol fence becomes mandatory.
UPDATE discovery_runs
SET lease_worker_protocol_version=1,
    lease_worker_protocol_claim_id=claim_id
WHERE claim_id IS NOT NULL;

CREATE FUNCTION discovery_guard_active_campaign_run() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.state NOT IN ('queued','running') THEN
        RETURN NEW;
    END IF;
    PERFORM id FROM discovery_campaigns
    WHERE community_id=NEW.community_id AND id=NEW.campaign_id
    FOR UPDATE;
    -- Migration 0038 did not enforce one active row in the database, so a
    -- populated workspace can contain duplicate legacy runs. Let those rows
    -- drain one lease at a time without permitting any new duplicate run.
    IF TG_OP='UPDATE' THEN
        IF OLD.state IN ('queued','running')
           AND OLD.community_id=NEW.community_id
           AND OLD.campaign_id=NEW.campaign_id
        THEN
            IF NEW.claim_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM discovery_runs
                WHERE community_id=NEW.community_id AND campaign_id=NEW.campaign_id
                  AND state IN ('queued','running') AND id <> NEW.id
                  AND claim_id IS NOT NULL AND lease_until >= now()
            ) THEN
                RETURN NULL;
            END IF;
            RETURN NEW;
        END IF;
    END IF;
    IF EXISTS (
        SELECT 1 FROM discovery_runs
        WHERE community_id=NEW.community_id AND campaign_id=NEW.campaign_id
          AND state IN ('queued','running') AND id <> NEW.id
    ) THEN
        RAISE EXCEPTION 'Discovery campaign already has an active run'
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_guard_active_campaign_run
BEFORE INSERT OR UPDATE OF state,community_id,campaign_id ON discovery_runs
FOR EACH ROW EXECUTE FUNCTION discovery_guard_active_campaign_run();

-- Released workers do not know about multi-source runs and omit these markers.
-- Bind the worker protocol to the exact claim ID so an expired V2 lease cannot
-- leave behind a marker that authorizes a subsequent V1 worker reclaim.
CREATE FUNCTION discovery_guard_lease_worker_protocol() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.claim_id IS NULL THEN
        NEW.lease_worker_protocol_version := NULL;
        NEW.lease_worker_protocol_claim_id := NULL;
        RETURN NEW;
    END IF;
    IF NEW.lease_worker_protocol_version=2
       AND NEW.lease_worker_protocol_claim_id=NEW.claim_id
    THEN
        RETURN NEW;
    END IF;
    NEW.lease_worker_protocol_version := 1;
    NEW.lease_worker_protocol_claim_id := NEW.claim_id;
    IF NEW.discovery_protocol_version=2 THEN
        RAISE EXCEPTION
            'Discovery protocol V1 worker cannot claim a protocol V2 run'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_guard_lease_worker_protocol
BEFORE INSERT OR UPDATE OF claim_id,discovery_protocol_version,
    lease_worker_protocol_version,lease_worker_protocol_claim_id
ON discovery_runs
FOR EACH ROW EXECUTE FUNCTION discovery_guard_lease_worker_protocol();

CREATE TABLE discovery_workspace_protocols (
    community_id UUID NOT NULL PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
    multi_source_adopted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION discovery_guard_multi_source_adoption() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.community_id::TEXT, 0));
    IF EXISTS (
        SELECT 1 FROM discovery_runs
        WHERE community_id=NEW.community_id
          AND discovery_protocol_version=1
          AND state IN ('queued','running')
    ) THEN
        RAISE EXCEPTION
            'Discovery protocol V1 runs must finish before multi-source adoption'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_guard_multi_source_adoption
BEFORE INSERT ON discovery_workspace_protocols
FOR EACH ROW EXECUTE FUNCTION discovery_guard_multi_source_adoption();

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

CREATE FUNCTION discovery_seed_legacy_run_plan() RETURNS TRIGGER AS $$
DECLARE
    campaign_mode TEXT;
    campaign_sources TEXT[];
BEGIN
    IF NEW.discovery_protocol_version <> 1 THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.community_id::TEXT, 0));
    SELECT source_mode, source_keys INTO campaign_mode, campaign_sources
    FROM discovery_campaigns
    WHERE community_id=NEW.community_id AND id=NEW.campaign_id;
    IF campaign_mode <> 'waterfall'
       OR campaign_sources <> ARRAY['google_maps']::TEXT[]
       OR EXISTS (
           SELECT 1 FROM discovery_workspace_protocols
           WHERE community_id=NEW.community_id
       )
    THEN
        RAISE EXCEPTION
            'Discovery protocol V1 cannot safely start this workspace; update Colony'
            USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO discovery_run_source_plans (
        community_id, run_id, source_mode, source_keys, created_at
    ) VALUES (
        NEW.community_id, NEW.id, 'waterfall', ARRAY['google_maps']::TEXT[], NEW.created_at
    );
    INSERT INTO discovery_run_sources (
        community_id, run_id, source_key, provider, position, status, updated_at
    ) VALUES (
        NEW.community_id, NEW.id, 'google_maps', 'outscraper', 0, 'pending', NEW.updated_at
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_seed_legacy_run_plan
AFTER INSERT ON discovery_runs
FOR EACH ROW EXECUTE FUNCTION discovery_seed_legacy_run_plan();

CREATE FUNCTION discovery_sync_legacy_run_source() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.discovery_protocol_version <> 1 OR NEW.state = OLD.state THEN
        RETURN NEW;
    END IF;
    UPDATE discovery_run_sources SET
        status=CASE NEW.state
            WHEN 'queued' THEN 'pending'
            WHEN 'running' THEN 'active'
            WHEN 'succeeded' THEN CASE WHEN returned_count=0 THEN 'exhausted' ELSE 'completed' END
            WHEN 'cancelled' THEN 'cancelled'
            ELSE 'failed'
        END,
        failure_class=CASE WHEN NEW.state='cancelled' THEN 'cancelled' ELSE NULL END,
        started_at=CASE WHEN NEW.state='queued' THEN started_at ELSE COALESCE(started_at,NEW.updated_at) END,
        finished_at=CASE WHEN NEW.state IN ('succeeded','cancelled','failed')
                         THEN COALESCE(finished_at,NEW.updated_at) ELSE NULL END,
        updated_at=NEW.updated_at
    WHERE community_id=NEW.community_id AND run_id=NEW.id AND provider='outscraper';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_sync_legacy_run_source
AFTER UPDATE OF state ON discovery_runs
FOR EACH ROW EXECUTE FUNCTION discovery_sync_legacy_run_source();

CREATE FUNCTION discovery_sync_legacy_checkpoint_source() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.provider='outscraper' AND EXISTS (
           SELECT 1 FROM discovery_runs
           WHERE community_id=NEW.community_id AND id=NEW.run_id
             AND discovery_protocol_version=1
       )
    THEN
        UPDATE discovery_run_sources SET
            status=CASE
                WHEN NEW.checkpoint_kind='provider_submitted' AND status='pending' THEN 'active'
                ELSE status
            END,
            request_count=CASE
                WHEN NEW.checkpoint_kind='provider_submitted' THEN GREATEST(request_count,1)
                ELSE request_count
            END,
            returned_count=CASE
                WHEN NEW.checkpoint_kind='provider_results_ready'
                    THEN GREATEST(returned_count,COALESCE(NEW.item_count,0))
                ELSE returned_count
            END,
            started_at=COALESCE(started_at,now()), updated_at=now()
        WHERE community_id=NEW.community_id AND run_id=NEW.run_id
          AND provider='outscraper';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_sync_legacy_checkpoint_source
AFTER INSERT ON discovery_run_checkpoints
FOR EACH ROW EXECUTE FUNCTION discovery_sync_legacy_checkpoint_source();

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
    ),
    ADD COLUMN canonical_domain_digest BYTEA CHECK (
        canonical_domain_digest IS NULL OR octet_length(canonical_domain_digest) = 32
    ),
    ADD COLUMN normalized_phone_digest BYTEA CHECK (
        normalized_phone_digest IS NULL OR octet_length(normalized_phone_digest) = 32
    ),
    ADD COLUMN normalized_name_locality_digest BYTEA CHECK (
        normalized_name_locality_digest IS NULL
        OR octet_length(normalized_name_locality_digest) = 32
    ),
    ADD COLUMN dedupe_digest_version SMALLINT NOT NULL DEFAULT 0
        CHECK (dedupe_digest_version IN (0, 1));

CREATE FUNCTION discovery_guard_legacy_observation_insert() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.dedupe_digest_version = 0 OR NEW.provider <> 'outscraper' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.community_id::TEXT, 0));
    END IF;
    IF NEW.dedupe_digest_version = 0 THEN
        IF EXISTS (
            SELECT 1 FROM discovery_workspace_protocols
            WHERE community_id=NEW.community_id
        ) THEN
            RAISE EXCEPTION
                'Discovery protocol V1 cannot safely store observations after multi-source adoption; update Colony'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.provider <> 'outscraper' AND NOT EXISTS (
        SELECT 1 FROM discovery_workspace_protocols
        WHERE community_id=NEW.community_id
    ) THEN
        RAISE EXCEPTION
            'Discovery multi-source execution must be adopted before storing provider observations'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_guard_legacy_observation_insert
BEFORE INSERT ON discovery_business_observations
FOR EACH ROW EXECUTE FUNCTION discovery_guard_legacy_observation_insert();

-- Existing paid records are backfilled after SQL migration by the exact Rust
-- normalization functions used for new observations. SQL URL/Unicode/phone
-- approximations would create different identities and allow rediscovery.
-- Keep the database default at zero so an overlapping or rolled-back V1 relay
-- cannot silently mark an unnormalized row as current. V2 writers explicitly
-- store version one with their exact Rust-computed digests.

CREATE INDEX discovery_business_observations_domain_dedupe_idx
    ON discovery_business_observations (community_id, canonical_domain_digest)
    WHERE canonical_domain_digest IS NOT NULL;

CREATE INDEX discovery_business_observations_phone_dedupe_idx
    ON discovery_business_observations (community_id, normalized_phone_digest)
    WHERE normalized_phone_digest IS NOT NULL;

CREATE INDEX discovery_business_observations_name_locality_dedupe_idx
    ON discovery_business_observations (community_id, normalized_name_locality_digest)
    WHERE normalized_name_locality_digest IS NOT NULL;

-- Keep the released Outscraper-only table and its (community_id, run_id)
-- conflict target intact for rolling deploys and rollback. Multi-source code
-- owns this provider-aware table instead.
CREATE TABLE discovery_source_usage (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    provider TEXT NOT NULL
        CHECK (provider IN ('outscraper', 'brave_search', 'exa_search')),
    provider_request_id TEXT NOT NULL CHECK (
        octet_length(provider_request_id) BETWEEN 1 AND 128
        AND provider_request_id ~ '^[A-Za-z0-9_-]+$'
    ),
    stored_count INTEGER NOT NULL DEFAULT 0 CHECK (stored_count >= 0),
    existing_count INTEGER NOT NULL DEFAULT 0 CHECK (existing_count >= 0),
    returned_count INTEGER CHECK (returned_count IS NULL OR returned_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id, provider),
    UNIQUE (community_id, provider, provider_request_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

INSERT INTO discovery_source_usage (
    community_id, run_id, provider, provider_request_id,
    stored_count, existing_count, returned_count, updated_at
)
SELECT community_id, run_id, provider, provider_request_id,
       stored_count, existing_count, returned_count, updated_at
FROM discovery_usage;

CREATE FUNCTION discovery_sync_legacy_usage_to_source() RETURNS TRIGGER AS $$
DECLARE
    affected BIGINT;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    INSERT INTO discovery_source_usage (
        community_id, run_id, provider, provider_request_id,
        stored_count, existing_count, returned_count, updated_at
    ) VALUES (
        NEW.community_id, NEW.run_id, NEW.provider, NEW.provider_request_id,
        NEW.stored_count, NEW.existing_count, NEW.returned_count, NEW.updated_at
    )
    ON CONFLICT (community_id, run_id, provider) DO UPDATE SET
        stored_count=EXCLUDED.stored_count,
        existing_count=EXCLUDED.existing_count,
        returned_count=COALESCE(EXCLUDED.returned_count,discovery_source_usage.returned_count),
        updated_at=GREATEST(EXCLUDED.updated_at,discovery_source_usage.updated_at)
    WHERE discovery_source_usage.provider_request_id=EXCLUDED.provider_request_id
      AND discovery_source_usage.stored_count <= EXCLUDED.stored_count
      AND discovery_source_usage.existing_count <= EXCLUDED.existing_count
      AND (EXCLUDED.returned_count IS NULL
           OR discovery_source_usage.returned_count IS NULL
           OR discovery_source_usage.returned_count<=EXCLUDED.returned_count);
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'conflicting legacy Discovery usage mirror'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    UPDATE discovery_run_sources SET
        returned_count=COALESCE(NEW.returned_count,returned_count),
        retained_count=NEW.stored_count,
        duplicate_count=NEW.existing_count,
        status=CASE
            WHEN status='exhausted' AND COALESCE(NEW.returned_count,0)>0 THEN 'completed'
            ELSE status
        END,
        updated_at=GREATEST(updated_at,NEW.updated_at)
    WHERE community_id=NEW.community_id AND run_id=NEW.run_id AND provider='outscraper';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_legacy_usage_to_source
AFTER INSERT OR UPDATE ON discovery_usage
FOR EACH ROW EXECUTE FUNCTION discovery_sync_legacy_usage_to_source();

CREATE FUNCTION discovery_sync_source_usage_to_legacy() RETURNS TRIGGER AS $$
DECLARE
    affected BIGINT;
BEGIN
    IF pg_trigger_depth() > 1 OR NEW.provider <> 'outscraper' THEN
        RETURN NEW;
    END IF;
    INSERT INTO discovery_usage (
        community_id, run_id, provider, provider_request_id,
        stored_count, existing_count, returned_count, updated_at
    ) VALUES (
        NEW.community_id, NEW.run_id, NEW.provider, NEW.provider_request_id,
        NEW.stored_count, NEW.existing_count, NEW.returned_count, NEW.updated_at
    )
    ON CONFLICT (community_id, run_id) DO UPDATE SET
        stored_count=EXCLUDED.stored_count,
        existing_count=EXCLUDED.existing_count,
        returned_count=COALESCE(EXCLUDED.returned_count,discovery_usage.returned_count),
        updated_at=GREATEST(EXCLUDED.updated_at,discovery_usage.updated_at)
    WHERE discovery_usage.provider=EXCLUDED.provider
      AND discovery_usage.provider_request_id=EXCLUDED.provider_request_id
      AND discovery_usage.stored_count <= EXCLUDED.stored_count
      AND discovery_usage.existing_count <= EXCLUDED.existing_count
      AND (EXCLUDED.returned_count IS NULL
           OR discovery_usage.returned_count IS NULL
           OR discovery_usage.returned_count<=EXCLUDED.returned_count);
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'conflicting provider Discovery usage mirror'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_source_usage_to_legacy
AFTER INSERT OR UPDATE ON discovery_source_usage
FOR EACH ROW EXECUTE FUNCTION discovery_sync_source_usage_to_legacy();

ALTER TABLE discovery_observation_batches
    ADD COLUMN provider TEXT NOT NULL DEFAULT 'outscraper'
        CHECK (provider IN ('outscraper', 'brave_search', 'exa_search'));

CREATE TABLE discovery_source_observation_batches (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    provider TEXT NOT NULL
        CHECK (provider IN ('outscraper', 'brave_search', 'exa_search')),
    provider_request_id TEXT NOT NULL CHECK (
        octet_length(provider_request_id) BETWEEN 1 AND 128
        AND provider_request_id ~ '^[A-Za-z0-9_-]+$'
    ),
    batch_index SMALLINT NOT NULL CHECK (batch_index BETWEEN 0 AND 19),
    batch_fingerprint BYTEA NOT NULL CHECK (octet_length(batch_fingerprint) = 32),
    accepted_count SMALLINT NOT NULL CHECK (accepted_count BETWEEN 0 AND 25),
    existing_count SMALLINT NOT NULL CHECK (existing_count BETWEEN 0 AND 25),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id, provider, provider_request_id, batch_index),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE,
    CHECK (accepted_count + existing_count BETWEEN 1 AND 25)
);

INSERT INTO discovery_source_observation_batches (
    community_id, run_id, provider, provider_request_id, batch_index,
    batch_fingerprint, accepted_count, existing_count, created_at
)
SELECT community_id, run_id, provider, provider_request_id, batch_index,
       batch_fingerprint, accepted_count, existing_count, created_at
FROM discovery_observation_batches;

CREATE FUNCTION discovery_sync_legacy_batch_to_source() RETURNS TRIGGER AS $$
DECLARE
    affected BIGINT;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    INSERT INTO discovery_source_observation_batches (
        community_id, run_id, provider, provider_request_id, batch_index,
        batch_fingerprint, accepted_count, existing_count, created_at
    ) VALUES (
        NEW.community_id, NEW.run_id, NEW.provider, NEW.provider_request_id, NEW.batch_index,
        NEW.batch_fingerprint, NEW.accepted_count, NEW.existing_count, NEW.created_at
    ) ON CONFLICT (community_id, run_id, provider, provider_request_id, batch_index)
      DO UPDATE SET batch_fingerprint=EXCLUDED.batch_fingerprint
      WHERE discovery_source_observation_batches.batch_fingerprint=EXCLUDED.batch_fingerprint
        AND discovery_source_observation_batches.accepted_count=EXCLUDED.accepted_count
        AND discovery_source_observation_batches.existing_count=EXCLUDED.existing_count;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'conflicting legacy Discovery observation batch mirror'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_legacy_batch_to_source
AFTER INSERT ON discovery_observation_batches
FOR EACH ROW EXECUTE FUNCTION discovery_sync_legacy_batch_to_source();

CREATE FUNCTION discovery_sync_source_batch_to_legacy() RETURNS TRIGGER AS $$
DECLARE
    affected BIGINT;
BEGIN
    IF pg_trigger_depth() > 1 OR NEW.provider <> 'outscraper' THEN
        RETURN NEW;
    END IF;
    INSERT INTO discovery_observation_batches (
        community_id, run_id, provider, provider_request_id, batch_index,
        batch_fingerprint, accepted_count, existing_count, created_at
    ) VALUES (
        NEW.community_id, NEW.run_id, NEW.provider, NEW.provider_request_id, NEW.batch_index,
        NEW.batch_fingerprint, NEW.accepted_count, NEW.existing_count, NEW.created_at
    ) ON CONFLICT (community_id, run_id, provider_request_id, batch_index)
      DO UPDATE SET batch_fingerprint=EXCLUDED.batch_fingerprint
      WHERE discovery_observation_batches.provider=EXCLUDED.provider
        AND discovery_observation_batches.batch_fingerprint=EXCLUDED.batch_fingerprint
        AND discovery_observation_batches.accepted_count=EXCLUDED.accepted_count
        AND discovery_observation_batches.existing_count=EXCLUDED.existing_count;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'conflicting provider Discovery observation batch mirror'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_discovery_source_batch_to_legacy
AFTER INSERT ON discovery_source_observation_batches
FOR EACH ROW EXECUTE FUNCTION discovery_sync_source_batch_to_legacy();

ALTER TABLE discovery_workspace_action_claims
    DROP CONSTRAINT discovery_workspace_action_claims_operation_check,
    ADD CONSTRAINT discovery_workspace_action_claims_operation_check CHECK (operation IN (
        'access', 'create_campaign', 'update_campaign_sources',
        'get_campaign', 'list_campaigns', 'list_leads'
    ));
