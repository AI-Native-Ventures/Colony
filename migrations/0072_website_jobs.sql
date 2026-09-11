-- Website Manager jobs: the canonical, durable review state for one website
-- job, plus the append-only action claims that make retries once-only.
--
-- A website job is bound to an existing canonical CompanyTask and its thread:
-- `(community_id, task_id)` is unique, so two clients preparing a creation for
-- the same task cannot open two jobs. The row is the authority; the relay-signed
-- kind:30203 head is a projection of `review`, and kind:40028 receipts carry the
-- committed generation back to the actor that requested the transition.
--
-- `generation` is the compare-and-set stamp. Every mutation is conditional on
-- the generation the actor observed, so a stale concurrent revision or owner
-- decision matches no row and is refused instead of silently overwriting newer
-- work. `head_at` is strictly increasing for the same reason jobs and
-- workspace tabs use it: NIP-33 resolves replaceable heads by `created_at` at
-- one-second resolution, and two transitions in one second are ordinary here.
--
-- The review record itself is bounded JSONB (`MAX_REVIEW_BYTES` = 192 KiB):
-- revision artifact refs, QA evidence, decisions, and handover history. Raw
-- manifest bytes never live here; they are fetched and hash-verified by the
-- broker.
CREATE TABLE IF NOT EXISTS website_jobs (
    community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    job_id            UUID NOT NULL,
    -- Canonical CompanyTask id; unique per community so a task owns one job.
    task_id           TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
    channel_id        UUID NOT NULL,
    -- Root event id of the job thread; the review card instance lives here.
    thread_root       TEXT NOT NULL CHECK (thread_root ~ '^[0-9a-f]{64}$'),
    -- Coordinator-authored Block instance event id for the review card. It is
    -- deliberately distinct from `thread_root`: the human's ordinary message
    -- roots the thread and the agent posts the review card inside it.
    instance_event_id BYTEA NOT NULL CHECK (octet_length(instance_event_id) = 32),
    -- Block manifest event id the review-card instance pins.
    manifest_event_id BYTEA NOT NULL CHECK (octet_length(manifest_event_id) = 32),
    -- Pinned owner pubkey with approval authority; never trusted from content.
    owner             BYTEA NOT NULL CHECK (octet_length(owner) = 32),
    -- Pinned coordinator (the Website Manager agent); owns the Block instance.
    coordinator       BYTEA NOT NULL CHECK (octet_length(coordinator) = 32),
    source_url        TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
    status            TEXT NOT NULL CHECK (status IN (
                          'draft', 'working', 'readyForReview',
                          'approved', 'changesRequested', 'handedOver')),
    current_revision  INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    -- Exact compact JSON bytes of the `colony.website-review/v1` record. BYTEA,
    -- not JSONB: core measures `MAX_REVIEW_BYTES` on compact serialized bytes,
    -- and JSONB::text re-spaces the document, so a JSONB check would refuse a
    -- core-valid record at the database boundary.
    review            BYTEA NOT NULL CHECK (octet_length(review) <= 196608),
    -- Assigned persona ids per role. Authorization for revisions, QA, and
    -- evidence keys off these lists, never off the action's claimed identity.
    research_personas TEXT[] NOT NULL DEFAULT '{}',
    build_personas    TEXT[] NOT NULL DEFAULT '{}',
    review_personas   TEXT[] NOT NULL DEFAULT '{}',
    head_event_id     BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    -- Row compare-and-set generation; every mutation names the observed value.
    generation        BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
    head_at           BIGINT NOT NULL,
    created_at        BIGINT NOT NULL,
    updated_at        BIGINT NOT NULL,
    PRIMARY KEY (community_id, job_id),
    UNIQUE (community_id, task_id),
    FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS website_jobs_channel_idx
    ON website_jobs (community_id, channel_id);

-- One row per applied action. The primary key is the per-actor request UUID:
-- a retry that reuses it returns the recorded head and receipt instead of
-- applying twice, while a replay that carries a different canonical payload
-- digest is refused as a conflict. `action_event_id` is unique so the exact
-- same signed event can never be claimed twice through a different request.
CREATE TABLE IF NOT EXISTS website_actions (
    community_id     UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor            BYTEA NOT NULL CHECK (octet_length(actor) = 32),
    request_id       UUID NOT NULL,
    job_id           UUID NOT NULL,
    action_event_id  BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    op               TEXT NOT NULL CHECK (length(op) BETWEEN 1 AND 64),
    payload_digest   BYTEA NOT NULL CHECK (octet_length(payload_digest) = 32),
    head_event_id    BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    generation       BIGINT NOT NULL CHECK (generation > 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, actor, request_id),
    UNIQUE (community_id, action_event_id),
    FOREIGN KEY (community_id, job_id)
        REFERENCES website_jobs (community_id, job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS website_actions_job_idx
    ON website_actions (community_id, job_id);

-- Community-scoped tables must carry the write fence, or a write can outlive
-- the community it belongs to. schema.sql (which CI provisions from) declares
-- this separately, so a fence added there and not here leaves a
-- migration-built database unfenced.
SELECT attach_community_write_fence('website_jobs'::REGCLASS);
SELECT attach_community_write_fence('website_actions'::REGCLASS);
