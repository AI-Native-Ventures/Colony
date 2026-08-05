-- 0042: interrupt asks projection.
-- One row per open Ask event; the relay's interrupt sweep and the future
-- Open Issues surface read this instead of scanning events.
CREATE TABLE IF NOT EXISTS asks (
    community_id     UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    ask_event_id     BYTEA NOT NULL,
    ask_type         TEXT NOT NULL CHECK (ask_type IN ('decision','question','credential','blocker','stall')),
    initiative_id    TEXT NOT NULL,
    need_key         TEXT NOT NULL,
    audience_pubkey  BYTEA NOT NULL,
    filer_pubkey     BYTEA NOT NULL,
    origin_thread    BYTEA,
    prior_ask        BYTEA,
    category         TEXT,
    default_option   TEXT,
    deadline_at      BIGINT,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','withdrawn','promoted')),
    resolution_event BYTEA,
    resolved_by      BYTEA,
    default_executed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL,
    PRIMARY KEY (community_id, ask_event_id)
);
-- Dedupe: at most one OPEN ask per (community, initiative, need).
CREATE UNIQUE INDEX IF NOT EXISTS asks_open_need_uniq
    ON asks (community_id, initiative_id, need_key) WHERE status = 'open';
-- No community_id predicate: the interrupt sweep scans due asks across every
-- community (see query_due_asks), so this index leads with deadline_at to
-- give that cross-tenant scan a real range scan instead of a full scan.
CREATE INDEX IF NOT EXISTS asks_due_idx ON asks (deadline_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS asks_audience_idx ON asks (community_id, audience_pubkey) WHERE status = 'open';
