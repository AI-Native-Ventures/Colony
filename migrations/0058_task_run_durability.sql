-- 0058: durable execution state for Task-linked employee jobs.
--
-- This extends the existing job queue instead of introducing a second
-- scheduler. Every column is nullable or has a backward-compatible default,
-- so filings created by older relay versions remain valid legacy jobs.
ALTER TABLE jobs ADD COLUMN task_id TEXT;
ALTER TABLE jobs ADD COLUMN checkpoint_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN checkpoint JSONB;
ALTER TABLE jobs ADD COLUMN checkpoint_event BYTEA;
ALTER TABLE jobs ADD COLUMN checkpoint_at BIGINT;
ALTER TABLE jobs ADD COLUMN artifacts JSONB;
ALTER TABLE jobs ADD COLUMN outcome_event BYTEA;

ALTER TABLE jobs
    ADD CONSTRAINT jobs_task_id_bounded
        CHECK (task_id IS NULL OR (LENGTH(BTRIM(task_id)) BETWEEN 1 AND 128)),
    ADD CONSTRAINT jobs_checkpoint_sequence_nonnegative
        CHECK (checkpoint_seq >= 0),
    ADD CONSTRAINT jobs_checkpoint_event_shape
        CHECK (checkpoint_event IS NULL OR LENGTH(checkpoint_event) = 32),
    ADD CONSTRAINT jobs_outcome_event_shape
        CHECK (outcome_event IS NULL OR LENGTH(outcome_event) = 32),
    ADD CONSTRAINT jobs_checkpoint_complete
        CHECK (
            (checkpoint_seq = 0 AND checkpoint IS NULL
                AND checkpoint_event IS NULL AND checkpoint_at IS NULL)
            OR
            (checkpoint_seq > 0 AND checkpoint IS NOT NULL
                AND checkpoint_event IS NOT NULL AND checkpoint_at IS NOT NULL)
        ),
    ADD CONSTRAINT jobs_artifacts_nonempty_array
        CHECK (
            artifacts IS NULL
            OR (jsonb_typeof(artifacts) = 'array' AND jsonb_array_length(artifacts) > 0)
        ),
    ADD CONSTRAINT jobs_task_delivery_has_evidence
        CHECK (
            task_id IS NULL OR status <> 'done'
            OR (artifacts IS NOT NULL AND outcome_event IS NOT NULL)
        );

CREATE INDEX jobs_community_task_idx
    ON jobs (community_id, task_id)
    WHERE task_id IS NOT NULL;
