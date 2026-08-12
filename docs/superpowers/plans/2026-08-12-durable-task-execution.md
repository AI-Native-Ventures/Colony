# Durable Task Execution Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Colony's employee job queue so a canonical Task has a durable, checkpointed, recoverable run that can be Delivered only with declared artifact evidence.

**Architecture:** Keep `CompanyTask` as the owner-controlled planning record and extend the existing Postgres-backed job queue as its execution record. Add optional Task linkage for backward compatibility, one fenced checkpoint request kind, artifact-gated outcomes for Task-linked jobs, and project accepted state through the existing employee-signed job head.

**Tech Stack:** Rust, Nostr events, PostgreSQL/sqlx, clap, `buzz-core`, `buzz-db`, `buzz-relay`, `buzz-cli`, `buzz-test-client`.

---

## File map and guardrails

- `crates/buzz-core/src/kind.rs`: reserve `KIND_JOB_CHECKPOINT`.
- `crates/buzz-core/src/job.rs`: checkpoint/artifact types, strict parsers, Task linkage, extended head.
- `migrations/0058_task_run_durability.sql`: additive Task-run persistence.
- `crates/buzz-db/src/migration.rs`: register and structurally test migration 0064.
- `crates/buzz-db/src/jobs.rs` and `src/lib.rs`: row fields and fenced checkpoint/delivery updates.
- `crates/buzz-relay/src/job_broker.rs`: Task existence, checkpoint arbitration, delivery gate, head projection.
- `crates/buzz-relay/src/handlers/ingest.rs`: admission and broker routing for kind 43014.
- `crates/buzz-cli/src/lib.rs` and `commands/jobs.rs`: public syntax and event construction.
- `crates/buzz-test-client/tests/e2e_jobs.rs`: real-relay interruption/recovery proof.

Do not touch dashboard, billing, playbook, connector, browser, cloud-fleet, or desktop UI code. Preserve all legacy job syntax and behavior.

## Task 1: Pin the core wire contract

**Files:**

- Modify: `crates/buzz-core/src/kind.rs`
- Modify: `crates/buzz-core/src/job.rs`

- [ ] **Step 1: Write failing kind and parser tests**

Require `KIND_JOB_CHECKPOINT == 43014`, inclusion in `KINDS`, and normal member-authored stored classification. Add a positive parser case:

```rust
let parsed = parse_job_checkpoint(&event(
    KIND_JOB_CHECKPOINT as u16,
    r#"{"summary":"Audited sources","resumeToken":"synthesis","progress":55}"#,
    vec![vec!["job", JOB], vec!["attempt", "1"], vec!["sequence", "2"]],
))?;
assert_eq!(parsed.sequence, 2);
assert_eq!(parsed.checkpoint.progress, Some(55));
```

Add negative tests for missing/duplicate tags, sequence below 1, progress outside 0-100, unknown JSON fields, oversized text, malformed artifacts, and Task-linked `done` with no artifact.

- [ ] **Step 2: Run red tests**

Run `. ./bin/activate-hermit && cargo test -p buzz-core job::tests -- --nocapture` and `cargo test -p buzz-core kind::tests -- --nocapture`. Expected: compile/assertion failure because the kind and parser do not exist.

- [ ] **Step 3: Implement minimal public contracts**

Add documented `TaskCheckpoint`, `TaskArtifactKind`, `TaskArtifact`, and `ParsedJobCheckpoint` types. Extend `ParsedJobFiling` with `task_id: Option<String>`, `ParsedJobOutcome` with `artifacts: Vec<TaskArtifact>`, and `ParsedJobHead` with Task ID, checkpoint, checkpoint receipt, artifacts, outcome receipt, and durable run status. Use `deny_unknown_fields`, bounded values, and canonical artifact JSON. Preserve old event parsing.

- [ ] **Step 4: Run tests green and commit**

Run both commands from Step 2. Then `git add crates/buzz-core/src/kind.rs crates/buzz-core/src/job.rs && git commit -s -m "feat(tasks): define durable run checkpoints"`.

## Task 2: Persist Task links, checkpoints, and receipts

**Files:**

- Create: `migrations/0058_task_run_durability.sql`
- Modify: `crates/buzz-db/src/migration.rs`
- Modify: `crates/buzz-db/src/jobs.rs`
- Modify: `crates/buzz-db/src/lib.rs`

- [ ] **Step 1: Write failing migration/database tests**

Require migration 0058 to add `task_id`, `checkpoint_seq`, `checkpoint`, `checkpoint_event`, `checkpoint_at`, `artifacts`, and `outcome_event`; 32-byte checks for event receipts; a non-negative sequence; and a community/Task index. Add database proof that attempt 1 sequence 1 succeeds once, duplicate sequence loses, stale attempt loses, and Task delivery cannot store an empty artifact list.

- [ ] **Step 2: Run red tests**

Run `. ./bin/activate-hermit && cargo test -p buzz-db migration::tests -- --nocapture`. Expected: migration registration/shape failure.

- [ ] **Step 3: Add the migration and row fields**

Use additive SQL:

```sql
ALTER TABLE jobs ADD COLUMN task_id TEXT;
ALTER TABLE jobs ADD COLUMN checkpoint_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN checkpoint JSONB;
ALTER TABLE jobs ADD COLUMN checkpoint_event BYTEA;
ALTER TABLE jobs ADD COLUMN checkpoint_at BIGINT;
ALTER TABLE jobs ADD COLUMN artifacts JSONB;
ALTER TABLE jobs ADD COLUMN outcome_event BYTEA;
```

Add checks/indexes. Update `JobRow`, `NewJob`, every explicit `SELECT`/`RETURNING` list, and `row_to_job`.

- [ ] **Step 4: Add fenced updates**

Implement `checkpoint_job` as one conditional update checking community, job, leased status, holder, attempt, unexpired lease, and increasing sequence, while extending the lease. Extend `finish_job` so Task-linked done stores non-empty artifact JSON and exact outcome event atomically; legacy jobs may finish without artifacts.

- [ ] **Step 5: Run green and commit**

Run `cargo test -p buzz-db migration::tests -- --nocapture` and `cargo test -p buzz-db jobs -- --nocapture`. Commit the migration and DB files with `git commit -s -m "feat(tasks): persist run recovery state"`.

## Task 3: Arbitrate checkpoints and delivery in the relay

**Files:**

- Modify: `crates/buzz-relay/src/job_broker.rs`
- Modify: `crates/buzz-relay/src/handlers/ingest.rs`

- [ ] **Step 1: Add failing broker/head tests**

Require a built head to round-trip Task ID, checkpoint, receipts, artifacts, and `queued|executing|recoverable|delivered`. Require kind 43014 to route through the job broker and Task-linked done without artifacts to fail before database mutation.

- [ ] **Step 2: Run red tests**

Run `. ./bin/activate-hermit && cargo test -p buzz-relay job_broker::tests -- --nocapture` and `cargo test -p buzz-relay handlers::ingest::tests -- --nocapture`.

- [ ] **Step 3: Gate Task-linked filings**

When `task_id` is present, query the current relay-authored `KIND_TASK` head by exact `d` tag and refuse a missing or unreadable Task. Store the ID only after that check. Do not require Task linkage for legacy filings.

- [ ] **Step 4: Handle checkpoint and delivery events**

Parse kind 43014, call the fenced DB method with event author and event ID, and publish the head on success. Treat a stale checkpoint as an ignored no-op. For Task-linked jobs, reject done with no artifact; pass canonical artifacts and `event.id` to the fenced finish call. Failed outcomes need no artifact but still retain the outcome receipt.

- [ ] **Step 5: Extend and test canonical heads**

Project the new tags/content and derive run status only from durable row state. Run the Step 2 commands green. Commit with `git commit -s -m "feat(tasks): broker checkpointed task runs"`.

## Task 4: Expose a coherent CLI worker flow

**Files:**

- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/commands/jobs.rs`

- [ ] **Step 1: Add failing CLI tests**

Test that `jobs file --task` emits one Task tag, `jobs checkpoint` emits a parser-valid checkpoint, repeatable `--artifact` emits canonical artifact tags, malformed artifact syntax fails locally, and `jobs show` includes run/checkpoint/delivery fields.

- [ ] **Step 2: Run red tests**

Run `. ./bin/activate-hermit && cargo test -p buzz-cli commands::jobs::tests -- --nocapture`. Expected: clap variants and builders are absent.

- [ ] **Step 3: Implement syntax and builders**

Add optional `--task` to `File`, a `Checkpoint` subcommand with required attempt/sequence/summary, and repeatable `--artifact <kind>:<ref>` on `Done`. Reuse the core parser immediately after signing every event.

- [ ] **Step 4: Run green and commit**

Run the Step 2 command. Commit with `git commit -s -m "feat(cli): operate durable task runs"`.

## Task 5: Prove interruption and recovery against a real relay

**Files:**

- Modify: `crates/buzz-test-client/tests/e2e_jobs.rs`
- Modify: `crates/buzz-test-client/src/bin/test_server.rs` only if the existing test-only lease expiry hook requires it

- [ ] **Step 1: Write the acceptance test and prove it fails**

File one Task-linked run, claim attempt 1, checkpoint sequence 1, expire the lease through the existing test-only database hook, and claim attempt 2. Assert the Task and checkpoint survived; attempt 1 cannot checkpoint or deliver; attempt 2 cannot deliver without an artifact; attempt 2 can deliver with one artifact; and the final head contains `delivered`, checkpoint receipt, artifact, and outcome receipt. First observe failure while one new broker branch is absent so the fixture is proven to exercise it.

- [ ] **Step 2: Run the focused real-relay proof**

Run `. ./bin/activate-hermit && cargo test -p buzz-test-client --test e2e_jobs task_run_survives_lease_loss_from_checkpoint_and_requires_delivery_artifact -- --ignored --nocapture`. Expected: pass with Postgres, Redis, and the test relay. If infrastructure is unavailable, preserve the exact failure and do not claim relay proof.

- [ ] **Step 3: Run legacy and new job regressions**

Run `cargo test -p buzz-test-client --test e2e_jobs -- --ignored --nocapture`. Expected: legacy jobs and Task-linked runs both pass. Commit with `git commit -s -m "test(tasks): prove checkpoint recovery and delivery"`.

## Task 6: Quality and delivery gates

**Files:**

- Modify only files required to correct failures caused by this phase.

- [ ] **Step 1: Run targeted quality**

Run `. ./bin/activate-hermit`, `cargo fmt --all -- --check`, `cargo clippy -p buzz-core -p buzz-db -p buzz-relay -p buzz-cli -p buzz-test-client --all-targets -- -D warnings`, and `cargo test -p buzz-core -p buzz-db -p buzz-relay -p buzz-cli`.

- [ ] **Step 2: Run the repository PR gate**

Run `just ci`. Do not suppress failures. Reproduce an apparently unrelated failure on a clean integration checkout before classifying it as baseline.

- [ ] **Step 3: Audit scope and history**

Run `git diff --check origin/develop...HEAD`, `git diff --stat origin/develop...HEAD`, `git log --format='%h %s%n%b' origin/develop..HEAD`, and `git status --short`. Require scoped files only and a `Signed-off-by` trailer on every commit.

- [ ] **Step 4: Push, open PR, and arm auto-merge**

Push `codex/durable-task-phase1`, create a PR targeting `develop`, and run `gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto`.

- [ ] **Step 5: Monitor both CI gates**

Require the PR matrix and merge-group matrix to pass. A pending or failed check is a stop. If merged to `develop`, report that separately from promotion, artifact, deployment, or live-runtime proof. Phase 1 does not imply production promotion.
