-- Durable claims for the snooze-wake sweep, safe across two relay instances.
--
-- Task heads are relay-authored NIP-33 events -- append-only, no mutable
-- lease column a `FOR UPDATE SKIP LOCKED` scan could hold across the sweep's
-- own write. `company_action_claims` already solves this exact shape of
-- problem (an idempotency-key insert that only one writer can win) for
-- owner-signed actions; this mirrors it for the sweep's own autonomous
-- writes. Keyed by (community, task, the specific wakeAt being honoured) so
-- a task re-snoozed to a new time after a claim is a fresh key, correctly
-- reprocessed rather than permanently blocked by a stale claim.
CREATE TABLE task_wake_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    wake_at BIGINT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, task_id, wake_at)
);
