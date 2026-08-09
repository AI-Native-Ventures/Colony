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
