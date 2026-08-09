-- Deployment-wide operator analytics read model.
--
-- The activity tables are rebuildable, community-scoped projections. The
-- access log is deliberately the only deployment-global object introduced by
-- this migration; it stores digests rather than raw filters or targets.

CREATE TABLE operator_activity_daily (
    community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    utc_day             DATE NOT NULL,
    pubkey              BYTEA NOT NULL CHECK (length(pubkey) = 32),
    activity_family     TEXT NOT NULL CHECK (
        activity_family IN (
            'message', 'thread', 'reaction', 'channel',
            'command', 'workflow', 'git', 'huddle'
        )
    ),
    event_count         BIGINT NOT NULL CHECK (event_count > 0),
    first_activity_at   TIMESTAMPTZ NOT NULL,
    last_activity_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community_id, utc_day, pubkey, activity_family),
    CHECK (first_activity_at <= last_activity_at)
);

CREATE INDEX operator_activity_daily_day_idx
    ON operator_activity_daily (community_id, utc_day);
CREATE INDEX operator_activity_daily_person_idx
    ON operator_activity_daily (community_id, pubkey, utc_day);
CREATE INDEX operator_activity_daily_deployment_idx
    ON operator_activity_daily (utc_day, pubkey, community_id);

CREATE TABLE operator_activity_cursor (
    community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    last_created_at       TIMESTAMPTZ,
    last_event_id         BYTEA CHECK (last_event_id IS NULL OR length(last_event_id) = 32),
    definitions_version   TEXT NOT NULL CHECK (definitions_version = 'v1'),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id),
    CHECK ((last_created_at IS NULL) = (last_event_id IS NULL))
);

CREATE TABLE operator_access_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id      UUID NOT NULL,
    operator_pubkey BYTEA NOT NULL CHECK (length(operator_pubkey) = 32),
    route           TEXT NOT NULL,
    filter_digest   BYTEA CHECK (filter_digest IS NULL OR length(filter_digest) = 32),
    target_digest   BYTEA CHECK (target_digest IS NULL OR length(target_digest) = 32),
    outcome         TEXT NOT NULL CHECK (
        outcome IN ('success', 'invalid_filter', 'source_error', 'forbidden')
    ),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('operator_access_log', 'deployment-wide operator accountability; filter and target values are stored only as digests');
