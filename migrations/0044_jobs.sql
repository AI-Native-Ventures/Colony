-- 0044: the job queue — work an employee owes, and the lease that makes
-- exactly one machine responsible for it at a time.
--
-- An employee's identity lives on the relay and its execution lives on
-- members' laptops (docs/design/company-employees.html). That split leaves one
-- question this table answers: when two founders both have a machine that
-- could run the Chief of Staff, which one is running THIS task, and what
-- happens when that machine dies halfway through?
--
-- Nostr events cannot answer it. They are append-only and unordered across
-- clients, so two workers appending "I'll take it" are both equally true.
-- Mutual exclusion needs a compare-and-set against one authority, which is
-- this row: a claim only lands if the job is open or its lease has lapsed, so
-- two racing workers produce one winner and one no-op. Everything else in the
-- queue is bookkeeping around that single UPDATE.
--
-- Nothing here trusts a worker to announce its own death, because the failure
-- this exists to survive is precisely the one where it cannot. A lease has a
-- deadline; heartbeats push the deadline out; silence lets it lapse.
CREATE TABLE IF NOT EXISTS jobs (
    community_id     UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    -- The filing event id. Using the signed event as the job id means a
    -- retried filing is the same job, and every reference to a job is a
    -- reference to a signed statement of who asked for it.
    job_id           BYTEA NOT NULL,
    -- The employee that owes the work.
    employee         BYTEA NOT NULL,
    -- Whoever signed the filing. For a delegated job this is the employee
    -- that delegated, not the human the job belongs to.
    filed_by         BYTEA NOT NULL,
    -- The human the work belongs to, and the only seat allowed to claim it.
    -- Delegation chains inherit this from the parent job rather than
    -- re-pointing at the delegating employee, so the Chief of Staff tagging
    -- Sift on a founder's behalf still produces that founder's job.
    originator       BYTEA NOT NULL,
    -- Where the job came from, when it came from somewhere. A job filed by
    -- CLI or by a background process has neither.
    channel_id       UUID,
    thread           BYTEA,
    instruction      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','leased','done','failed','abandoned')),
    -- The seat holding the lease, and when that lease lapses. Kept after a
    -- terminal status as the record of which seat did the work.
    lease_holder     BYTEA,
    lease_expires_at BIGINT,
    -- How many times this job has been leased. Capped, so a job that
    -- reliably kills its worker does not take every seat in the company down
    -- in turn (buzz_core::job::MAX_JOB_ATTEMPTS).
    attempts         INTEGER NOT NULL DEFAULT 0,
    result           TEXT,
    failure          TEXT,
    -- The stall ask filed about this job, set once. Its presence is what
    -- stops the sweep re-asking a human every tick about the same dead job.
    escalated_ask    BYTEA,
    -- The `created_at` of the last job head published for this job.
    --
    -- Job heads are NIP-33 replaceable, and NIP-33 resolves two revisions by
    -- `created_at`, at one-second resolution. Filing and claiming routinely
    -- happen in the same second, so a head stamped with the wall clock would
    -- tie with the one it is meant to replace and readers would keep showing
    -- the older state — a worker would claim a job successfully and then read
    -- back that the job is still open. Publishing bumps this to
    -- `GREATEST(head_at + 1, now)`, which makes each job's heads strictly
    -- increasing and the replacement unambiguous for every reader.
    head_at          BIGINT NOT NULL DEFAULT 0,
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL,
    PRIMARY KEY (community_id, job_id),
    CHECK (LENGTH(job_id) = 32),
    CHECK (LENGTH(employee) = 32),
    CHECK (LENGTH(filed_by) = 32),
    CHECK (LENGTH(originator) = 32),
    CHECK (thread IS NULL OR LENGTH(thread) = 32),
    CHECK (lease_holder IS NULL OR LENGTH(lease_holder) = 32),
    CHECK (escalated_ask IS NULL OR LENGTH(escalated_ask) = 32),
    -- A lease is the whole point, so its two halves may not disagree with
    -- the status. An open job showing a holder, or a leased job showing no
    -- deadline, would each be a queue that has lost track of who is working.
    CHECK (
        (status = 'open' AND lease_holder IS NULL AND lease_expires_at IS NULL)
        OR (status = 'leased' AND lease_holder IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR status IN ('done','failed','abandoned')
    )
);

-- A worker asks one question on repeat: what open work is mine? Answering it
-- from an index rather than a scan is what lets the queue be polled often.
CREATE INDEX IF NOT EXISTS jobs_originator_status_idx
    ON jobs (community_id, originator, status);

-- An employee's own queue, for the roster and any UI that shows what a
-- colleague is carrying.
CREATE INDEX IF NOT EXISTS jobs_employee_status_idx
    ON jobs (community_id, employee, status);

-- The two sweeps run across every community at once, the same way the
-- interrupt sweep does, so these lead with status rather than community_id.
-- Both are partial: a finished job is the overwhelming majority of rows and
-- neither sweep ever wants to see one.
CREATE INDEX IF NOT EXISTS jobs_expiring_leases_idx
    ON jobs (lease_expires_at) WHERE status = 'leased';

CREATE INDEX IF NOT EXISTS jobs_unclaimed_idx
    ON jobs (created_at) WHERE status = 'open';
