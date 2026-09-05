-- Buzz initial Postgres schema — multi-tenant.
--
-- Source of truth for fresh database setup. This is a clean, from-scratch
-- schema in which `community_id` is a first-class, server-resolved key on
-- every tenant-scoped row. It is NOT additive over the single-community
-- schema; the rewrite replaces it. Existing single-community deployments
-- migrate via the documented backfill migration (0002), which assigns all
-- pre-existing rows to one default community.
--
-- The governing contract is docs/multi-tenant-conformance.md. Every table
-- below cites the conformance surface it implements. The invariant behind the
-- whole schema (conformance "row zero"): a request's community is resolved
-- from the connection host by the server, never supplied by the client, and
-- every scoped row carries that immutable `community_id`.
--
-- Migration-lint obligations enforced by the Lane 0 lint harness:
--   1. Every tenant-scoped table has `community_id NOT NULL`.
--   2. No UNIQUE / PRIMARY KEY / FK on a scoped table is observable across
--      communities: each leads with `community_id` (or, for child rows whose
--      parent already pins the community, joins carry the community tuple).
--   3. `channels.community_id` is immutable (trigger below; no UPDATE path).
--   4. Operator-global tables are named in the explicit allowlist, not implied.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Custom types ──────────────────────────────────────────────────────────────

CREATE TYPE channel_type AS ENUM ('stream', 'forum', 'dm', 'workflow');
CREATE TYPE channel_visibility AS ENUM ('open', 'private');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member', 'guest', 'bot');
CREATE TYPE workflow_status AS ENUM ('active', 'disabled', 'archived');
CREATE TYPE run_status AS ENUM ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled');
CREATE TYPE approval_status AS ENUM ('pending', 'granted', 'denied', 'expired');
CREATE TYPE delivery_method AS ENUM ('webhook', 'websocket');
CREATE TYPE subscription_status AS ENUM ('active', 'paused', 'deleted');
CREATE TYPE pause_reason AS ENUM ('user', 'system', 'rate_limit');
CREATE TYPE channel_add_policy AS ENUM ('anyone', 'owner_only', 'nobody');

-- ── Communities ───────────────────────────────────────────────────────────────
-- Conformance: row zero (host binding). The host map. `resolve_host(host)`
-- reads exactly one row here to mint the request's TenantContext. This table
-- is OPERATOR-GLOBAL: it is the registry of tenants, not itself tenant-scoped,
-- so it carries no `community_id` of its own (its `id` IS the community key).
-- Listed in the lint allowlist as operator-global.
--
-- Host normalization (Lane 0 contract): `host` is stored already-normalized —
-- ASCII-lowercased, trailing dot stripped, default port omitted. The UNIQUE is
-- on `lower(host)` belt-and-suspenders so `Relay.Example` and `relay.example`
-- can never become two tenants even if a writer forgets to normalize.
-- `resolve_host()` (buzz-core) applies the identical normalization before
-- lookup, so resolution and storage agree by construction.

CREATE TABLE communities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host            VARCHAR(255) NOT NULL,
    signing_key     BYTEA,
    icon            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at     TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    deletion_state  TEXT NOT NULL DEFAULT 'active'
        CHECK (deletion_state IN ('active', 'quiescing', 'fenced', 'tombstone')),
    deletion_fence_generation BIGINT NOT NULL DEFAULT 0
        CHECK (deletion_fence_generation >= 0),
    CONSTRAINT chk_communities_id_not_nil CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE UNIQUE INDEX idx_communities_host ON communities (lower(host));

-- ── Channels ──────────────────────────────────────────────────────────────────
-- Conformance: "Channels and channel membership". `community_id` immutable.
-- Channel UUIDs stay valid wire identifiers, but they are NOT globally unique:
-- the PK is `(community_id, id)`, so the same UUID may legitimately exist in two
-- communities (conformance lists "same channel UUID collision in two
-- communities" as a required isolation test). Handlers always carry `ctx`, so
-- `(ctx.community, h)` names exactly one channel; a client-supplied `h` can
-- never reach another community's channel.

CREATE TABLE channels (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    community_id    UUID NOT NULL REFERENCES communities(id),
    name            VARCHAR(255) NOT NULL,
    channel_type    channel_type NOT NULL DEFAULT 'stream',
    visibility      channel_visibility NOT NULL DEFAULT 'open',
    description     TEXT,
    created_by      BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at     TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    nip29_group_id  VARCHAR(255),
    topic_required  BOOLEAN NOT NULL DEFAULT FALSE,
    max_members     INT,
    topic           TEXT,
    topic_set_by    BYTEA,
    topic_set_at    TIMESTAMPTZ,
    purpose         TEXT,
    purpose_set_by  BYTEA,
    purpose_set_at  TIMESTAMPTZ,
    participant_hash BYTEA,
    ttl_seconds     INT,
    ttl_deadline    TIMESTAMPTZ,
    PRIMARY KEY (community_id, id),
    CONSTRAINT chk_channels_id_not_nil CHECK (id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

-- nip29 group id and DM participant hash are unique WITHIN a community, not globally.
CREATE UNIQUE INDEX idx_channels_nip29_group ON channels (community_id, nip29_group_id)
    WHERE nip29_group_id IS NOT NULL;
CREATE UNIQUE INDEX idx_channels_dm_hash ON channels (community_id, participant_hash)
    WHERE participant_hash IS NOT NULL;
CREATE INDEX idx_channels_community_type ON channels (community_id, channel_type);
CREATE INDEX idx_channels_community_visibility ON channels (community_id, visibility);
CREATE INDEX idx_channels_created_by ON channels (community_id, created_by);
CREATE INDEX idx_channels_ttl_expiry ON channels (ttl_deadline)
    WHERE ttl_seconds IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
-- Tenant-independent channel-id → community lookups (Db::communities_of_channels,
-- Db::community_of_channel) carry no community_id predicate, so no
-- community_id-leading index can serve them. Covering + partial: index-only scan.
-- Not UNIQUE — the same channel id may exist under more than one community.
CREATE INDEX idx_channels_id_live ON channels (id) INCLUDE (community_id)
    WHERE deleted_at IS NULL;

-- channels.community_id is immutable: a channel can never be re-tenanted.
-- (Conformance: "Migration lint forbids channel re-tenanting except through an
-- explicitly modeled admission path." We have no such path, so: hard block.)
CREATE FUNCTION channels_community_id_immutable() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.community_id IS DISTINCT FROM OLD.community_id THEN
        RAISE EXCEPTION 'channels.community_id is immutable (channel % cannot be re-tenanted)', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_channels_community_id_immutable
    BEFORE UPDATE ON channels
    FOR EACH ROW EXECUTE FUNCTION channels_community_id_immutable();

-- ── Channel members ───────────────────────────────────────────────────────────
-- Conformance: "Channels and channel membership". PK leads with community_id.

CREATE TABLE channel_members (
    community_id UUID NOT NULL REFERENCES communities(id),
    channel_id  UUID NOT NULL,
    pubkey      BYTEA NOT NULL,
    role        member_role NOT NULL DEFAULT 'member',
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invited_by  BYTEA,
    removed_at  TIMESTAMPTZ,
    removed_by  BYTEA,
    hidden_at   TIMESTAMPTZ,
    PRIMARY KEY (community_id, channel_id, pubkey),
    FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_channel_members_pubkey ON channel_members (community_id, pubkey)
    WHERE removed_at IS NULL;

-- ── Users ─────────────────────────────────────────────────────────────────────
-- Conformance: "Users, profiles, NIP-05, and user search". One profile per
-- (community, pubkey): the same key reposts kind:0 in each community it joins.

CREATE TABLE users (
    community_id        UUID NOT NULL REFERENCES communities(id),
    pubkey              BYTEA NOT NULL,
    nip05_handle        VARCHAR(255),
    display_name        VARCHAR(255),
    avatar_url          TEXT,
    about               TEXT,
    agent_type          VARCHAR(255),
    capabilities        JSONB,
    okta_user_id        VARCHAR(255),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deactivated_at      TIMESTAMPTZ,
    metadata_event_id   BYTEA,
    agent_owner_pubkey  BYTEA,
    channel_add_policy  channel_add_policy NOT NULL DEFAULT 'anyone',
    PRIMARY KEY (community_id, pubkey),
    CONSTRAINT chk_users_pubkey_len CHECK (LENGTH(pubkey) = 32),
    -- agent owner is a user in the SAME community.
    FOREIGN KEY (community_id, agent_owner_pubkey)
        REFERENCES users (community_id, pubkey) ON DELETE SET NULL
);

-- NIP-05 handle and Okta id unique within a community, not globally.
CREATE UNIQUE INDEX idx_users_nip05 ON users (community_id, lower(nip05_handle))
    WHERE nip05_handle IS NOT NULL;
CREATE UNIQUE INDEX idx_users_okta ON users (community_id, okta_user_id)
    WHERE okta_user_id IS NOT NULL;

-- ── Events (partitioned by month on created_at) ──────────────────────────────
-- Conformance: "Channel-less global events and DMs". `community_id` leads the
-- PK and every hot-path index. Partition stays BY RANGE (created_at) — the
-- monthly partition manager is unchanged (Max's call, plan §5/Lane0 contract).
-- Cross-community dedup: same signed event may exist in two communities;
-- (community_id, created_at, id) dedupes within one, allows across.

CREATE TABLE events (
    community_id UUID NOT NULL REFERENCES communities(id),
    id          BYTEA NOT NULL,
    pubkey      BYTEA NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL,
    kind        INT NOT NULL,
    tags        JSONB NOT NULL,
    content     TEXT NOT NULL,
    -- Full-text search vector (Typesense → Postgres FTS). Generated/STORED so
    -- it is a single source of truth — no sidecar indexer to keep coherent
    -- (Quinn option A, Lane-0 call). 'simple' config = no stemming/stopwords,
    -- matching the existing substring-ish search semantics; the search lane can
    -- revisit the config behind evidence. Tenant scoping is by the
    -- community-leading btree filters BitmapAnd-ed with the GIN probe, so the
    -- GIN index itself stays the minimal `GIN (search_tsv)` (Max's caveat:
    -- avoid btree_gin unless EXPLAIN proves it buys something).
    -- Privacy: encrypted/private routing wrappers and p-gated membership notices
    -- must never be discoverable through NIP-50 full-text search. NULL tsvector
    -- never matches `@@`.
    -- Keep in sync with migrations. The migrated final state (0008's positive
    -- allowlist, later wrapped by 0014/0037 exclusions that are no-ops under
    -- the allowlist) indexes exactly kinds 0, 9, 40002, 45001, 45003; every
    -- other kind stays NULL.
    search_tsv  TSVECTOR GENERATED ALWAYS AS (
        CASE WHEN kind IN (0, 9, 40002, 45001, 45003)
             THEN to_tsvector('simple', content)
             ELSE NULL::tsvector
        END
    ) STORED,
    sig         BYTEA NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    channel_id  UUID,
    deleted_at  TIMESTAMPTZ,
    d_tag       TEXT,
    not_before  BIGINT,
    delivered_at BIGINT,
    PRIMARY KEY (community_id, created_at, id)
) PARTITION BY RANGE (created_at);

CREATE TABLE events_p_past PARTITION OF events
    FOR VALUES FROM (MINVALUE) TO ('2026-01-01');
CREATE TABLE events_p2026_01 PARTITION OF events
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_p2026_02 PARTITION OF events
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE events_p2026_03 PARTITION OF events
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE events_p2026_04 PARTITION OF events
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE events_p2026_05 PARTITION OF events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE events_p2026_06 PARTITION OF events
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE events_p_future PARTITION OF events
    FOR VALUES FROM ('2026-07-01') TO (MAXVALUE);

-- Direct id lookup: the PK can't serve `WHERE id=$1` because created_at sits
-- between community_id and id. This index makes the scoped form
-- `WHERE community_id=$ AND id=$` index-served, not a partition scan.
CREATE INDEX idx_events_community_id ON events (community_id, id, created_at DESC);
-- Hot-path indexes, all community-leading.
CREATE INDEX idx_events_community_channel_created
    ON events (community_id, channel_id, created_at DESC, id);
CREATE INDEX idx_events_community_pubkey_kind_created
    ON events (community_id, pubkey, kind, created_at DESC, id);
CREATE INDEX idx_events_community_kind_created
    ON events (community_id, kind, created_at DESC, id);
CREATE INDEX idx_events_community_deleted ON events (community_id, deleted_at);
-- Addressable (replaceable) and NIP-33 parameterized lookups.
CREATE INDEX idx_events_addressable
    ON events (community_id, kind, pubkey, channel_id, deleted_at);
CREATE INDEX idx_events_parameterized
    ON events (community_id, kind, pubkey, d_tag, created_at DESC, id)
    WHERE d_tag IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_events_not_before ON events (community_id, not_before)
    WHERE not_before IS NOT NULL AND deleted_at IS NULL AND delivered_at IS NULL;
-- Full-text search. Minimal GIN over the generated tsvector; community scoping
-- is supplied by the community-leading btree filters above (BitmapAnd), so this
-- stays a single-column GIN. The search lane confirms the final spelling with
-- EXPLAIN before its work lands (Quinn option A; Max's index-spelling caveat).
CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);

-- E-tag containment lookups (migration 0004): tags @> '[["e","<hex>"]]' fan-out
-- resolves through this GIN; jsonb_path_ops supports exactly the @> operator
-- the query path uses. Partition children inherit it at ATTACH time.
CREATE INDEX idx_events_tags_gin ON events USING GIN (tags jsonb_path_ops);

-- ── Event mentions ────────────────────────────────────────────────────────────
-- Conformance: "Channel-less global events and DMs" (#p fan-out). The join to
-- events MUST carry the community tuple (e.community_id = m.community_id AND
-- e.id = m.event_id) — bare e.id = m.event_id would leak cross-community
-- mentions (Max, verified at event.rs:222).

CREATE TABLE event_mentions (
    community_id        UUID NOT NULL REFERENCES communities(id),
    pubkey_hex          VARCHAR(64) NOT NULL,
    event_id            BYTEA NOT NULL,
    event_created_at    TIMESTAMPTZ NOT NULL,
    channel_id          UUID,
    event_kind          INT,
    PRIMARY KEY (community_id, pubkey_hex, event_id)
);

CREATE INDEX idx_event_mentions_pubkey_created
    ON event_mentions (community_id, pubkey_hex, event_created_at DESC);
CREATE INDEX idx_event_mentions_pubkey_kind_created
    ON event_mentions (community_id, pubkey_hex, event_kind, event_created_at DESC);

-- Community-scoped mention join (migration 0007): the relay's per-community
-- mention hydration filters (community_id, event_id) directly.
CREATE INDEX idx_event_mentions_community_event
    ON event_mentions (community_id, event_id);

-- ── Subscriptions ─────────────────────────────────────────────────────────────
-- Conformance: "Mesh, agents, ACP/MCP, and CLI" (persisted subscriptions).

CREATE TABLE subscriptions (
    community_id        UUID NOT NULL REFERENCES communities(id),
    id                  VARCHAR(255) NOT NULL,
    owner_pubkey        BYTEA NOT NULL,
    filter_kinds        JSONB,
    filter_authors      JSONB,
    filter_channel_ids  JSONB,
    filter_since        TIMESTAMPTZ,
    filter_until        TIMESTAMPTZ,
    delivery_method     delivery_method NOT NULL DEFAULT 'webhook',
    delivery_url        TEXT,
    status              subscription_status NOT NULL DEFAULT 'active',
    pause_reason        pause_reason,
    delivered_count     BIGINT NOT NULL DEFAULT 0,
    error_count         BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, id),
    FOREIGN KEY (community_id, owner_pubkey) REFERENCES users (community_id, pubkey)
);

-- ── Delivery log (partitioned by month on delivered_at) ──────────────────────
-- Conformance: subscription delivery audit. community_id carried for tenant
-- attribution; child of subscriptions.

CREATE TABLE delivery_log (
    community_id    UUID NOT NULL REFERENCES communities(id),
    id              BIGINT GENERATED ALWAYS AS IDENTITY,
    subscription_id VARCHAR(255),
    event_id        BYTEA,
    method          delivery_method,
    delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    success         BOOLEAN,
    http_status     INT,
    error_message   TEXT,
    attempt_number  INT DEFAULT 1,
    PRIMARY KEY (delivered_at, id)
) PARTITION BY RANGE (delivered_at);

CREATE TABLE delivery_log_p_past PARTITION OF delivery_log
    FOR VALUES FROM (MINVALUE) TO ('2026-03-01');
CREATE TABLE delivery_log_p2026_03 PARTITION OF delivery_log
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE delivery_log_p2026_04 PARTITION OF delivery_log
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE delivery_log_p2026_05 PARTITION OF delivery_log
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE delivery_log_p2026_06 PARTITION OF delivery_log
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE delivery_log_p_future PARTITION OF delivery_log
    FOR VALUES FROM ('2026-07-01') TO (MAXVALUE);

CREATE INDEX idx_delivery_log_community_sub ON delivery_log (community_id, subscription_id);

-- ── Workflows ─────────────────────────────────────────────────────────────────
-- Conformance: "Workflows, runs, approvals, webhooks, schedules". Definition's
-- community fixed at create from req.community; runs/approvals inherit it.

CREATE TABLE workflows (
    community_id    UUID NOT NULL REFERENCES communities(id),
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    owner_pubkey    BYTEA NOT NULL,
    channel_id      UUID,
    definition      JSONB NOT NULL,
    definition_hash BYTEA NOT NULL,
    status          workflow_status NOT NULL DEFAULT 'active',
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, id),
    FOREIGN KEY (community_id, owner_pubkey) REFERENCES users (community_id, pubkey),
    FOREIGN KEY (community_id, channel_id) REFERENCES channels (community_id, id)
);

CREATE INDEX idx_workflows_channel_active ON workflows (community_id, channel_id, status, enabled);
-- Scheduler scans enabled schedule workflows; community_id returned per row so
-- side effects run under the owning tenant's context (Lane0 contract §4a.5).
CREATE INDEX idx_workflows_enabled ON workflows (enabled, status) WHERE enabled;

-- ── Workflow runs ─────────────────────────────────────────────────────────────

CREATE TABLE workflow_runs (
    community_id        UUID NOT NULL REFERENCES communities(id),
    id                  UUID NOT NULL DEFAULT gen_random_uuid(),
    workflow_id         UUID NOT NULL,
    status              run_status NOT NULL DEFAULT 'pending',
    trigger_event_id    BYTEA,
    current_step        INT NOT NULL DEFAULT 0,
    execution_trace     JSONB NOT NULL DEFAULT '[]',
    trigger_context     JSONB,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, id),
    FOREIGN KEY (community_id, workflow_id)
        REFERENCES workflows (community_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_runs_workflow ON workflow_runs (community_id, workflow_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs (community_id, status);

-- ── Workflow approvals ────────────────────────────────────────────────────────
-- token-hash lookup scoped: approval token grants cannot act on another
-- community's same hash (conformance).

CREATE TABLE workflow_approvals (
    community_id    UUID NOT NULL REFERENCES communities(id),
    token           BYTEA NOT NULL,
    workflow_id     UUID NOT NULL,
    run_id          UUID NOT NULL,
    step_id         VARCHAR(64) NOT NULL,
    step_index      INT NOT NULL,
    approver_spec   TEXT NOT NULL,
    status          approval_status NOT NULL DEFAULT 'pending',
    approver_pubkey BYTEA,
    note            TEXT,
    granted_at      TIMESTAMPTZ,
    denied_at       TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, token),
    FOREIGN KEY (community_id, workflow_id)
        REFERENCES workflows (community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, run_id)
        REFERENCES workflow_runs (community_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_approvals_workflow ON workflow_approvals (community_id, workflow_id);
CREATE INDEX idx_workflow_approvals_run ON workflow_approvals (community_id, run_id);
CREATE INDEX idx_workflow_approvals_status ON workflow_approvals (community_id, status);

-- ── Scheduled workflow fires (cron claim) ─────────────────────────────────────
-- Plan §5: the at-most-once cron fire claim. UNIQUE (community_id, workflow_id,
-- scheduled_for) — only the pod that wins the claim insert creates the run.
-- Restart-safe (DB-durable). community is server provenance: the scheduler passes
-- workflow.community_id from list_all_enabled_workflows(), never a client input.
-- workflow_id is NOT globally unique under the (community_id, id) workflow key, so
-- the claim binds both community and id explicitly rather than resolving from id.
-- workflow_run_id links the won claim to the run it created (audit; NULL until the
-- post-insert attach, and stays NULL if run creation failed after a won claim).
-- The FK to workflow_runs uses NO ACTION (not SET NULL): community_id is shared
-- with the claim PK and is NOT NULL, so SET NULL is unimplementable here; a future
-- delete of a still-linked run is blocked rather than orphaning the at-most-once
-- claim row. workflow_runs are not pruned today, so this is a guardrail, not a path.

CREATE TABLE scheduled_workflow_fires (
    community_id    UUID NOT NULL REFERENCES communities(id),
    workflow_id     UUID NOT NULL,
    scheduled_for   TIMESTAMPTZ NOT NULL,
    claimed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    workflow_run_id UUID,
    PRIMARY KEY (community_id, workflow_id, scheduled_for),
    FOREIGN KEY (community_id, workflow_id)
        REFERENCES workflows (community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, workflow_run_id)
        REFERENCES workflow_runs (community_id, id) ON DELETE NO ACTION
);

-- The interval anchor reads MAX(scheduled_for) per workflow; the janitor prunes
-- by claimed_at globally (operator concern). See plan §5 retention coupling.
CREATE INDEX idx_scheduled_fires_claimed_at ON scheduled_workflow_fires (claimed_at);

-- ── API tokens ────────────────────────────────────────────────────────────────
-- Conformance: "API tokens and NIP-98 replay". token_hash uniqueness scoped to
-- (community_id, token_hash); channel claims reference channels in same community.

CREATE TABLE api_tokens (
    community_id        UUID NOT NULL REFERENCES communities(id),
    id                  UUID NOT NULL DEFAULT gen_random_uuid(),
    token_hash          BYTEA NOT NULL,
    owner_pubkey        BYTEA NOT NULL,
    name                VARCHAR(255) NOT NULL,
    scopes              JSONB NOT NULL,
    channel_ids         JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,
    last_used_at        TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    revoked_by          BYTEA,
    created_by_self_mint BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (community_id, id),
    FOREIGN KEY (community_id, owner_pubkey) REFERENCES users (community_id, pubkey),
    CONSTRAINT chk_api_tokens_hash_len CHECK (LENGTH(token_hash) = 32)
);

CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens (community_id, token_hash);

-- ── Rate limit violations ─────────────────────────────────────────────────────
-- OPERATOR-GLOBAL: a deployment-health / abuse table, never tenant-observable.
-- Listed in the lint allowlist. Carries community_id as an attribution label
-- only (nullable, no uniqueness over it).

CREATE TABLE rate_limit_violations (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    community_id    UUID,
    pubkey          BYTEA,
    violation_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    limit_type      VARCHAR(64),
    limit_value     INT,
    actual_value    INT,
    action_taken    VARCHAR(64)
);

-- ── Product feedback (migration 0017, amended by 0060) ──────────────────────
-- OPERATOR-GLOBAL: accepted through a dedicated signed event kind and
-- sidecarred here instead of entering the ordinary events table. Rows remain
-- attributable to their source community; deployment operators review the
-- table across communities through internal tooling. community_id is
-- provenance only (nullable since 0060: SET NULL on tenant deletion) and the
-- table is excluded from the community write fence.
CREATE TABLE product_feedback (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id        UUID REFERENCES communities(id) ON DELETE SET NULL,
    event_id            BYTEA NOT NULL UNIQUE CHECK (length(event_id) = 32),
    submitter_pubkey    BYTEA NOT NULL CHECK (length(submitter_pubkey) = 32),
    category            TEXT CHECK (category IN ('bug', 'praise', 'needs-work')),
    body                TEXT NOT NULL CHECK (length(btrim(body)) > 0),
    tags                JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
    event_created_at    TIMESTAMPTZ NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_feedback_received
    ON product_feedback (received_at DESC, id);
CREATE INDEX idx_product_feedback_community_received
    ON product_feedback (community_id, received_at DESC, id);

-- ── Thread metadata ───────────────────────────────────────────────────────────
-- Conformance: thread lookups filter by community before event matching.

CREATE TABLE thread_metadata (
    community_id            UUID NOT NULL REFERENCES communities(id),
    event_created_at        TIMESTAMPTZ NOT NULL,
    event_id                BYTEA NOT NULL,
    channel_id              UUID NOT NULL,
    parent_event_id         BYTEA,
    parent_event_created_at TIMESTAMPTZ,
    root_event_id           BYTEA,
    root_event_created_at   TIMESTAMPTZ,
    depth                   INT NOT NULL DEFAULT 0,
    reply_count             INT NOT NULL DEFAULT 0,
    descendant_count        INT NOT NULL DEFAULT 0,
    last_reply_at           TIMESTAMPTZ,
    broadcast               BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (community_id, event_created_at, event_id),
    FOREIGN KEY (community_id, channel_id) REFERENCES channels (community_id, id)
);

CREATE INDEX idx_thread_metadata_parent ON thread_metadata (community_id, parent_event_id);
CREATE INDEX idx_thread_metadata_root ON thread_metadata (community_id, root_event_id);
CREATE INDEX idx_thread_metadata_channel_depth
    ON thread_metadata (community_id, channel_id, depth, event_created_at);
CREATE INDEX idx_thread_metadata_event_id ON thread_metadata (community_id, event_id);

-- ── Reactions ─────────────────────────────────────────────────────────────────
-- Conformance: reactions filter by community before event/pubkey matching.

CREATE TABLE reactions (
    community_id        UUID NOT NULL REFERENCES communities(id),
    event_created_at    TIMESTAMPTZ NOT NULL,
    event_id            BYTEA NOT NULL,
    pubkey              BYTEA NOT NULL,
    emoji               VARCHAR(66) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at          TIMESTAMPTZ,
    reaction_event_id   BYTEA,
    PRIMARY KEY (community_id, event_created_at, event_id, pubkey, emoji)
);

CREATE INDEX idx_reactions_event ON reactions (community_id, event_id, event_created_at);
CREATE INDEX idx_reactions_pubkey ON reactions (community_id, pubkey);
-- A reaction's source event id is unique within a community.
CREATE UNIQUE INDEX idx_reactions_source_event ON reactions (community_id, reaction_event_id)
    WHERE reaction_event_id IS NOT NULL;

-- ── Pubkey allowlist ──────────────────────────────────────────────────────────
-- Conformance: "Relay membership, pubkey allowlist, archived identities".
-- PK becomes (community_id, pubkey).

CREATE TABLE pubkey_allowlist (
    community_id UUID NOT NULL REFERENCES communities(id),
    pubkey      BYTEA NOT NULL,
    added_by    BYTEA,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note        TEXT,
    PRIMARY KEY (community_id, pubkey)
);

-- ── Relay members (NIP-43) ────────────────────────────────────────────────────
-- Conformance: membership gate, community-scoped. pubkey stored as hex TEXT
-- (unchanged wire form). PK (community_id, pubkey).

CREATE TABLE relay_members (
    community_id UUID NOT NULL REFERENCES communities(id),
    pubkey      TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    added_by    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, pubkey)
);

CREATE INDEX idx_relay_members_role ON relay_members (community_id, role);

-- ── Join policy acceptances ──────────────────────────────────────────────────
-- Durable evidence of the policy version accepted when an invite claim grants
-- relay membership. The composite foreign key keeps evidence bound to a live
-- member in the same community and removes it with that membership.

CREATE TABLE join_policy_acceptances (
    community_id UUID NOT NULL,
    pubkey TEXT NOT NULL,
    policy_version TEXT NOT NULL CHECK (length(policy_version) = 64),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, pubkey, policy_version),
    FOREIGN KEY (community_id, pubkey)
        REFERENCES relay_members (community_id, pubkey) ON DELETE CASCADE
);

-- ── Relay invites (use-limited invite links) ──────────────────────────────────
-- Conformance: durable invite records for atomic redemption, community-scoped.
-- Stores only SHA-256(code) as 32-byte BYTEA; never the reusable bearer code.
-- PK and UNIQUE both lead with community_id. max_uses NULL = unlimited.

CREATE TABLE relay_invites (
    community_id  UUID        NOT NULL REFERENCES communities(id),
    id           UUID        NOT NULL DEFAULT gen_random_uuid(),
    token_hash   BYTEA       NOT NULL CHECK (length(token_hash) = 32),
    role         TEXT        NOT NULL DEFAULT 'member' CHECK (role = 'member'),
    max_uses     INTEGER     CHECK (max_uses BETWEEN 1 AND 10000),
    use_count    INTEGER     NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    expires_at   TIMESTAMPTZ NOT NULL,
    created_by   TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, token_hash),
    CHECK (max_uses IS NULL OR use_count <= max_uses)
);

CREATE INDEX relay_invites_expires_at_idx ON relay_invites (expires_at);

-- ── Archived identities (NIP-IA) ──────────────────────────────────────────────
-- Conformance: archive cannot hide a key in another community. PK scoped.

CREATE TABLE archived_identities (
    community_id      UUID NOT NULL REFERENCES communities(id),
    pubkey            TEXT NOT NULL,
    consent_path      TEXT NOT NULL CHECK (consent_path IN ('self', 'owner', 'admin')),
    actor             TEXT NOT NULL,
    reason            TEXT,
    replaced_by       TEXT,
    request_event_id  TEXT NOT NULL,
    archived_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, pubkey)
);

-- ── Audit log ─────────────────────────────────────────────────────────────────
-- Conformance: "Audit log and observability". Per-community hash chain:
-- uniqueness (community_id, seq) and (community_id, hash). One chain per tenant.
-- (Lane Audit/Dawn builds the chain logic; Lane 0 fixes the scoped schema.)

CREATE TABLE audit_log (
    community_id    UUID NOT NULL REFERENCES communities(id),
    seq             BIGINT NOT NULL,
    hash            BYTEA NOT NULL,
    prev_hash       BYTEA,
    action          VARCHAR(64) NOT NULL,
    actor_pubkey    BYTEA,
    object_id       TEXT,
    detail          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, seq)
);

CREATE UNIQUE INDEX idx_audit_log_hash ON audit_log (community_id, hash);

-- ── NIP-56 reports (kind:1984 ingest) ─────────────────────────────────────────
-- One row per accepted report event. Reports are signals, never triggers:
-- nothing auto-actions on them (NIP-56). Reporter identity is visible to
-- moderators in the queue but never revealed to the reported author.

CREATE TABLE moderation_reports (
    community_id        UUID NOT NULL REFERENCES communities(id),
    id                  UUID NOT NULL DEFAULT gen_random_uuid(),
    -- The signed kind:1984 event id (stored for audit/idempotency).
    report_event_id     BYTEA NOT NULL CHECK (length(report_event_id) = 32),
    reporter_pubkey     BYTEA NOT NULL CHECK (length(reporter_pubkey) = 32),
    -- What was reported. Exactly one target class per row (CHECK-enforced below).
    target_kind         TEXT NOT NULL CHECK (target_kind IN ('event', 'pubkey', 'blob')),
    target_event_id     BYTEA CHECK (target_event_id IS NULL OR length(target_event_id) = 32),
    target_pubkey       BYTEA CHECK (target_pubkey IS NULL OR length(target_pubkey) = 32),
    target_blob_sha256  BYTEA CHECK (target_blob_sha256 IS NULL OR length(target_blob_sha256) = 32),
    -- Channel inferred from an in-tenant target event row, when resolvable.
    channel_id          UUID,
    -- NIP-56 report type: illegal|nudity|malware|spam|impersonation|profanity|other.
    report_type         TEXT NOT NULL,
    -- Reporter's optional free-text context (mod-queue-only; never public).
    note                TEXT,
    status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'resolved', 'dismissed', 'escalated')),
    resolved_by         BYTEA,
    resolved_at         TIMESTAMPTZ,
    -- moderation_actions row that resolved this report, if any.
    action_id           UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    -- Exactly one target class per row: target_kind is authoritative and the
    -- matching column (only) is populated. Queue/action code never guesses.
    CHECK (
        (target_kind = 'event'  AND target_event_id IS NOT NULL AND target_pubkey IS NULL     AND target_blob_sha256 IS NULL) OR
        (target_kind = 'pubkey' AND target_event_id IS NULL     AND target_pubkey IS NOT NULL AND target_blob_sha256 IS NULL) OR
        (target_kind = 'blob'   AND target_event_id IS NULL     AND target_pubkey IS NULL     AND target_blob_sha256 IS NOT NULL)
    ),
    -- Same-community channel provenance (channels are soft-deleted, never
    -- hard-deleted, so this FK cannot dangle).
    FOREIGN KEY (community_id, channel_id) REFERENCES channels (community_id, id)
);

-- Queue reads: open reports, newest first, per community.
CREATE INDEX idx_moderation_reports_status
    ON moderation_reports (community_id, status, created_at DESC);
-- Group-by-target for triage aggregation.
CREATE INDEX idx_moderation_reports_target_event
    ON moderation_reports (community_id, target_event_id)
    WHERE target_event_id IS NOT NULL;
CREATE INDEX idx_moderation_reports_target_pubkey
    ON moderation_reports (community_id, target_pubkey)
    WHERE target_pubkey IS NOT NULL;
-- Idempotency: one row per report event per community.
CREATE UNIQUE INDEX idx_moderation_reports_event
    ON moderation_reports (community_id, report_event_id);

-- ── Bans + timeouts (one restriction row per member) ──────────────────────────
-- Ban = connection block, enforced at the NIP-42 auth seam
-- ("blocked: you are banned from this community") + join/ingest surfaces.
-- Timeout = write-block only ("restricted: you are timed out until <ts>").
-- A row may be ban-only, timeout-only, or both over its lifetime.

CREATE TABLE community_bans (
    community_id    UUID NOT NULL REFERENCES communities(id),
    pubkey          BYTEA NOT NULL CHECK (length(pubkey) = 32),
    banned          BOOLEAN NOT NULL DEFAULT false,
    -- NULL + banned=true ⇒ permanent.
    ban_expires_at  TIMESTAMPTZ,
    ban_reason      TEXT,
    -- Write-block until this timestamp; NULL or past ⇒ not timed out.
    muted_until     TIMESTAMPTZ,
    mute_reason     TEXT,
    -- Moderator who last modified this row.
    actor_pubkey    BYTEA NOT NULL CHECK (length(actor_pubkey) = 32),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, pubkey)
);

-- ── Moderation audit ──────────────────────────────────────────────────────────
-- One row per accepted moderation action. Full detail (reporter identities,
-- private reasons, matched NIP-OA principal) stays mod/audit-only; the public
-- tombstone carries only action_id + reason_code + sanitized public_reason.

CREATE TABLE moderation_actions (
    community_id    UUID NOT NULL REFERENCES communities(id),
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    actor_pubkey    BYTEA NOT NULL CHECK (length(actor_pubkey) = 32),
    action          TEXT NOT NULL CHECK (action IN (
                        'delete_message', 'kick', 'ban', 'unban',
                        'timeout', 'untimeout', 'dismiss_report', 'escalate',
                        'resolve:delete', 'resolve:kick', 'resolve:ban',
                        'resolve:timeout')),
    target_pubkey   BYTEA CHECK (target_pubkey IS NULL OR length(target_pubkey) = 32),
    target_event_id BYTEA CHECK (target_event_id IS NULL OR length(target_event_id) = 32),
    channel_id      UUID,
    -- Machine-readable rule/reason code (e.g. "spam", "community_rule_3").
    reason_code     TEXT,
    -- Sanitized, safe for the public tombstone.
    public_reason   TEXT,
    -- Mod-only context; never leaves the audit surface.
    private_reason  TEXT,
    -- NIP-OA: which principal matched a ban ('self' | 'owner'); audit-only,
    -- the client never learns which.
    matched_principal TEXT CHECK (matched_principal IS NULL OR matched_principal IN ('self', 'owner')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    FOREIGN KEY (community_id, channel_id) REFERENCES channels (community_id, id)
);

CREATE INDEX idx_moderation_actions_created
    ON moderation_actions (community_id, created_at DESC);
CREATE INDEX idx_moderation_actions_target_pubkey
    ON moderation_actions (community_id, target_pubkey)
    WHERE target_pubkey IS NOT NULL;

-- Same-community resolution provenance: a report can only be resolved by an
-- action row in its own community. Added after moderation_actions exists.
ALTER TABLE moderation_reports
    ADD FOREIGN KEY (community_id, action_id)
    REFERENCES moderation_actions (community_id, id);

-- ── Lint allowlist registry ───────────────────────────────────────────────────
-- The explicit registry of tables that are deliberately operator-global (NOT
-- tenant-scoped). The migration-lint harness reads this: any table NOT listed
-- here MUST carry a NOT NULL community_id and lead its uniques with it. Making
-- the allowlist a DB table (not a hard-coded list in the linter) keeps the
-- registry next to the schema it governs and reviewable in one migration diff.

CREATE TABLE _operator_global_tables (
    table_name  TEXT PRIMARY KEY,
    reason      TEXT NOT NULL
);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('communities',           'the tenant registry itself; id IS the community key'),
    ('rate_limit_violations', 'deployment abuse/health; never tenant-observable; community_id is an attribution label only'),
    ('product_feedback',      'deployment product inbox; community_id is provenance only'),
    ('_operator_global_tables', 'the registry table itself'),
    ('accounts',               'credit balances are identity-global, not community-scoped'),
    ('credit_ledger',          'append-only money journal is identity-global, not community-scoped'),
    ('gateway_tokens',         'provisioned-mode tokens are identity-global, not community-scoped'),
    ('model_catalog',          'model allowlist is deployment-global'),
    ('gateway_reconciliation_outcomes', 'successful gateway calls needing durable attribution/reconciliation'),
    ('gateway_settlement_intents', 'durable identity and provider-export correlation for hosted gateway settlement');

-- Colony Credits gateway tables. Keep the schema snapshot aligned with the
-- migration path so a fresh isolated harness has the same money/admission
-- surface even before the relay's startup migrator runs.
CREATE TABLE accounts (
    pubkey BYTEA PRIMARY KEY CHECK (octet_length(pubkey) = 32),
    balance BIGINT NOT NULL DEFAULT 0,
    trial_model TEXT,
    trial_expires_at TIMESTAMPTZ,
    trial_concurrency SMALLINT,
    typical_call_cost_nanousd BIGINT
        CHECK (typical_call_cost_nanousd IS NULL OR typical_call_cost_nanousd > 0),
    max_in_flight SMALLINT
        CHECK (max_in_flight IS NULL OR max_in_flight BETWEEN 1 AND 4),
    hourly_burn_cap_nanousd BIGINT
        CHECK (hourly_burn_cap_nanousd IS NULL OR hourly_burn_cap_nanousd > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    delta BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
        'debit', 'credit', 'seed', 'correction', 'hold', 'release'
    )),
    ref TEXT NOT NULL,
    model TEXT,
    observed_cost BIGINT CHECK (observed_cost IS NULL OR observed_cost >= 0),
    request_id TEXT,
    settle_basis TEXT CHECK (settle_basis IS NULL OR settle_basis IN ('observed', 'estimated')),
    service TEXT CHECK (service IN ('model', 'discovery')),
    quantity BIGINT CHECK (quantity IS NULL OR quantity > 0),
    unit_price_nanousd BIGINT
        CHECK (unit_price_nanousd IS NULL OR unit_price_nanousd > 0),
    discovery_community_id UUID,
    discovery_campaign_id UUID,
    discovery_run_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pubkey, ref),
    CONSTRAINT discovery_ledger_attribution_complete CHECK (
        (
            service IS NULL
            AND model IS NULL
            AND quantity IS NULL
            AND unit_price_nanousd IS NULL
            AND discovery_community_id IS NULL
            AND discovery_campaign_id IS NULL
            AND discovery_run_id IS NULL
        ) OR (
            service = 'model'
            AND model IS NOT NULL
            AND quantity IS NULL
            AND unit_price_nanousd IS NULL
            AND discovery_community_id IS NULL
            AND discovery_campaign_id IS NULL
            AND discovery_run_id IS NULL
        ) OR (
            service = 'discovery'
            AND kind IN ('debit', 'hold', 'release')
            AND ((kind IN ('debit', 'hold') AND delta < 0)
                 OR (kind = 'release' AND delta > 0))
            AND model IS NULL
            AND observed_cost IS NULL
            AND request_id IS NULL
            AND settle_basis IS NULL
            AND quantity IS NOT NULL
            AND unit_price_nanousd IS NOT NULL
            AND discovery_community_id IS NOT NULL
            AND discovery_campaign_id IS NOT NULL
            AND discovery_run_id IS NOT NULL
            AND abs(delta::NUMERIC) = quantity::NUMERIC * unit_price_nanousd::NUMERIC
        )
    ),
    CONSTRAINT credit_ledger_model_service_complete CHECK (
        model IS NULL OR service = 'model'
    )
);
CREATE FUNCTION credit_ledger_compat_attribution() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.model IS NOT NULL AND NEW.service IS NULL THEN
        NEW.service := 'model';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER credit_ledger_compat_attribution
BEFORE INSERT OR UPDATE OF model,service ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION credit_ledger_compat_attribution();
CREATE INDEX credit_ledger_created_at_idx ON credit_ledger (created_at);
CREATE UNIQUE INDEX credit_ledger_discovery_run_idx
    ON credit_ledger (pubkey, discovery_run_id)
    WHERE service = 'discovery' AND kind = 'debit';

CREATE TABLE gateway_tokens (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    expires_at TIMESTAMPTZ NOT NULL,
    session_scope TEXT NOT NULL DEFAULT 'session'
        CHECK (session_scope IN ('session', 'provisioned')),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gateway_tokens_pubkey_idx ON gateway_tokens (pubkey);

CREATE TABLE model_catalog (
    model_id TEXT PRIMARY KEY,
    vercel_slug TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    display_price_nanousd BIGINT NOT NULL CHECK (display_price_nanousd >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gateway_reconciliation_outcomes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    reference TEXT NOT NULL,
    model TEXT NOT NULL,
    http_status SMALLINT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    UNIQUE (pubkey, reference)
);
CREATE INDEX gateway_reconciliation_outcomes_pending_idx
    ON gateway_reconciliation_outcomes (created_at)
    WHERE resolved_at IS NULL;

CREATE TABLE gateway_settlement_intents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pubkey BYTEA NOT NULL CHECK (octet_length(pubkey) = 32),
    reference TEXT NOT NULL,
    model TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'admitted'
        CHECK (state IN ('admitted', 'provider_completed', 'debited', 'reconciliation', 'resolved')),
    provider_request_id TEXT,
    observed_cost BIGINT CHECK (observed_cost IS NULL OR observed_cost >= 0),
    provider_status SMALLINT,
    reason TEXT,
    correction_ref TEXT,
    reserved_nanousd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_nanousd >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    UNIQUE (pubkey, reference),
    CHECK (
        (state IN ('admitted','provider_completed','reconciliation')
         AND reserved_nanousd > 0)
        OR (state IN ('debited','resolved') AND reserved_nanousd = 0)
    )
);

CREATE FUNCTION gateway_settlement_intent_reservation_compat() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.state IN ('admitted','provider_completed','reconciliation') THEN
        IF NEW.reserved_nanousd = 0 THEN
            NEW.reserved_nanousd := GREATEST(
                COALESCE(
                    (SELECT typical_call_cost_nanousd FROM accounts WHERE pubkey=NEW.pubkey),
                    50000000
                ),
                1
            );
        END IF;
    ELSIF NEW.state IN ('debited','resolved') THEN
        NEW.reserved_nanousd := 0;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_settlement_intent_reservation_compat
BEFORE INSERT OR UPDATE ON gateway_settlement_intents
FOR EACH ROW EXECUTE FUNCTION gateway_settlement_intent_reservation_compat();

CREATE FUNCTION gateway_settlement_intent_account_lock() RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1 FROM accounts WHERE pubkey=NEW.pubkey FOR UPDATE;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_settlement_intent_account_lock
AFTER INSERT OR UPDATE ON gateway_settlement_intents
FOR EACH ROW
WHEN (NEW.state IN ('admitted','provider_completed','reconciliation'))
EXECUTE FUNCTION gateway_settlement_intent_account_lock();
CREATE INDEX gateway_settlement_intents_pending_idx
    ON gateway_settlement_intents (updated_at)
    WHERE state <> 'resolved';
CREATE INDEX gateway_settlement_intents_account_reservations_idx
    ON gateway_settlement_intents (pubkey)
    INCLUDE (reserved_nanousd)
    WHERE state <> 'resolved' AND reserved_nanousd > 0;

ALTER TABLE gateway_reconciliation_outcomes
    ADD COLUMN intent_id BIGINT REFERENCES gateway_settlement_intents(id),
    ADD COLUMN provider_request_id TEXT,
    ADD COLUMN observed_cost BIGINT CHECK (observed_cost IS NULL OR observed_cost >= 0),
    ADD COLUMN correction_ref TEXT;
-- NIP-PL effective lease state and durable wake outbox. Every key is led by
-- community_id: client-provided origin is confirmation only, never routing.
CREATE TABLE push_leases (
    community_id UUID NOT NULL REFERENCES communities(id),
    author BYTEA NOT NULL CHECK (length(author) = 32),
    installation_id TEXT NOT NULL CHECK (octet_length(installation_id) BETWEEN 1 AND 64),
    source_event_id BYTEA NOT NULL CHECK (length(source_event_id) = 32),
    source_created_at BIGINT NOT NULL,
    generation BIGINT NOT NULL CHECK (generation > 0),
    active BOOLEAN NOT NULL,
    endpoint_enabled BOOLEAN NOT NULL DEFAULT true,
    app_profile TEXT,
    endpoint_hash BYTEA CHECK (endpoint_hash IS NULL OR length(endpoint_hash) = 32),
    endpoint_grant TEXT,
    max_class TEXT CHECK (max_class IS NULL OR max_class IN ('silent','default','time_sensitive','urgent')),
    subscriptions JSONB,
    expires_at BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, author, installation_id),
    UNIQUE (community_id, source_event_id),
    CHECK ((active AND app_profile IS NOT NULL AND endpoint_hash IS NOT NULL AND endpoint_grant IS NOT NULL AND max_class IS NOT NULL AND subscriptions IS NOT NULL)
        OR (NOT active AND app_profile IS NULL AND endpoint_hash IS NULL AND endpoint_grant IS NULL AND max_class IS NULL AND subscriptions IS NULL))
);
CREATE UNIQUE INDEX push_leases_endpoint_unique
    ON push_leases (community_id, author, app_profile, endpoint_hash)
    WHERE active;
CREATE INDEX push_leases_expiry ON push_leases (community_id, expires_at) WHERE active;

CREATE TABLE push_wake_outbox (
    community_id UUID NOT NULL REFERENCES communities(id),
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    author BYTEA NOT NULL CHECK (length(author) = 32),
    installation_id TEXT NOT NULL,
    lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
    endpoint_hash BYTEA NOT NULL CHECK (length(endpoint_hash) = 32),
    event_id BYTEA NOT NULL CHECK (length(event_id) = 32),
    class TEXT NOT NULL CHECK (class IN ('silent','default','time_sensitive','urgent')),
    expires_at BIGINT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','delivered','failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    claim_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    FOREIGN KEY (community_id, author, installation_id)
        REFERENCES push_leases (community_id, author, installation_id),
    UNIQUE (community_id, endpoint_hash, event_id)
);
CREATE INDEX push_wake_outbox_due
    ON push_wake_outbox (community_id, next_attempt_at) WHERE state = 'pending';
CREATE INDEX push_wake_outbox_recovery
    ON push_wake_outbox (community_id, lease_until) WHERE state = 'sending';
-- Durable event-to-push matching follower. The trigger runs in the event insert
-- transaction, so every accepted persistent event has a crash-safe match job and
-- rejected/rolled-back events never do. Processing is idempotent through the
-- push_wake_outbox endpoint/event unique key.
CREATE TABLE push_match_queue (
    community_id UUID NOT NULL REFERENCES communities(id),
    event_id BYTEA NOT NULL CHECK (length(event_id) = 32),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','matching')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    claim_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, event_id)
);
CREATE INDEX push_match_queue_due
    ON push_match_queue (next_attempt_at, created_at) WHERE state = 'pending';
CREATE INDEX push_match_queue_recovery
    ON push_match_queue (lease_until) WHERE state = 'matching';

-- T1b push gate (keep in sync with migrations/0023). Enqueue only when the
-- community has an active, endpoint-enabled, unexpired lease; the shared
-- advisory lock pairs with the exclusive lock taken by lease activations
-- (crates/buzz-db/src/push.rs) to close the lost-wake race.
CREATE FUNCTION enqueue_push_match_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Keep this allowlist identical to the relay's validated NIP-PL descriptor.
    -- Centralizing it on the events table covers every durable producer,
    -- including internal paths that bypass live dispatch.
    IF NEW.kind IN (7, 9, 1059, 40007, 46010) THEN
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('buzz_push_gate:' || NEW.community_id::text, 0));
        IF EXISTS (
            SELECT 1 FROM push_leases
            WHERE community_id = NEW.community_id
              AND active
              AND endpoint_enabled
              AND expires_at > EXTRACT(EPOCH FROM now())::bigint
        ) THEN
            INSERT INTO push_match_queue (community_id, event_id)
            VALUES (NEW.community_id, NEW.id)
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER events_enqueue_push_match
AFTER INSERT ON events
FOR EACH ROW EXECUTE FUNCTION enqueue_push_match_job();

-- Channel TTL refresh (keep in sync with migrations/0024). Runs deferred, in
-- the transaction that makes a channel-scoped event durable, so a TTL
-- transition committed while ingest was in flight is never missed. The
-- per-channel advisory lock is SHARED here — permanent-channel commits admit
-- each other — and taken EXCLUSIVE by TTL transitions (update_channel in
-- crates/buzz-db/src/channel.rs), which forces the same total order the
-- 0022 row lock provided without serializing the hot path.
CREATE FUNCTION refresh_channel_ttl_after_event_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    channel_ttl INTEGER;
BEGIN
    -- Kind 9007 creates the channel and initializes its deadline itself.
    IF NEW.channel_id IS NOT NULL AND NEW.kind <> 9007 THEN
        BEGIN
            PERFORM pg_advisory_xact_lock_shared(hashtextextended(
                'buzz_channel_ttl:' || NEW.community_id::text || ':' || NEW.channel_id::text, 0));

            SELECT ttl_seconds INTO channel_ttl
            FROM channels
            WHERE community_id = NEW.community_id AND id = NEW.channel_id;

            IF channel_ttl IS NOT NULL THEN
                UPDATE channels
                SET ttl_deadline = clock_timestamp() + make_interval(secs => ttl_seconds)
                WHERE community_id = NEW.community_id
                  AND id = NEW.channel_id
                  AND ttl_seconds IS NOT NULL
                  AND archived_at IS NULL
                  AND deleted_at IS NULL;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- Preserve the existing best-effort contract: a TTL refresh failure
            -- must not reject an otherwise valid durable event.
            RAISE WARNING 'channel TTL refresh failed for community %, channel %: %',
                NEW.community_id, NEW.channel_id, SQLERRM;
        END;
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER events_refresh_channel_ttl
AFTER INSERT ON events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION refresh_channel_ttl_after_event_insert();

-- Replica-fence floor guard (keep in sync with migrations/0021). A deferred
-- constraint trigger re-checks, inside COMMIT processing, that channel-bearing
-- event rows are no older than `buzz.created_at_floor` seconds before commit
-- time (clock_timestamp(), NOT the transaction-frozen now()). This turns the
-- relay's ingest-time created_at envelope into a commit-time storage
-- invariant, which is what lets keyset-cursor pages below the replica fence
-- be served by a read replica without holes. Enforcement is armed per session
-- via the GUC (set by the relay's writer pool on connect); sessions without
-- the GUC (pg_restore, manual backfills) bypass it and must hold the replica
-- fence closed for their duration. The only structural exemption is
-- channel_id IS NULL: those rows never appear in keyset-paged windows.
CREATE FUNCTION events_created_at_floor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    floor_secs numeric := nullif(current_setting('buzz.created_at_floor', true), '')::numeric;
BEGIN
    IF floor_secs IS NOT NULL
       AND floor_secs > 0
       AND NEW.channel_id IS NOT NULL
       AND NEW.created_at < clock_timestamp() - make_interval(secs => floor_secs)
    THEN
        RAISE EXCEPTION
            'events.created_at % is more than % s before commit time %; below the replica-fence floor',
            NEW.created_at, floor_secs, clock_timestamp()
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END
$$;

-- INSERT OR UPDATE OF: an UPDATE can move a previously exempt row into the
-- guarded set (channel_id NULL -> NOT NULL) or move a channel row's
-- created_at below the fence, so both mutation paths re-run the guard on the
-- NEW row. A created_at rewrite that crosses partition bounds runs as
-- DELETE + INSERT and hits the cloned AFTER INSERT guard on the destination
-- partition; an in-partition rewrite fires the UPDATE OF arm.
CREATE CONSTRAINT TRIGGER events_created_at_floor
    AFTER INSERT OR UPDATE OF created_at, channel_id ON events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION events_created_at_floor_guard();

-- Durable, deployment-global authority for the public NIP-PL push gateway.
-- This state is intentionally outside relay community tenancy: installations
-- delegate to relay signing keys and may authorize multiple relay deployments.
CREATE TABLE push_gateway_challenges (
    id UUID PRIMARY KEY,
    challenge_hash BYTEA NOT NULL CHECK (length(challenge_hash) = 32),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_gateway_challenges_expiry ON push_gateway_challenges (expires_at);

CREATE TABLE push_gateway_installations (
    id UUID PRIMARY KEY,
    app_attest_key_id BYTEA NOT NULL UNIQUE CHECK (octet_length(app_attest_key_id) BETWEEN 1 AND 128),
    app_attest_public_key BYTEA NOT NULL CHECK (octet_length(app_attest_public_key) BETWEEN 33 AND 256),
    assertion_counter BIGINT NOT NULL CHECK (assertion_counter BETWEEN 0 AND 4294967295),
    app_profile TEXT NOT NULL CHECK (app_profile IN ('buzz-ios-production','buzz-ios-sandbox')),
    token_ciphertext BYTEA NOT NULL CHECK (octet_length(token_ciphertext) BETWEEN 1 AND 2048),
    token_fingerprint BYTEA NOT NULL CHECK (length(token_fingerprint) = 32),
    endpoint_epoch BIGINT NOT NULL CHECK (endpoint_epoch > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_profile, token_fingerprint)
);
CREATE INDEX push_gateway_installations_expiry ON push_gateway_installations (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE push_gateway_delegations (
    id UUID PRIMARY KEY,
    installation_id UUID NOT NULL REFERENCES push_gateway_installations(id),
    relay_pubkey BYTEA NOT NULL CHECK (length(relay_pubkey) = 32),
    endpoint_epoch BIGINT NOT NULL CHECK (endpoint_epoch > 0),
    generation BIGINT NOT NULL CHECK (generation > 0),
    not_before TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (installation_id, relay_pubkey),
    CHECK (not_before < expires_at)
);
CREATE INDEX push_gateway_delegations_expiry ON push_gateway_delegations (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE push_gateway_endpoint_quotas (
    token_fingerprint BYTEA PRIMARY KEY CHECK (length(token_fingerprint) = 32),
    window_started_at TIMESTAMPTZ NOT NULL,
    admitted BIGINT NOT NULL CHECK (admitted >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_gateway_endpoint_quotas_updated ON push_gateway_endpoint_quotas (updated_at);

CREATE TABLE push_gateway_delivery_auth_replays (
    relay_pubkey BYTEA NOT NULL CHECK (length(relay_pubkey) = 32),
    auth_event_id BYTEA NOT NULL CHECK (length(auth_event_id) = 32),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (relay_pubkey, auth_event_id)
);
CREATE INDEX push_gateway_delivery_auth_replays_expiry ON push_gateway_delivery_auth_replays (expires_at);

CREATE TABLE push_gateway_delivery_request_replays (
    relay_pubkey BYTEA NOT NULL CHECK (length(relay_pubkey) = 32),
    request_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (relay_pubkey, request_id)
);
CREATE INDEX push_gateway_delivery_request_replays_expiry ON push_gateway_delivery_request_replays (expires_at);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('push_gateway_challenges', 'public gateway one-time challenges span relay communities'),
    ('push_gateway_installations', 'public gateway installation authority spans relay communities'),
    ('push_gateway_delegations', 'public gateway relay delegations span relay communities'),
    ('push_gateway_endpoint_quotas', 'public gateway endpoint abuse ceilings span relay communities'),
    ('push_gateway_delivery_auth_replays', 'public gateway signed-event replay admission spans relay communities'),
    ('push_gateway_delivery_request_replays', 'public gateway stable request-id admission spans relay communities');

-- ── Replica heartbeat (read-replica freshness fence) ─────────────────────────
-- Portable read-side freshness observation for the replica fence (see
-- crates/buzz-db/src/replica_fence.rs and migrations/0026). Exactly one row;
-- the single-row token UPDATE is the serialization point that makes tokens
-- globally commit-ordered across relay pods. `epoch` detects token resets
-- (restore/re-seed) so a stale retained token can never masquerade as fresh
-- coverage. Deployment-global by design: describes replication topology,
-- never tenant data.

CREATE TABLE replica_heartbeat (
    id    smallint PRIMARY KEY CHECK (id = 1),
    epoch uuid     NOT NULL DEFAULT gen_random_uuid(),
    token bigint   NOT NULL DEFAULT 0
);

INSERT INTO replica_heartbeat (id) VALUES (1);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('replica_heartbeat', 'single-row replication freshness token; describes deployment topology, never tenant data');

-- Durable idempotency claims for signed chat-native Block actions. A retry may
-- carry a fresh signed event ID, but one community/instance/idempotency tuple
-- owns execution and its winning event.
CREATE TABLE block_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    instance_event_id BYTEA NOT NULL CHECK (octet_length(instance_event_id) = 32),
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, instance_event_id, idempotency_key)
);

-- The relay-owned catalog broker atomically records the winning activation,
-- catalog head, and receipt under the same community-scoped retry boundary.
CREATE TABLE block_catalog_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    head_event_id BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key)
);

-- Private, relay-owned state for Colony business Discovery. Nostr carries
-- signed commands and safe receipts; commercial entitlement, grants, worker
-- leases, and progress remain in community-scoped storage.
CREATE TABLE discovery_entitlements (
    community_id UUID NOT NULL PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION provision_discovery_trial() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO discovery_entitlements
        (community_id, active, expires_at, updated_at)
    VALUES (NEW.id, TRUE, now() + interval '30 days', now());
    RETURN NEW;
END;
$$;

CREATE TRIGGER communities_provision_discovery_trial
AFTER INSERT ON communities
FOR EACH ROW EXECUTE FUNCTION provision_discovery_trial();

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

CREATE TABLE discovery_campaigns (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    created_by BYTEA NOT NULL CHECK (octet_length(created_by) = 32),
    name TEXT NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 256 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
    industry_id TEXT NOT NULL CHECK (octet_length(industry_id) BETWEEN 1 AND 128 AND industry_id ~ '^[a-z0-9-]+$'),
    industry_name TEXT NOT NULL CHECK (octet_length(industry_name) BETWEEN 1 AND 256 AND industry_name = btrim(industry_name) AND industry_name !~ '[[:cntrl:]]'),
    vertical_id TEXT NOT NULL CHECK (octet_length(vertical_id) BETWEEN 1 AND 128 AND vertical_id ~ '^[a-z0-9-]+$'),
    vertical_name TEXT NOT NULL CHECK (octet_length(vertical_name) BETWEEN 1 AND 256 AND vertical_name = btrim(vertical_name) AND vertical_name !~ '[[:cntrl:]]'),
    query TEXT NOT NULL CHECK (octet_length(query) BETWEEN 1 AND 256 AND query = btrim(query) AND query !~ '[[:cntrl:]]'),
    location TEXT NOT NULL CHECK (octet_length(location) BETWEEN 1 AND 256 AND location = btrim(location) AND location !~ '[[:cntrl:]]'),
    target SMALLINT NOT NULL CHECK (target BETWEEN 1 AND 500),
    description TEXT CHECK (description IS NULL OR (octet_length(description) BETWEEN 1 AND 2048 AND description = btrim(description) AND description !~ '[[:cntrl:]]')),
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}$'),
    region TEXT CHECK (region IS NULL OR region ~ '^[A-Z]{2}$'),
    source_mode TEXT NOT NULL DEFAULT 'waterfall'
        CHECK (source_mode IN ('waterfall', 'concurrent')),
    source_keys TEXT[] NOT NULL DEFAULT ARRAY['google_maps']::TEXT[] CHECK (
        cardinality(source_keys) BETWEEN 1 AND 3
        AND source_keys <@ ARRAY['google_maps', 'brave_search', 'exa_search']::TEXT[]
        AND array_position(source_keys, source_keys[1], 2) IS NULL
        AND (cardinality(source_keys) < 2 OR array_position(source_keys, source_keys[2], 3) IS NULL)
    ),
    budget_payer_pubkey BYTEA
        CHECK (budget_payer_pubkey IS NULL OR octet_length(budget_payer_pubkey) = 32),
    budget_approved_nanousd BIGINT NOT NULL DEFAULT 0
        CHECK (budget_approved_nanousd >= 0),
    budget_spent_nanousd BIGINT NOT NULL DEFAULT 0
        CHECK (budget_spent_nanousd >= 0),
    budget_reserved_nanousd BIGINT NOT NULL DEFAULT 0
        CHECK (budget_reserved_nanousd >= 0),
    budget_state TEXT NOT NULL DEFAULT 'unapproved'
        CHECK (budget_state IN ('unapproved', 'active', 'paused', 'revoked', 'exhausted')),
    budget_approval_event_id BYTEA
        CHECK (budget_approval_event_id IS NULL OR octet_length(budget_approval_event_id) = 32),
    budget_approved_at TIMESTAMPTZ,
    budget_fingerprint BYTEA
        CHECK (budget_fingerprint IS NULL OR octet_length(budget_fingerprint) = 32),
    price_per_retained_lead_nanousd BIGINT
        CHECK (price_per_retained_lead_nanousd IS NULL OR price_per_retained_lead_nanousd > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    CONSTRAINT discovery_campaigns_spent_and_reserved_within_approved CHECK (
        budget_spent_nanousd::NUMERIC + budget_reserved_nanousd::NUMERIC
            <= budget_approved_nanousd::NUMERIC
    ),
    CONSTRAINT discovery_campaigns_budget_approval_complete CHECK (
        (
            budget_state = 'unapproved'
            AND budget_payer_pubkey IS NULL
            AND budget_approved_nanousd = 0
            AND budget_spent_nanousd = 0
            AND budget_reserved_nanousd = 0
            AND budget_approval_event_id IS NULL
            AND budget_approved_at IS NULL
            AND budget_fingerprint IS NULL
            AND price_per_retained_lead_nanousd IS NULL
        ) OR (
            budget_state <> 'unapproved'
            AND budget_payer_pubkey IS NOT NULL
            AND budget_approved_nanousd > 0
            AND budget_approval_event_id IS NOT NULL
            AND budget_approved_at IS NOT NULL
            AND budget_fingerprint IS NOT NULL
            AND price_per_retained_lead_nanousd IS NOT NULL
        )
    )
);

CREATE INDEX discovery_campaigns_taxonomy_created_idx
    ON discovery_campaigns (community_id, industry_id, vertical_id, created_at DESC, id DESC);
CREATE INDEX discovery_campaigns_budget_payer_active_idx
    ON discovery_campaigns (budget_payer_pubkey, budget_state)
    INCLUDE (budget_reserved_nanousd)
    WHERE budget_payer_pubkey IS NOT NULL;
CREATE UNIQUE INDEX discovery_campaign_budget_approval_event_unique
    ON discovery_campaigns (community_id, budget_approval_event_id)
    WHERE budget_approval_event_id IS NOT NULL;

CREATE TABLE discovery_budget_approval_claims (
    approval_event_id BYTEA PRIMARY KEY CHECK (octet_length(approval_event_id) = 32),
    community_id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    payer_pubkey BYTEA NOT NULL CHECK (octet_length(payer_pubkey) = 32),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE discovery_workspace_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN (
        'access', 'create_campaign', 'update_campaign_sources',
        'approve_campaign_budget', 'pause_campaign_budget',
        'revoke_campaign_budget', 'get_campaign_budget',
        'get_campaign', 'list_campaigns', 'list_leads', 'list_lead_counts',
        'get_lead', 'update_lead', 'search_entities', 'resolve_entities'
    )),
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key),
    UNIQUE (community_id, action_event_id)
);

CREATE TABLE discovery_runs (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    requested_by BYTEA NOT NULL CHECK (octet_length(requested_by) = 32),
    start_idempotency_key UUID NOT NULL,
    discovery_protocol_version SMALLINT NOT NULL DEFAULT 1
        CHECK (discovery_protocol_version IN (1, 2, 3)),
    lease_worker_protocol_version SMALLINT
        CHECK (lease_worker_protocol_version IN (1, 2, 3)),
    lease_worker_protocol_claim_id UUID,
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
    payer_pubkey BYTEA
        CHECK (payer_pubkey IS NULL OR octet_length(payer_pubkey) = 32),
    price_per_retained_lead_nanousd BIGINT
        CHECK (price_per_retained_lead_nanousd IS NULL OR price_per_retained_lead_nanousd > 0),
    billable_lead_limit SMALLINT
        CHECK (billable_lead_limit IS NULL OR billable_lead_limit BETWEEN 1 AND 500),
    reserved_nanousd BIGINT
        CHECK (reserved_nanousd IS NULL OR reserved_nanousd >= 0),
    settled_nanousd BIGINT
        CHECK (settled_nanousd IS NULL OR settled_nanousd >= 0),
    released_nanousd BIGINT
        CHECK (released_nanousd IS NULL OR released_nanousd >= 0),
    billed_retained_lead_count SMALLINT
        CHECK (billed_retained_lead_count IS NULL OR billed_retained_lead_count BETWEEN 0 AND 500),
    settlement_ref TEXT CHECK (
        settlement_ref IS NULL OR (
            octet_length(settlement_ref) BETWEEN 1 AND 256
            AND settlement_ref = btrim(settlement_ref)
            AND settlement_ref !~ '[[:cntrl:]]'
        )
    ),
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, start_idempotency_key),
    CHECK (completed_steps <= total_steps),
    CHECK ((claim_id IS NULL) = (lease_until IS NULL)),
    CONSTRAINT discovery_runs_billing_snapshot_complete CHECK (
        (
            discovery_protocol_version < 3
            AND payer_pubkey IS NULL
            AND price_per_retained_lead_nanousd IS NULL
            AND billable_lead_limit IS NULL
            AND reserved_nanousd IS NULL
            AND settled_nanousd IS NULL
            AND released_nanousd IS NULL
            AND billed_retained_lead_count IS NULL
            AND settlement_ref IS NULL
            AND settled_at IS NULL
        ) OR (
            discovery_protocol_version = 3
            AND payer_pubkey IS NOT NULL
            AND price_per_retained_lead_nanousd IS NOT NULL
            AND billable_lead_limit IS NOT NULL
            AND reserved_nanousd IS NOT NULL
            AND reserved_nanousd::NUMERIC =
                price_per_retained_lead_nanousd::NUMERIC * billable_lead_limit::NUMERIC
            AND (
                (
                    state IN ('queued', 'running')
                    AND settled_nanousd IS NULL
                    AND released_nanousd IS NULL
                    AND billed_retained_lead_count IS NULL
                    AND settlement_ref IS NULL
                    AND settled_at IS NULL
                ) OR (
                    state IN ('succeeded', 'cancelled', 'failed')
                    AND settled_nanousd IS NOT NULL
                    AND released_nanousd IS NOT NULL
                    AND billed_retained_lead_count IS NOT NULL
                    AND billed_retained_lead_count <= billable_lead_limit
                    AND settlement_ref IS NOT NULL
                    AND settled_at IS NOT NULL
                    AND settled_nanousd::NUMERIC + released_nanousd::NUMERIC
                        = reserved_nanousd::NUMERIC
                    AND settled_nanousd::NUMERIC =
                        price_per_retained_lead_nanousd::NUMERIC
                            * billed_retained_lead_count::NUMERIC
                )
            )
        )
    )
);

CREATE FUNCTION discovery_guard_active_campaign_run() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.state NOT IN ('queued','running') THEN
        RETURN NEW;
    END IF;
    PERFORM id FROM discovery_campaigns
    WHERE community_id=NEW.community_id AND id=NEW.campaign_id
    FOR UPDATE;
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

CREATE FUNCTION discovery_guard_lease_worker_protocol() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.claim_id IS NULL THEN
        NEW.lease_worker_protocol_version := NULL;
        NEW.lease_worker_protocol_claim_id := NULL;
        RETURN NEW;
    END IF;
    IF NEW.lease_worker_protocol_version IN (2, 3)
       AND NEW.lease_worker_protocol_claim_id=NEW.claim_id
    THEN
        IF NEW.lease_worker_protocol_version <> NEW.discovery_protocol_version THEN
            RAISE EXCEPTION
                'Discovery worker protocol does not match the run protocol'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    NEW.lease_worker_protocol_version := 1;
    NEW.lease_worker_protocol_claim_id := NEW.claim_id;
    IF NEW.discovery_protocol_version <> 1 THEN
        RAISE EXCEPTION
            'Discovery protocol V1 worker cannot claim a newer protocol run'
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

CREATE INDEX discovery_runs_claimable_idx
    ON discovery_runs (state, lease_until, created_at)
    WHERE state IN ('queued', 'running');

CREATE INDEX discovery_runs_community_created_idx
    ON discovery_runs (community_id, created_at DESC);
CREATE INDEX discovery_runs_community_campaign_idx
    ON discovery_runs (community_id, campaign_id, created_at DESC);
CREATE UNIQUE INDEX discovery_runs_settlement_ref_idx
    ON discovery_runs (community_id, settlement_ref)
    WHERE settlement_ref IS NOT NULL;

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

-- Durable, private control plane for user-owned local Discovery workers.
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
    provider TEXT NOT NULL CHECK (provider IN ('outscraper', 'brave_search', 'exa_search')),
    provider_request_id TEXT
        CHECK (
            provider_request_id IS NULL
            OR (length(provider_request_id) BETWEEN 1 AND 128
                AND provider_request_id ~ '^[A-Za-z0-9_-]+$')
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
    ),
    CONSTRAINT discovery_run_checkpoints_bounded_results
        CHECK (item_count IS NULL OR item_count <= 500)
);

CREATE UNIQUE INDEX discovery_checkpoint_provider_request_once_idx
    ON discovery_run_checkpoints (community_id, provider, provider_request_id)
    WHERE provider_request_id IS NOT NULL;

CREATE TABLE discovery_worker_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    operation TEXT NOT NULL
        CHECK (operation IN (
            'claim', 'heartbeat', 'checkpoint', 'source_progress',
            'store_observations', 'salvage_observations', 'fail', 'complete'
        )),
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

CREATE TABLE discovery_run_business_searches (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    query TEXT NOT NULL CHECK (
        octet_length(query) BETWEEN 1 AND 256
        AND query = btrim(query)
        AND query !~ '[[:cntrl:]]'
    ),
    location TEXT NOT NULL CHECK (
        octet_length(location) BETWEEN 1 AND 256
        AND location = btrim(location)
        AND location !~ '[[:cntrl:]]'
    ),
    result_limit SMALLINT NOT NULL CHECK (result_limit BETWEEN 1 AND 500),
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}$'),
    region TEXT CHECK (region IS NULL OR region ~ '^[A-Z]{2}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

CREATE TABLE discovery_run_source_plans (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    source_mode TEXT NOT NULL CHECK (source_mode IN ('waterfall', 'concurrent')),
    source_keys TEXT[] NOT NULL CHECK (
        cardinality(source_keys) BETWEEN 1 AND 3
        AND source_keys <@ ARRAY['google_maps', 'brave_search', 'exa_search']::TEXT[]
        AND array_position(source_keys, source_keys[1], 2) IS NULL
        AND (cardinality(source_keys) < 2 OR array_position(source_keys, source_keys[2], 3) IS NULL)
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

CREATE TABLE discovery_run_sources (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    source_key TEXT NOT NULL CHECK (source_key IN ('google_maps', 'brave_search', 'exa_search')),
    provider TEXT NOT NULL CHECK (provider IN ('outscraper', 'brave_search', 'exa_search')),
    position SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 2),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'active', 'completed', 'exhausted', 'failed', 'cancelled',
        'outcome_unknown', 'skipped_target_met'
    )),
    request_cursor TEXT CHECK (request_cursor IS NULL OR octet_length(request_cursor) BETWEEN 1 AND 256),
    request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
    returned_count INTEGER NOT NULL DEFAULT 0 CHECK (returned_count >= 0),
    retained_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_count >= 0),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN (
        'credential_rejected', 'billing_required', 'invalid_request',
        'rate_limited', 'provider_unavailable', 'response_too_large',
        'request_timed_out', 'malformed_response', 'outcome_unknown', 'cancelled'
    )),
    provider_poll_after TIMESTAMPTZ,
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

CREATE TABLE discovery_gateway_attempts (
    community_id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    run_id UUID NOT NULL,
    payer_pubkey BYTEA NOT NULL CHECK (octet_length(payer_pubkey) = 32),
    provider TEXT NOT NULL CHECK (provider IN ('outscraper','brave_search','exa_search')),
    intent_id TEXT NOT NULL CHECK (
        octet_length(intent_id) BETWEEN 1 AND 128
        AND intent_id = btrim(intent_id)
        AND intent_id !~ '[[:cntrl:]]'
    ),
    provider_request_id TEXT CHECK (
        provider_request_id IS NULL OR (
            octet_length(provider_request_id) BETWEEN 1 AND 128
            AND provider_request_id = btrim(provider_request_id)
            AND provider_request_id !~ '[[:cntrl:]]'
        )
    ),
    status TEXT NOT NULL CHECK (status IN ('intent','pending','ready')),
    observations JSONB NOT NULL DEFAULT '[]'::JSONB
        CHECK (jsonb_typeof(observations) = 'array'),
    returned_count INTEGER NOT NULL DEFAULT 0 CHECK (returned_count BETWEEN 0 AND 500),
    retained_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_count BETWEEN 0 AND 500),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count BETWEEN 0 AND 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id, provider),
    FOREIGN KEY (community_id, campaign_id)
        REFERENCES discovery_campaigns(community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

CREATE INDEX discovery_gateway_attempts_payer_recent_idx
    ON discovery_gateway_attempts (payer_pubkey, created_at DESC);

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

CREATE TABLE discovery_business_observations (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    id UUID NOT NULL,
    first_run_id UUID NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('outscraper', 'brave_search', 'exa_search')),
    provider_record_id TEXT NOT NULL CHECK (
        octet_length(provider_record_id) BETWEEN 1 AND 256
        AND provider_record_id ~ '^[A-Za-z0-9:_-]+$'
    ),
    place_id TEXT CHECK (
        place_id IS NULL OR (
            octet_length(place_id) BETWEEN 1 AND 256
            AND place_id ~ '^[A-Za-z0-9:_-]+$'
        )
    ),
    google_id TEXT CHECK (
        google_id IS NULL OR (
            octet_length(google_id) BETWEEN 1 AND 256
            AND google_id ~ '^[A-Za-z0-9:_-]+$'
        )
    ),
    name TEXT NOT NULL CHECK (
        octet_length(name) BETWEEN 1 AND 256
        AND name = btrim(name)
        AND name !~ '[[:cntrl:]]'
    ),
    website TEXT CHECK (
        website IS NULL OR (
            octet_length(website) BETWEEN 1 AND 2048
            AND website ~ '^https?://'
            AND website !~ '[[:cntrl:]]'
        )
    ),
    phone TEXT CHECK (
        phone IS NULL OR (
            octet_length(phone) BETWEEN 1 AND 64
            AND phone = btrim(phone)
            AND phone !~ '[[:cntrl:]]'
        )
    ),
    full_address TEXT CHECK (
        full_address IS NULL OR (
            octet_length(full_address) BETWEEN 1 AND 512
            AND full_address = btrim(full_address)
            AND full_address !~ '[[:cntrl:]]'
        )
    ),
    city TEXT CHECK (city IS NULL OR octet_length(city) BETWEEN 1 AND 128),
    state TEXT CHECK (state IS NULL OR octet_length(state) BETWEEN 1 AND 128),
    postal_code TEXT CHECK (postal_code IS NULL OR octet_length(postal_code) BETWEEN 1 AND 128),
    country TEXT CHECK (country IS NULL OR octet_length(country) BETWEEN 1 AND 128),
    country_code TEXT CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
    latitude_micros INTEGER CHECK (latitude_micros BETWEEN -90000000 AND 90000000),
    longitude_micros INTEGER CHECK (longitude_micros BETWEEN -180000000 AND 180000000),
    category TEXT CHECK (category IS NULL OR octet_length(category) BETWEEN 1 AND 128),
    subtypes TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(subtypes) <= 20),
    rating_hundredths SMALLINT CHECK (rating_hundredths BETWEEN 0 AND 500),
    reviews_count BIGINT CHECK (reviews_count >= 0),
    business_status TEXT CHECK (
        business_status IS NULL OR business_status IN (
            'operational', 'temporarily_closed', 'permanently_closed'
        )
    ),
    verified BOOLEAN,
    source_url TEXT CHECK (
        source_url IS NULL OR (
            octet_length(source_url) BETWEEN 1 AND 2048
            AND source_url ~ '^https?://'
            AND source_url !~ '[[:cntrl:]]'
        )
    ),
    image_url TEXT CHECK (
        image_url IS NULL OR (
            octet_length(image_url) BETWEEN 1 AND 2048
            AND image_url ~ '^https?://'
            AND image_url !~ '[[:cntrl:]]'
        )
    ),
    description TEXT CHECK (
        description IS NULL OR (
            octet_length(description) BETWEEN 1 AND 2048
            AND description = btrim(description)
            AND description !~ '[[:cntrl:]]'
        )
    ),
    canonical_domain_digest BYTEA CHECK (
        canonical_domain_digest IS NULL OR octet_length(canonical_domain_digest) = 32
    ),
    normalized_phone_digest BYTEA CHECK (
        normalized_phone_digest IS NULL OR octet_length(normalized_phone_digest) = 32
    ),
    normalized_name_locality_digest BYTEA CHECK (
        normalized_name_locality_digest IS NULL
        OR octet_length(normalized_name_locality_digest) = 32
    ),
    dedupe_digest_version SMALLINT NOT NULL DEFAULT 0
        CHECK (dedupe_digest_version IN (0, 1)),
    observation_fingerprint BYTEA NOT NULL CHECK (octet_length(observation_fingerprint) = 32),
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, provider, provider_record_id),
    FOREIGN KEY (community_id, first_run_id)
        REFERENCES discovery_runs(community_id, id)
);

CREATE TABLE discovery_campaign_leads (
    community_id UUID NOT NULL,
    campaign_id UUID NOT NULL,
    lead_id UUID NOT NULL,
    discovered_run_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, campaign_id, lead_id),
    FOREIGN KEY (community_id, campaign_id)
        REFERENCES discovery_campaigns(community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, lead_id)
        REFERENCES discovery_business_observations(community_id, id) ON DELETE CASCADE,
    FOREIGN KEY (community_id, discovered_run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

CREATE INDEX discovery_campaign_leads_lead_idx
    ON discovery_campaign_leads (community_id, lead_id);

CREATE FUNCTION discovery_associate_observation_campaign() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO discovery_campaign_leads
        (community_id,campaign_id,lead_id,discovered_run_id,created_at)
    SELECT NEW.community_id,r.campaign_id,NEW.id,NEW.first_run_id,NEW.first_observed_at
    FROM discovery_runs r
    WHERE r.community_id=NEW.community_id AND r.id=NEW.first_run_id
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER discovery_associate_observation_campaign
AFTER INSERT ON discovery_business_observations
FOR EACH ROW EXECUTE FUNCTION discovery_associate_observation_campaign();

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

CREATE INDEX discovery_business_observations_first_run_idx
    ON discovery_business_observations (community_id, first_run_id, first_observed_at);

CREATE INDEX discovery_business_observations_domain_dedupe_idx
    ON discovery_business_observations (community_id, canonical_domain_digest)
    WHERE canonical_domain_digest IS NOT NULL;

CREATE INDEX discovery_business_observations_phone_dedupe_idx
    ON discovery_business_observations (community_id, normalized_phone_digest)
    WHERE normalized_phone_digest IS NOT NULL;

CREATE INDEX discovery_business_observations_name_locality_dedupe_idx
    ON discovery_business_observations (community_id, normalized_name_locality_digest)
    WHERE normalized_name_locality_digest IS NOT NULL;

-- Phase B: mutable lead state for the Discovery CRM surface. The observation
-- row stays immutable; this profile carries human/agent edits and the funnel
-- status, whose vocabulary and transitions come from the Party contract.
CREATE TABLE discovery_lead_profiles (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate'
        CHECK (status IN (
            'candidate', 'accepted', 'qualified', 'dormant', 'disqualified',
            'client_active'
        )),
    owner_persona_id TEXT,
    website TEXT,
    email TEXT,
    phone TEXT,
    linkedin_url TEXT,
    contact_name TEXT,
    contact_title TEXT,
    notes TEXT CHECK (notes IS NULL OR octet_length(notes) <= 8000),
    score SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 100),
    updated_by BYTEA NOT NULL CHECK (octet_length(updated_by) = 32),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, lead_id),
    FOREIGN KEY (community_id, lead_id)
        REFERENCES discovery_business_observations(community_id, id)
        ON DELETE CASCADE
);

CREATE INDEX discovery_lead_profiles_status_idx
    ON discovery_lead_profiles (community_id, status);

CREATE TABLE discovery_usage (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    provider TEXT NOT NULL CHECK (provider = 'outscraper'),
    provider_request_id TEXT NOT NULL CHECK (
        octet_length(provider_request_id) BETWEEN 1 AND 128
        AND provider_request_id ~ '^[A-Za-z0-9_-]+$'
    ),
    stored_count INTEGER NOT NULL DEFAULT 0 CHECK (stored_count >= 0),
    existing_count INTEGER NOT NULL DEFAULT 0 CHECK (existing_count >= 0),
    returned_count INTEGER CHECK (returned_count IS NULL OR returned_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id),
    UNIQUE (community_id, provider, provider_request_id),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE
);

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

CREATE TABLE discovery_observation_batches (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    provider TEXT NOT NULL DEFAULT 'outscraper'
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
    PRIMARY KEY (community_id, run_id, provider_request_id, batch_index),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE,
    CHECK (accepted_count + existing_count BETWEEN 1 AND 25)
);

CREATE FUNCTION discovery_guard_legacy_duplicate_batch() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.existing_count > 0 AND pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION
            'Released Discovery writer cannot safely commit duplicate Campaign Leads; update Colony'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discovery_guard_legacy_duplicate_batch
BEFORE INSERT ON discovery_observation_batches
FOR EACH ROW EXECUTE FUNCTION discovery_guard_legacy_duplicate_batch();

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

-- ── Interrupt asks projection ─────────────────────────────────────────────────
-- One row per Ask event; the relay's interrupt sweep and the future Open
-- Issues surface read this instead of scanning events. The partial unique
-- index enforces at most one OPEN ask per (community, initiative, need).

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
CREATE UNIQUE INDEX IF NOT EXISTS asks_open_need_uniq
    ON asks (community_id, initiative_id, need_key) WHERE status = 'open';
-- No community_id predicate: the interrupt sweep scans due asks across every
-- community (see query_due_asks), so this index leads with deadline_at to
-- give that cross-tenant scan a real range scan instead of a full scan.
CREATE INDEX IF NOT EXISTS asks_due_idx ON asks (deadline_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS asks_audience_idx ON asks (community_id, audience_pubkey) WHERE status = 'open';

-- Company employees (migration 0043): workspace-owned agent identities.
--
-- An employee is a role the company employs rather than a process a member
-- runs. Its identity keypair is minted by the relay and held sealed here, so
-- every member's machine can produce work as one colleague without a private
-- key being copied between laptops.
--
-- `rank` is what the interrupt ladder reads to decide who may interrupt a
-- human (crates/buzz-relay/src/interrupt_gate.rs::agent_tier), so a database
-- provisioned from this file without the table leaves the gate unable to
-- resolve any agent's rank at all -- it fails closed and refuses every gated
-- write. That is why this table has to be here and not only in migrations.
--
-- The sealed key is AES-256-GCM under an operator-held KEK with the community
-- id and employee pubkey bound in as associated data, so a dump without the
-- KEK yields no ability to speak as anyone.
CREATE TABLE IF NOT EXISTS employees (
    community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    pubkey        BYTEA NOT NULL,
    -- nonce || ciphertext from the sealer above. Never a bare secret key.
    sealed_key    BYTEA NOT NULL,
    role_id       TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    rank          TEXT NOT NULL CHECK (rank IN ('worker','leader','executive')),
    -- The owner who hired this employee, and the hire request that asked for
    -- it. The request is owner-signed, so anyone can re-derive authority from
    -- events alone rather than trusting this table.
    hired_by      BYTEA NOT NULL,
    hire_event    BYTEA NOT NULL,
    -- The agent this employee reports to, one rung up the interrupt ladder
    -- (migration 0061). NULL means no manager: the root marker for
    -- executives and the Unassigned-tray state for everyone else. Read by
    -- interrupt_gate::agent_manager before any event is consulted.
    manager       BYTEA,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    created_at    BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL,
    PRIMARY KEY (community_id, pubkey),
    CHECK (LENGTH(pubkey) = 32),
    CHECK (LENGTH(hired_by) = 32),
    CHECK (LENGTH(hire_event) = 32),
    CONSTRAINT employees_manager_len CHECK (manager IS NULL OR LENGTH(manager) = 32)
);

-- Hiring is driven by a best-effort side effect, which may run more than once
-- for the same request. One employee per hire request makes a repeat run a
-- no-op instead of a second identity for the same role.
CREATE UNIQUE INDEX IF NOT EXISTS employees_hire_event_uniq
    ON employees (community_id, hire_event);

-- One active employee per role: a workspace employs one Chief of Staff, not
-- one per member who asked. Retired rows are excluded so a role can be
-- refilled after its holder is retired.
CREATE UNIQUE INDEX IF NOT EXISTS employees_active_role_uniq
    ON employees (community_id, role_id) WHERE status = 'active';

-- 0044/0058: durable employee job queue and task-linked recovery state.
-- The lease row is the authority for one machine at a time; checkpoint and
-- outcome evidence make Task-linked jobs restart-safe without a second queue.
CREATE TABLE jobs (
    community_id     UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    job_id           BYTEA NOT NULL,
    employee         BYTEA NOT NULL,
    filed_by         BYTEA NOT NULL,
    originator       BYTEA NOT NULL,
    channel_id       UUID,
    thread           BYTEA,
    instruction      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','leased','done','failed','abandoned')),
    lease_holder     BYTEA,
    lease_expires_at BIGINT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    result           TEXT,
    failure          TEXT,
    escalated_ask    BYTEA,
    head_at          BIGINT NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL,
    -- Execution stamps (migration 0047): which seat ran the work and on what
    -- provider and model.
    provider         TEXT,
    model            TEXT,
    task_id          TEXT,
    checkpoint_seq   BIGINT NOT NULL DEFAULT 0,
    checkpoint       JSONB,
    checkpoint_event BYTEA,
    checkpoint_at    BIGINT,
    artifacts        JSONB,
    outcome_event    BYTEA,
    PRIMARY KEY (community_id, job_id),
    CHECK (LENGTH(job_id) = 32),
    CHECK (LENGTH(employee) = 32),
    CHECK (LENGTH(filed_by) = 32),
    CHECK (LENGTH(originator) = 32),
    CHECK (thread IS NULL OR LENGTH(thread) = 32),
    CHECK (lease_holder IS NULL OR LENGTH(lease_holder) = 32),
    CHECK (escalated_ask IS NULL OR LENGTH(escalated_ask) = 32),
    CHECK (
        (status = 'open' AND lease_holder IS NULL AND lease_expires_at IS NULL)
        OR (status = 'leased' AND lease_holder IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR status IN ('done','failed','abandoned')
    ),
    CONSTRAINT jobs_task_id_bounded
        CHECK (task_id IS NULL OR (LENGTH(BTRIM(task_id)) BETWEEN 1 AND 128)),
    CONSTRAINT jobs_checkpoint_sequence_nonnegative
        CHECK (checkpoint_seq >= 0),
    CONSTRAINT jobs_checkpoint_event_shape
        CHECK (checkpoint_event IS NULL OR LENGTH(checkpoint_event) = 32),
    CONSTRAINT jobs_outcome_event_shape
        CHECK (outcome_event IS NULL OR LENGTH(outcome_event) = 32),
    CONSTRAINT jobs_checkpoint_complete
        CHECK (
            (checkpoint_seq = 0 AND checkpoint IS NULL
                AND checkpoint_event IS NULL AND checkpoint_at IS NULL)
            OR
            (checkpoint_seq > 0 AND checkpoint IS NOT NULL
                AND checkpoint_event IS NOT NULL AND checkpoint_at IS NOT NULL)
        ),
    CONSTRAINT jobs_artifacts_nonempty_array
        CHECK (
            artifacts IS NULL
            OR (jsonb_typeof(artifacts) = 'array' AND jsonb_array_length(artifacts) > 0)
        ),
    CONSTRAINT jobs_task_delivery_has_evidence
        CHECK (
            task_id IS NULL OR status <> 'done'
            OR (artifacts IS NOT NULL AND outcome_event IS NOT NULL)
        )
);

CREATE INDEX jobs_originator_status_idx
    ON jobs (community_id, originator, status);
CREATE INDEX jobs_employee_status_idx
    ON jobs (community_id, employee, status);
CREATE INDEX jobs_expiring_leases_idx
    ON jobs (lease_expires_at) WHERE status = 'leased';
CREATE INDEX jobs_unclaimed_idx
    ON jobs (created_at) WHERE status = 'open';
CREATE INDEX jobs_community_task_idx
    ON jobs (community_id, task_id) WHERE task_id IS NOT NULL;

-- Durable idempotency claims for relay-brokered Colony Company Actions
-- (migration 0029).
--
-- The claim records the owner-signed action, the relay-authored head, and the
-- relay-signed receipt that committed as one transaction, so a replayed action
-- returns its original result instead of creating a second record. Community
-- leads the key so identical retry UUIDs stay independent across tenants.
--
-- Every Company, Initiative, and Task write goes through this table, so a
-- database without it cannot create company state at all: the broker answers
-- `invalid: company action claim lookup failed` and no head is ever authored.
CREATE TABLE IF NOT EXISTS company_action_claims (
    community_id     UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key  UUID NOT NULL,
    action_event_id  BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    head_event_id    BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key)
);

-- One claim per (task, wakeAt) so two relay instances sweeping the same due
-- snoozed task converge on a single wake. Task heads are append-only NIP-33
-- events, so there is no mutable row to lock across the write the way a job
-- lease can be; the claim insert is what makes the sweep idempotent instead.
CREATE TABLE task_wake_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    wake_at BIGINT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, task_id, wake_at)
);

-- 0070: one open task per thread, arbitrated by a row rather than by
-- agreement between clients. Task heads are relay-authored NIP-33 events with
-- no column to constrain, so two clients preparing the same send would each
-- read "no open task" and each create one; the winning INSERT here is the
-- decision, and the loser reads the winner's task id back out.
CREATE TABLE thread_open_tasks (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    owner_pubkey TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('work', 'chat')),
    task_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, channel_id, thread_key, owner_pubkey, slot)
);

CREATE INDEX thread_open_tasks_task_idx ON thread_open_tasks (community_id, task_id);

-- Sub-tasks opened under a thread's task, so the cap is countable in the same
-- transaction that would exceed it and a parent's cascade close has a durable
-- child list to walk.
CREATE TABLE thread_subtasks (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    parent_task_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, parent_task_id, task_id)
);

-- Durable idempotency claims for relay-brokered Colony party actions.
-- Merge actions retain both the surviving head and the retired-handle alias.
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

-- Durable idempotency claims for relay-brokered Colony ledger actions.
CREATE TABLE ledger_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    head_event_id BYTEA NOT NULL CHECK (octet_length(head_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, idempotency_key)
);

-- 0056: channel workspace tabs — who owns a tab, and who is driving it now.
--
-- One row per tab per channel, and the only authority on the driver seat.
--
-- Ownership cannot live in the tab head event alone. NIP-33 replaceable events
-- are keyed (community, kind, pubkey, d_tag) — author included — so two members
-- publishing the same tab id produce two live heads, each naming a different
-- driver, both equally valid. Mutual exclusion needs a compare-and-set against
-- one row, exactly as the job queue found in 0044.
--
-- The head event still exists, but it is a relay-signed PROJECTION of this row
-- rather than the state itself. Its `d` carries the channel coordinate, because
-- the replaceable index has no channel component and two channels would
-- otherwise collide on the same tab id.
--
-- What is deliberately absent: the tab's payload. Scratchpad text, file paths
-- and image bytes stay on the device that holds them. A file path is
-- meaningless on another machine, and the relay has no reason to hold any of it.
CREATE TABLE IF NOT EXISTS workspace_tabs (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id   UUID NOT NULL,
    -- Client-chosen, unique within a channel. Never a UUID requirement: it is
    -- opaque here and only ever compared for equality.
    tab_id       TEXT NOT NULL,
    -- The registry kind string (`scratchpad`, `file`, `image`). Opaque to the
    -- relay: it never branches on this, it only stores and projects it.
    tab_kind     TEXT NOT NULL CHECK (length(tab_kind) BETWEEN 1 AND 64),
    title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    -- Whoever opened the tab. Immutable: it is the answer to "whose tab is
    -- this", and a mutable creator would make the audit trail meaningless.
    creator      BYTEA NOT NULL,
    -- The seat with authority over the tab. Starts as the creator.
    owner        BYTEA NOT NULL,
    -- The single active driver. This column IS the "one driver at a time" rule.
    driver       BYTEA NOT NULL,
    -- Bumped on every transition. Every mutation is conditional on the caller's
    -- expected revision, so two racing transitions produce one winner and one
    -- no-op rather than a last-writer-wins scramble.
    revision     BIGINT NOT NULL DEFAULT 1,
    -- Strictly increasing stamp for the projected head's `created_at`. NIP-33
    -- resolves revisions at one-second resolution and two transitions in the
    -- same second are ordinary here, so the wall clock cannot be trusted to
    -- order them. Same device as jobs.head_at (migration 0044).
    head_at      BIGINT NOT NULL,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL,
    PRIMARY KEY (community_id, channel_id, tab_id),
    FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workspace_tabs_channel_idx
    ON workspace_tabs (community_id, channel_id);

-- An agent's tab list is "tabs I own or drive", asked per channel.
CREATE INDEX IF NOT EXISTS workspace_tabs_driver_idx
    ON workspace_tabs (community_id, channel_id, driver);

-- ── Operator analytics read model ────────────────────────────────────────────
-- The activity projection and cursor are tenant-scoped and rebuildable.  The
-- access log is the only deployment-global object in this section.

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

-- Ported from migrations/0059_community_deletion.sql + 0060_community_deletion_recovery.sql
-- (upstream community-deletion + storage-sweep tables; 0060 adds terminal abort recovery)
CREATE TABLE community_deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 0060 dropped the blanket UNIQUE here: an aborted request must not
    -- permanently consume the community's one active deletion slot. The one-
    -- active-slot rule lives in the partial unique index below.
    community_id UUID NOT NULL REFERENCES communities(id),
    community_host TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'submitted' CHECK (stage IN (
        'submitted', 'inventoried', 'approved', 'fenced', 'drained',
        'bindings_removed', 'postgres_purged', 'cache_purged',
        'logically_verified', 'retention_pending', 'aborted'
    )),
    requested_by TEXT NOT NULL,
    reason TEXT,
    schema_manifest JSONB,
    storage_manifest JSONB,
    destructive_storage_manifest JSONB,
    destructive_storage_frozen_at TIMESTAMPTZ,
    inventory_manifest JSONB,
    inventory_digest BYTEA CHECK (inventory_digest IS NULL OR length(inventory_digest) = 32),
    inventory_frozen_at TIMESTAMPTZ,
    fence_generation BIGINT CHECK (fence_generation IS NULL OR fence_generation > 0),
    lease_owner TEXT,
    lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_until TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    retry_stage TEXT CHECK (retry_stage IS NULL OR retry_stage IN (
        'approved', 'fenced', 'drained', 'bindings_removed',
        'postgres_purged', 'cache_purged', 'logically_verified'
    )),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    last_error_at TIMESTAMPTZ,
    blocked_at TIMESTAMPTZ,
    blocked_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    -- 0060 terminal abort recovery.
    pre_quiesce_archived_at TIMESTAMPTZ,
    quiescing_started_at TIMESTAMPTZ,
    aborted_by TEXT,
    abort_reason TEXT,
    aborted_at TIMESTAMPTZ,
    CHECK ((blocked_at IS NULL) = (blocked_reason IS NULL)),
    CHECK ((inventory_frozen_at IS NULL) = (inventory_digest IS NULL)),
    CHECK ((stage = 'aborted') = (aborted_at IS NOT NULL)),
    CHECK ((aborted_at IS NULL) = (aborted_by IS NULL)),
    CHECK ((aborted_at IS NULL) = (abort_reason IS NULL)),
    UNIQUE (id, community_id, inventory_digest)
);;

CREATE TABLE community_deletion_checkpoints (
    request_id UUID NOT NULL REFERENCES community_deletion_requests(id) ON DELETE RESTRICT,
    sequence BIGINT GENERATED ALWAYS AS IDENTITY,
    stage TEXT NOT NULL,
    unit_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
    lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, sequence),
    UNIQUE (request_id, stage, unit_key),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CHECK ((status = 'failed') = (error IS NOT NULL))
);;

CREATE TABLE community_deletion_manifest_keys (
    request_id UUID NOT NULL REFERENCES community_deletion_requests(id) ON DELETE CASCADE,
    chunk_no BIGINT NOT NULL CHECK (chunk_no >= 0),
    prefix TEXT NOT NULL,
    keys JSONB NOT NULL,
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, chunk_no)
);;

CREATE TABLE storage_taxonomy_sweeps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    listed_objects BIGINT NOT NULL CHECK (listed_objects >= 0),
    unknown_object_count BIGINT NOT NULL CHECK (unknown_object_count >= 0),
    unknown_key_sample JSONB NOT NULL DEFAULT '[]'::jsonb,
    object_cap BIGINT NOT NULL CHECK (object_cap > 0),
    CHECK (completed_at >= started_at)
);;

CREATE TABLE community_serving_write_leases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id),
    operation TEXT NOT NULL,
    owner TEXT NOT NULL,
    generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
    -- Community fence generation observed when this lease was acquired.
    fence_generation BIGINT NOT NULL CHECK (fence_generation >= 0),
    lease_until TIMESTAMPTZ NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);;

CREATE TABLE community_deletion_executor_heartbeats (
    executor_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('run', 'drain', 'worker')),
    request_id UUID REFERENCES community_deletion_requests(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    draining BOOLEAN NOT NULL DEFAULT false,
    stopped_at TIMESTAMPTZ
);;


-- Aborted requests remain immutable audit evidence, but must not permanently
-- consume the community's one active deletion slot (migration 0060).
CREATE UNIQUE INDEX community_deletion_requests_active_community
    ON community_deletion_requests (community_id)
    WHERE stage <> 'aborted';
CREATE INDEX community_deletion_requests_runnable
    ON community_deletion_requests (next_attempt_at, created_at)
    WHERE blocked_at IS NULL
      AND stage IN ('approved', 'fenced', 'drained', 'bindings_removed',
                    'postgres_purged', 'cache_purged', 'logically_verified');
CREATE INDEX community_deletion_requests_lease
    ON community_deletion_requests (lease_until)
    WHERE lease_owner IS NOT NULL;
CREATE INDEX storage_taxonomy_sweeps_latest
    ON storage_taxonomy_sweeps (completed_at DESC);
CREATE INDEX community_serving_write_leases_active
    ON community_serving_write_leases (community_id, lease_until);


-- Ported from migrations/0059_community_deletion.sql (community-deletion approvals)
CREATE TABLE community_deletion_approvals (
    request_id UUID PRIMARY KEY,
    community_id UUID NOT NULL,
    inventory_digest BYTEA NOT NULL CHECK (length(inventory_digest) = 32),
    approved_by TEXT NOT NULL,
    note TEXT,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (request_id, community_id, inventory_digest)
        REFERENCES community_deletion_requests(id, community_id, inventory_digest)
        ON DELETE RESTRICT
);;


-- ── Deletion evidence immutability guards (migration 0059) ──────────────────
-- The approval identity is only meaningful while its frozen target and
-- inventory remain unchanged. Make those facts irreversible in the database,
-- not merely conventions in the worker.
CREATE FUNCTION prevent_community_deletion_request_retargeting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.community_id IS DISTINCT FROM OLD.community_id
        OR NEW.community_host IS DISTINCT FROM OLD.community_host
    THEN
        RAISE EXCEPTION 'community deletion target identity is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.inventory_frozen_at IS NOT NULL AND (
        NEW.schema_manifest IS DISTINCT FROM OLD.schema_manifest
        OR NEW.storage_manifest IS DISTINCT FROM OLD.storage_manifest
        OR NEW.inventory_manifest IS DISTINCT FROM OLD.inventory_manifest
        OR NEW.inventory_digest IS DISTINCT FROM OLD.inventory_digest
        OR NEW.inventory_frozen_at IS DISTINCT FROM OLD.inventory_frozen_at
    ) THEN
        RAISE EXCEPTION 'frozen community deletion inventory is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.destructive_storage_frozen_at IS NOT NULL AND (
        NEW.destructive_storage_manifest IS DISTINCT FROM OLD.destructive_storage_manifest
        OR NEW.destructive_storage_frozen_at IS DISTINCT FROM OLD.destructive_storage_frozen_at
    ) THEN
        RAISE EXCEPTION 'frozen destructive storage manifest is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER community_deletion_request_retargeting_guard
BEFORE UPDATE ON community_deletion_requests
FOR EACH ROW
EXECUTE FUNCTION prevent_community_deletion_request_retargeting();

CREATE FUNCTION prevent_community_deletion_approval_removal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'community deletion approval evidence is immutable'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER community_deletion_approval_removal_guard
BEFORE UPDATE OR DELETE ON community_deletion_approvals
FOR EACH ROW
EXECUTE FUNCTION prevent_community_deletion_approval_removal();

-- Chunk content is immutable once written; the only permitted update is the
-- one-way deleted_at stamp. New chunks are permitted only while the request is
-- fenced and its destructive manifest remains unfrozen. Removal is permitted
-- only while the destructive manifest has not yet frozen (a retried partial
-- freeze rewrites its chunks) or once the request has passed logical
-- verification (terminal cleanup).
CREATE FUNCTION protect_community_deletion_manifest_keys()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    frozen_at TIMESTAMPTZ;
    request_stage TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.request_id IS DISTINCT FROM OLD.request_id
            OR NEW.chunk_no IS DISTINCT FROM OLD.chunk_no
            OR NEW.prefix IS DISTINCT FROM OLD.prefix
            OR NEW.keys IS DISTINCT FROM OLD.keys
            OR OLD.deleted_at IS NOT NULL
        THEN
            RAISE EXCEPTION 'community deletion manifest key chunks are immutable'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;
    SELECT destructive_storage_frozen_at, stage
      INTO frozen_at, request_stage
      FROM community_deletion_requests
     WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.request_id ELSE OLD.request_id END
     FOR UPDATE;
    IF TG_OP = 'INSERT' THEN
        IF FOUND AND frozen_at IS NULL AND request_stage = 'fenced' THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'community deletion manifest key chunks require an unfrozen fenced request'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT FOUND
        OR frozen_at IS NULL
        OR request_stage IN ('logically_verified', 'retention_pending')
    THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'community deletion manifest key chunks cannot be removed mid-execution'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER community_deletion_manifest_keys_guard
BEFORE INSERT OR UPDATE OR DELETE ON community_deletion_manifest_keys
FOR EACH ROW
EXECUTE FUNCTION protect_community_deletion_manifest_keys();

-- ── Git repo name registry (NIP-34 kind:30617) ───────────────────────────────
-- Ported from migrations/0002_git_repo_names.sql (was KNOWN_DRIFT; needed by the
-- community serving-fence catalog, which requires every scoped table to exist
-- with a write fence).
CREATE TABLE git_repo_names (
    community_id  UUID NOT NULL REFERENCES communities(id),
    repo_id       TEXT NOT NULL,
    owner_pubkey  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, repo_id)
);;

-- Backs the per-pubkey repo quota: COUNT(*) WHERE community_id = $1 AND owner_pubkey = $2.
CREATE INDEX idx_git_repo_names_owner ON git_repo_names (community_id, owner_pubkey);

-- ── Parameterized (NIP-33 LWW) read-state watermarks ─────────────────────────
-- Ported from migrations/0007_nip_rs_retention.sql (was KNOWN_DRIFT; required by
-- the community serving-fence catalog).
CREATE TABLE parameterized_event_watermarks (
    community_id  UUID NOT NULL REFERENCES communities(id),
    kind          INT NOT NULL,
    pubkey        BYTEA NOT NULL,
    d_tag         TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL,
    event_id      BYTEA NOT NULL,
    PRIMARY KEY (community_id, kind, pubkey, d_tag)
);;

-- ── NIP-RS / mesh-status database guards ─────────────────────────────────────
-- Ported from migrations/0009 + 0010 + 0011 + 0019 (final bodies: 0011 and
-- 0019). These enforce retention invariants against pre-migration relay
-- binaries during a rolling deployment, so they belong to the desired state,
-- not only to the migration history.
--
-- Every conforming NIP-RS insert must advance the watermark; an insert older
-- than the greatest accepted tuple is rejected even when no live row remains.
-- Exact replay is a durable coordinate-level no-op, independent of whether the
-- physically retained payload still exists.
CREATE FUNCTION guard_nip_rs_watermark() RETURNS trigger AS $$
DECLARE
    advanced BOOLEAN;
BEGIN
    IF NEW.kind = 30078
       AND NEW.d_tag ~ '^read-state:[0-9a-f]{32}$'
       AND (
           SELECT count(*)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.tags) = 'array' THEN NEW.tags ELSE '[]'::jsonb END) tag
           WHERE jsonb_typeof(tag) = 'array'
             AND tag->0 = '"d"'::jsonb
       ) = 1
       AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.tags) = 'array' THEN NEW.tags ELSE '[]'::jsonb END) tag
           WHERE jsonb_typeof(tag) = 'array'
             AND jsonb_array_length(tag) >= 2
             AND jsonb_typeof(tag->1) = 'string'
             AND tag->>0 = 'd'
             AND tag->>1 = NEW.d_tag
       )
       AND (
           SELECT count(*)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.tags) = 'array' THEN NEW.tags ELSE '[]'::jsonb END) tag
           WHERE tag = '["t", "read-state"]'::jsonb
       ) = 1 THEN
        INSERT INTO parameterized_event_watermarks
            (community_id, kind, pubkey, d_tag, created_at, event_id)
        VALUES
            (NEW.community_id, NEW.kind, NEW.pubkey, NEW.d_tag, NEW.created_at, NEW.id)
        ON CONFLICT (community_id, kind, pubkey, d_tag) DO UPDATE SET
            created_at = EXCLUDED.created_at,
            event_id = EXCLUDED.event_id
        WHERE EXCLUDED.created_at > parameterized_event_watermarks.created_at
           OR (EXCLUDED.created_at = parameterized_event_watermarks.created_at
               AND EXCLUDED.event_id < parameterized_event_watermarks.event_id)
        RETURNING TRUE INTO advanced;

        IF NOT COALESCE(advanced, FALSE) THEN
            IF EXISTS (
                SELECT 1
                FROM parameterized_event_watermarks
                WHERE community_id = NEW.community_id
                  AND kind = NEW.kind
                  AND pubkey = NEW.pubkey
                  AND d_tag = NEW.d_tag
                  AND created_at = NEW.created_at
                  AND event_id = NEW.id
            ) THEN
                RETURN NULL;
            END IF;

            RAISE EXCEPTION 'stale NIP-RS event rejected by durable watermark'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A relay binary from before migration 0011 can classify an incoming event by
-- broad EXISTS predicates and hard-delete the current coordinate before its
-- corrected INSERT guard runs. Fail the whole old-writer transaction rather
-- than silently skipping the DELETE. Corrected paths opt in transaction-locally.
CREATE FUNCTION guard_nip_rs_hard_delete() RETURNS trigger AS $$
BEGIN
    IF current_setting('buzz.nip_rs_hard_delete', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'NIP-RS hard delete requires corrected writer opt-in'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- NIP-RS payloads have no historical product value. Enforce physical removal
-- when old relay binaries use their legacy soft-delete path, including NIP-09
-- coordinate deletion during a mixed-version rollout.
CREATE OR REPLACE FUNCTION purge_soft_deleted_nip_rs() RETURNS trigger AS $$
BEGIN
    IF OLD.deleted_at IS NULL
       AND NEW.deleted_at IS NOT NULL
       AND NEW.kind = 30078
       AND NEW.d_tag ~ '^read-state:[0-9a-f]{32}$'
       AND (
           SELECT count(*)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.tags) = 'array' THEN NEW.tags ELSE '[]'::jsonb END) tag
           WHERE jsonb_typeof(tag) = 'array'
             AND tag->0 = '"d"'::jsonb
       ) = 1
       AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.tags) = 'array' THEN NEW.tags ELSE '[]'::jsonb END) tag
           WHERE jsonb_typeof(tag) = 'array'
             AND jsonb_array_length(tag) >= 2
             AND jsonb_typeof(tag->1) = 'string'
             AND tag->>0 = 'd'
             AND tag->>1 = NEW.d_tag
       )
       AND (
           SELECT count(*)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.tags) = 'array' THEN NEW.tags ELSE '[]'::jsonb END) tag
           WHERE tag = '["t", "read-state"]'::jsonb
       ) = 1 THEN
        PERFORM set_config('buzz.nip_rs_hard_delete', 'on', true);

        DELETE FROM events
        WHERE community_id = NEW.community_id
          AND created_at = NEW.created_at
          AND id = NEW.id;

        DELETE FROM event_mentions
        WHERE community_id = NEW.community_id AND event_id = NEW.id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Mesh status is a heartbeat carried in a reserved kind:30003 coordinate
-- (migration 0019). Only the live head has product value; purge superseded
-- soft-deleted payloads written by older relay binaries during rolling deploys.
CREATE FUNCTION purge_soft_deleted_buzz_mesh_status() RETURNS trigger AS $$
BEGIN
    IF OLD.deleted_at IS NULL
       AND NEW.deleted_at IS NOT NULL
       AND NEW.kind = 30003
       AND NEW.d_tag LIKE 'buzz-mesh-member-status:%'
       AND NEW.tags @> '[["k", "buzz-mesh-status"]]'::jsonb THEN
        DELETE FROM events
        WHERE community_id = NEW.community_id
          AND created_at = NEW.created_at
          AND id = NEW.id;

        DELETE FROM event_mentions
        WHERE community_id = NEW.community_id AND event_id = NEW.id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Mention indexing runs after the event transaction commits. Lock the live event
-- row while a mention is inserted so a concurrent hard delete cannot leave an
-- orphan behind; if deletion already won, silently skip the stale index row.
-- (Migration 0009; unchanged by 0010/0011.)
CREATE FUNCTION guard_event_mention_live() RETURNS trigger AS $$
BEGIN
    IF NEW.event_kind IS DISTINCT FROM 30078 THEN
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM events
    WHERE community_id = NEW.community_id
      AND id = NEW.event_id
      AND created_at = NEW.event_created_at
      AND deleted_at IS NULL
    FOR KEY SHARE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers on the partitioned parent propagate to every attached partition.
CREATE TRIGGER trg_events_nip_rs_watermark
    BEFORE INSERT ON events
    FOR EACH ROW EXECUTE FUNCTION guard_nip_rs_watermark();

CREATE TRIGGER trg_events_guard_nip_rs_hard_delete
    BEFORE DELETE ON events
    FOR EACH ROW
    WHEN (OLD.kind = 30078 AND OLD.d_tag ~ '^read-state:[0-9a-f]{32}$')
    EXECUTE FUNCTION guard_nip_rs_hard_delete();

CREATE TRIGGER trg_events_purge_soft_deleted_nip_rs
    AFTER UPDATE OF deleted_at ON events
    FOR EACH ROW EXECUTE FUNCTION purge_soft_deleted_nip_rs();

CREATE TRIGGER trg_events_purge_soft_deleted_buzz_mesh_status
    AFTER UPDATE OF deleted_at ON events
    FOR EACH ROW EXECUTE FUNCTION purge_soft_deleted_buzz_mesh_status();

CREATE TRIGGER trg_event_mentions_require_live_event
    BEFORE INSERT ON event_mentions
    FOR EACH ROW EXECUTE FUNCTION guard_event_mention_live();

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('community_deletion_requests', 'deployment deletion lifecycle and frozen inventory'),
    ('community_deletion_approvals', 'deployment operator destructive approvals'),
    ('community_deletion_checkpoints', 'deployment deletion executor checkpoints and failures'),
    ('community_deletion_manifest_keys', 'deployment deletion frozen destructive key chunks'),
    ('storage_taxonomy_sweeps', 'deployment object-store taxonomy sweep evidence'),
    ('community_serving_write_leases', 'deployment serving side-effect leases drained by deletion'),
    ('community_deletion_executor_heartbeats', 'deployment deletion worker liveness');

CREATE FUNCTION community_deletion_lock_key(target UUID) RETURNS BIGINT
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT hashtextextended('buzz-community-deletion:' || target::text, 0)
$$;
-- Keep the deletion control plane writable while its target tenant is fenced.
-- This predicate is the single SQL source of truth used by attachment and live
-- catalog validation.
CREATE FUNCTION community_write_fence_excluded_table(target NAME) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT target::TEXT = ANY (ARRAY[
        'community_deletion_requests',
        'community_deletion_approvals',
        'community_deletion_checkpoints',
        'community_serving_write_leases',
        'community_deletion_executor_heartbeats',
        'product_feedback',
        'rate_limit_violations'
    ]::TEXT[])
$$;

-- Fleet-wide writers filter candidates through this VOLATILE predicate in
-- the mutating statement so fenced tenants are skipped before row triggers run.
CREATE FUNCTION community_write_allowed(target UUID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    lifecycle TEXT;
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'community writes require READ COMMITTED isolation'
            USING ERRCODE = 'invalid_transaction_state';
    END IF;

    IF target IS NULL THEN
        RETURN true;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(community_deletion_lock_key(target));
    SELECT deletion_state
      INTO lifecycle
      FROM communities
     WHERE id = target;
    RETURN FOUND AND lifecycle = 'active';
END
$$;

CREATE FUNCTION assert_community_write_allowed(target UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    lifecycle TEXT;
    generation BIGINT;
    executor_community TEXT;
    executor_generation TEXT;
    serving_community TEXT;
    serving_lease_id TEXT;
    serving_owner TEXT;
    serving_generation TEXT;
    serving_fence_generation TEXT;
    serving_lease_valid BOOLEAN := false;
BEGIN
    -- The fence proof requires a fresh statement snapshot after lock grant;
    -- pinned RR/Serializable snapshots can retain pre-fence authorization.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'community writes require READ COMMITTED isolation'
            USING ERRCODE = 'invalid_transaction_state';
    END IF;

    -- Nullable operator-attribution rows without a tenant are unrelated.
    IF target IS NULL THEN
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(community_deletion_lock_key(target));
    SELECT deletion_state, deletion_fence_generation
      INTO lifecycle, generation
      FROM communities
     WHERE id = target;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'community write rejected: community % is missing', target
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- Authorization is evaluated independently for every community checked.
    executor_community := current_setting('buzz.deletion_executor_community', true);
    executor_generation := current_setting('buzz.deletion_fence_generation', true);
    IF executor_community = target::TEXT
       AND executor_generation ~ '^[0-9]+$'
       AND executor_generation::BIGINT = generation THEN
        RETURN;
    END IF;

    -- A serving mutation admitted before quiescing may finish only while its
    -- exact durable lease remains current and bound to this fence generation.
    serving_community := current_setting('buzz.serving_write_community', true);
    serving_lease_id := current_setting('buzz.serving_write_lease_id', true);
    serving_owner := current_setting('buzz.serving_write_owner', true);
    serving_generation := current_setting('buzz.serving_write_generation', true);
    serving_fence_generation := current_setting('buzz.serving_write_fence_generation', true);
    IF lifecycle IN ('active', 'quiescing')
       AND serving_community = target::TEXT
       AND serving_lease_id ~ '^[0-9a-fA-F-]{36}$'
       AND serving_generation ~ '^[0-9]+$'
       AND serving_fence_generation ~ '^[0-9]+$'
       AND serving_fence_generation::BIGINT = generation THEN
        SELECT EXISTS(
            SELECT 1 FROM community_serving_write_leases lease
             WHERE lease.id = serving_lease_id::UUID
               AND lease.community_id = target
               AND lease.owner = serving_owner
               AND lease.generation = serving_generation::BIGINT
               AND lease.fence_generation = serving_fence_generation::BIGINT
               AND lease.lease_until >= now()
        ) INTO serving_lease_valid;
        IF serving_lease_valid THEN
            RETURN;
        END IF;
    END IF;

    IF lifecycle <> 'active' THEN
        RAISE EXCEPTION 'community write fenced: community % generation %', target, generation
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
END
$$;

CREATE FUNCTION enforce_community_write_fence() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM assert_community_write_allowed(NEW.community_id);
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM assert_community_write_allowed(OLD.community_id);
    ELSIF OLD.community_id IS NOT DISTINCT FROM NEW.community_id THEN
        PERFORM assert_community_write_allowed(OLD.community_id);
    ELSIF OLD.community_id IS NULL THEN
        PERFORM assert_community_write_allowed(NEW.community_id);
    ELSIF NEW.community_id IS NULL THEN
        PERFORM assert_community_write_allowed(OLD.community_id);
    ELSIF OLD.community_id < NEW.community_id THEN
        PERFORM assert_community_write_allowed(OLD.community_id);
        PERFORM assert_community_write_allowed(NEW.community_id);
    ELSE
        PERFORM assert_community_write_allowed(NEW.community_id);
        PERFORM assert_community_write_allowed(OLD.community_id);
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE FUNCTION enforce_community_tombstone() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    executor_community TEXT := current_setting('buzz.deletion_executor_community', true);
    executor_generation TEXT := current_setting('buzz.deletion_fence_generation', true);
    expected_generation BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.deletion_state <> 'active' OR OLD.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'community tombstones are permanent'
                USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        RETURN OLD;
    END IF;
    expected_generation := CASE WHEN NEW.deletion_fence_generation > OLD.deletion_fence_generation
        THEN NEW.deletion_fence_generation ELSE OLD.deletion_fence_generation END;
    IF executor_community = OLD.id::text AND executor_generation ~ '^[0-9]+$'
       AND executor_generation::BIGINT = expected_generation THEN RETURN NEW; END IF;
    IF OLD.deletion_state <> 'active' OR NEW.deletion_state <> OLD.deletion_state
       OR NEW.deletion_fence_generation <> OLD.deletion_fence_generation
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        RAISE EXCEPTION 'community tombstone mutation rejected: community % generation %',
            OLD.id, OLD.deletion_fence_generation
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER communities_deletion_tombstone BEFORE UPDATE OR DELETE ON communities
FOR EACH ROW EXECUTE FUNCTION enforce_community_tombstone();
-- Email and password accounts with zero-knowledge key escrow.
--
-- The relay stores two opaque NIP-49 blobs per account. Both encrypt the same
-- private key: one under the user's password, one under their recovery code.
-- Neither the password nor the key is ever transmitted, so neither can be
-- recovered from this table.
--
-- Named email_accounts because migration 0050 already owns `accounts` for
-- identity-global credit balances. These rows are tenant scoped instead.
CREATE TABLE email_accounts (
    community_id       UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    id                 UUID NOT NULL DEFAULT gen_random_uuid(),
    email              TEXT NOT NULL,
    pubkey             TEXT NOT NULL CHECK (length(pubkey) = 64),
    auth_hash          TEXT NOT NULL,
    password_blob      TEXT NOT NULL,
    recovery_blob      TEXT NOT NULL,
    recovery_code_hash TEXT NOT NULL CHECK (length(recovery_code_hash) = 64),
    kdf_version        SMALLINT NOT NULL DEFAULT 1 CHECK (kdf_version > 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_signin_at     TIMESTAMPTZ,
    failed_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until       TIMESTAMPTZ,
    PRIMARY KEY (community_id, id)
);

-- Uniqueness is per community, and lower() in the index means the database
-- enforces normalisation rather than trusting every caller to apply it.
CREATE UNIQUE INDEX email_accounts_community_email_idx
    ON email_accounts (community_id, lower(email));
CREATE UNIQUE INDEX email_accounts_community_pubkey_idx
    ON email_accounts (community_id, pubkey);

-- Single-use, short-lived proof that a recovery code was presented, so the
-- password reset that follows does not have to carry the code again. Tenant
-- scoped like its parent so the write fence and the deletion purge cover it
-- directly instead of relying on cascade timing.
CREATE TABLE account_reset_tokens (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    account_id   UUID NOT NULL,
    token_hash   TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, token_hash),
    FOREIGN KEY (community_id, account_id)
        REFERENCES email_accounts (community_id, id) ON DELETE CASCADE
);

CREATE INDEX account_reset_tokens_expiry_idx
    ON account_reset_tokens (expires_at);

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
    provider      TEXT NOT NULL DEFAULT 'paystack'
                  CHECK (provider IN ('paystack', 'payfast')),
    paid_cents    BIGINT,
    -- Credit packs. No South African gateway may charge in USD (SARB permits
    -- ZAR-denominated processing only), so what the gateway collects is often
    -- in a different currency from what the ledger grants. Both are recorded
    -- rather than derived: converting between them would put the currency
    -- risk on Colony, and recomputing the grant at settlement would let a
    -- price edit change what an in-flight purchase is worth.
    pack_id             TEXT,
    charge_minor_units  BIGINT
                        CHECK (charge_minor_units IS NULL OR charge_minor_units > 0),
    charge_currency     TEXT
                        CHECK (charge_currency IS NULL OR charge_currency IN ('ZAR', 'USD')),
    grant_nanousd       BIGINT
                        CHECK (grant_nanousd IS NULL OR grant_nanousd > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at    TIMESTAMPTZ,
    PRIMARY KEY (community_id, reference),
    -- Nullable for rows predating packs, which were free-amount top-ups
    -- priced in USD. The four travel together or not at all; a row holding
    -- some but not others would be a bug in the writer, not a state any
    -- reader should have to model.
    CONSTRAINT payment_intents_pack_columns_travel_together CHECK (
        (pack_id IS NULL
            AND charge_minor_units IS NULL
            AND charge_currency IS NULL
            AND grant_nanousd IS NULL)
        OR (pack_id IS NOT NULL
            AND charge_minor_units IS NOT NULL
            AND charge_currency IS NOT NULL
            AND grant_nanousd IS NOT NULL)
    )
);

CREATE INDEX payment_intents_pubkey_idx ON payment_intents (community_id, pubkey);

-- Attach the universal fence to one community-scoped relation. Future
-- migrations must invoke this helper explicitly after CREATE/ALTER introduces
-- community_id; the migration lint enforces that contract.
CREATE FUNCTION attach_community_write_fence(target REGCLASS) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    relation_name NAME;
BEGIN
    SELECT c.relname
      INTO relation_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = target
       AND n.nspname = current_schema()
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'community write fence target % is not a table in the current schema', target
            USING ERRCODE = 'wrong_object_type';
    END IF;
    IF community_write_fence_excluded_table(relation_name) THEN
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = target AND attname = 'community_id' AND NOT attisdropped
    ) THEN
        RAISE EXCEPTION 'community write fence target % has no community_id', target
            USING ERRCODE = 'undefined_column';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = target
           AND tgname = 'community_write_fence_' || relation_name
           AND NOT tgisinternal
    ) THEN
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %s '
            'FOR EACH ROW EXECUTE FUNCTION enforce_community_write_fence()',
            'community_write_fence_' || relation_name,
            target
        );
    END IF;
END
$$;

-- Attach the universal fence to every existing table carrying community_id,
-- including deployment-private sidecars whose community_id is provenance.
DO $$
DECLARE
    target REGCLASS;
BEGIN
    FOR target IN
        SELECT c.oid::REGCLASS
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE n.nspname = current_schema()
           AND c.relkind IN ('r', 'p')
           AND NOT c.relispartition
           AND a.attname = 'community_id'
           AND NOT a.attisdropped
           AND NOT community_write_fence_excluded_table(c.relname)
         ORDER BY c.oid::REGCLASS::TEXT
    LOOP
        PERFORM attach_community_write_fence(target);
    END LOOP;
END
$$;

-- Desired-state schema application does not replay migration history, so keep
-- these explicit calls as first-class catalog declarations. They also make the
-- fence contract visible to migration linting instead of hiding it only in the
-- dynamic bootstrap loop above.
SELECT attach_community_write_fence('account_reset_tokens');
SELECT attach_community_write_fence('api_tokens');
SELECT attach_community_write_fence('archived_identities');
SELECT attach_community_write_fence('asks');
SELECT attach_community_write_fence('audit_log');
SELECT attach_community_write_fence('block_action_claims');
SELECT attach_community_write_fence('block_catalog_action_claims');
SELECT attach_community_write_fence('channel_members');
SELECT attach_community_write_fence('channels');
SELECT attach_community_write_fence('community_bans');
SELECT attach_community_write_fence('company_action_claims');
SELECT attach_community_write_fence('delivery_log');
SELECT attach_community_write_fence('discovery_action_claims');
SELECT attach_community_write_fence('discovery_actor_grants');
SELECT attach_community_write_fence('discovery_business_observations');
SELECT attach_community_write_fence('discovery_campaign_leads');
SELECT attach_community_write_fence('discovery_budget_approval_claims');
SELECT attach_community_write_fence('discovery_campaigns');
SELECT attach_community_write_fence('discovery_entitlements');
SELECT attach_community_write_fence('discovery_gateway_attempts');
SELECT attach_community_write_fence('discovery_lead_profiles');
SELECT attach_community_write_fence('discovery_observation_batches');
SELECT attach_community_write_fence('discovery_run_business_searches');
SELECT attach_community_write_fence('discovery_run_checkpoints');
SELECT attach_community_write_fence('discovery_run_source_plans');
SELECT attach_community_write_fence('discovery_run_sources');
SELECT attach_community_write_fence('discovery_runs');
SELECT attach_community_write_fence('discovery_source_observation_batches');
SELECT attach_community_write_fence('discovery_source_usage');
SELECT attach_community_write_fence('discovery_usage');
SELECT attach_community_write_fence('discovery_worker_action_claims');
SELECT attach_community_write_fence('discovery_workspace_action_claims');
SELECT attach_community_write_fence('discovery_workspace_protocols');
SELECT attach_community_write_fence('email_accounts');
SELECT attach_community_write_fence('employees');
SELECT attach_community_write_fence('event_mentions');
SELECT attach_community_write_fence('events');
SELECT attach_community_write_fence('git_repo_names');
SELECT attach_community_write_fence('jobs');
SELECT attach_community_write_fence('join_policy_acceptances');
SELECT attach_community_write_fence('ledger_action_claims');
SELECT attach_community_write_fence('moderation_actions');
SELECT attach_community_write_fence('moderation_reports');
SELECT attach_community_write_fence('operator_activity_cursor');
SELECT attach_community_write_fence('operator_activity_daily');
SELECT attach_community_write_fence('parameterized_event_watermarks');
SELECT attach_community_write_fence('party_action_claims');
SELECT attach_community_write_fence('payment_intents');
SELECT attach_community_write_fence('pubkey_allowlist');
SELECT attach_community_write_fence('push_leases');
SELECT attach_community_write_fence('push_match_queue');
SELECT attach_community_write_fence('push_wake_outbox');
SELECT attach_community_write_fence('reactions');
SELECT attach_community_write_fence('relay_invites');
SELECT attach_community_write_fence('relay_members');
SELECT attach_community_write_fence('scheduled_workflow_fires');
SELECT attach_community_write_fence('subscriptions');
SELECT attach_community_write_fence('task_wake_claims');
SELECT attach_community_write_fence('thread_metadata');
SELECT attach_community_write_fence('thread_open_tasks');
SELECT attach_community_write_fence('thread_subtasks');
SELECT attach_community_write_fence('users');
SELECT attach_community_write_fence('workflow_approvals');
SELECT attach_community_write_fence('workflow_runs');
SELECT attach_community_write_fence('workflows');
SELECT attach_community_write_fence('workspace_tabs');
