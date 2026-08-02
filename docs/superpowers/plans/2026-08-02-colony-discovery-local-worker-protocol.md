# Colony Discovery Local Worker Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the proven Discovery foundation with a signed, private,
restart-safe protocol through which a trusted local worker can claim, heartbeat,
checkpoint, and complete a run without sending provider or LLM secrets to the
relay.

**Architecture:** Keep human and agent run control on Discovery action/receipt
kinds `40017/40018`, and add a separate strict local-worker action/receipt plane
on kinds `40019/40020`. The relay remains authoritative for entitlement,
leases, fencing, checkpoints, cancellation, and completion; this plan uses a
simulated worker and makes no Outscraper or LLM calls.

**Tech Stack:** Rust, Nostr signed events, Colony relay ingest, PostgreSQL/sqlx,
Tokio, `buzz-core`, `buzz-sdk`, `buzz-db`, `buzz-relay`, and
`buzz-test-client`.

---

## Scope and acceptance gate

This is Plan 1 of the approved Outscraper Businesses slice. It deliberately
excludes Campaign projections, canonical Businesses, deduplication, local
keychain commands, Outscraper, LLM qualification, Leads, and frontend adapter
work. Those depend on this protocol and receive separate plans after this gate.

This phase passes only when a simulated local worker can:

1. claim an entitled queued run through a private signed exchange;
2. checkpoint a strictly shaped non-secret provider request reference;
3. lose its lease, reconnect under a new fenced lease, and receive the last
   checkpoint without submitting a second provider job;
4. heartbeat and complete a current lease;
5. have actor cancellation or entitlement revocation invalidate its lease
   immediately;
6. have every stale result rejected;
7. prove a fixture secret never enters an event or Discovery database column;
8. keep worker receipts unreadable by another authenticated workspace member.

## File map

### Create

- `crates/buzz-core/src/discovery_worker.rs` — provider-neutral worker request,
  checkpoint, lease, and receipt types with no arbitrary secret-bearing fields.
- `crates/buzz-sdk/src/discovery_worker.rs` — exact event envelopes, builders,
  strict parsers, canonical JSON, and validation for kinds `40019/40020`.
- `migrations/0032_discovery_local_worker_protocol.sql` — lease ownership,
  durable monotonic checkpoints, worker-command idempotency, and FTS exclusion.
- `crates/buzz-relay/src/discovery_worker_broker.rs` — authenticated worker
  command broker and relay-signed private receipt dispatch.

### Modify

- `crates/buzz-core/src/lib.rs` — export the worker contract module.
- `crates/buzz-core/src/kind.rs` — register and gate kinds `40019/40020`.
- `crates/buzz-sdk/src/lib.rs` — export strict worker envelope helpers.
- `schema/schema.sql` — keep the reference schema's FTS privacy skip-set aligned
  with the migration-installed expression.
- `crates/buzz-db/src/discovery.rs` — community-scoped worker claims,
  heartbeats, checkpoints, completion, immediate cancellation/revocation, and
  idempotent command persistence.
- `crates/buzz-relay/src/lib.rs` — register the worker broker module.
- `crates/buzz-relay/src/config.rs` — add the external-worker feature gate and
  prohibit fake and external executors from running together.
- `crates/buzz-relay/src/discovery_broker.rs` — permit starts when the external
  worker plane is enabled and preserve the fake-only path.
- `crates/buzz-relay/src/handlers/ingest.rs` — route worker kinds before generic
  command persistence.
- `crates/buzz-relay/src/discovery_runtime.rs` — adapt fake-worker expectations
  to immediate lease invalidation without changing fake execution behavior.
- `crates/buzz-search/tests/fts_integration.rs` — explicit and generic FTS
  privacy tripwires for worker action and receipt kinds.
- `crates/buzz-test-client/tests/e2e_discovery.rs` — real-relay simulated worker,
  privacy, restart, fencing, cancel, revoke, and completion proof.
- `docs/superpowers/specs/2026-08-02-colony-discovery-outscraper-businesses-design.md`
  — record the passed worker-protocol gate and evidence after it passes.

## Protocol invariants

- Worker actions are author-only and worker receipts are relay-authored,
  `p`-gated, result-gated, and unsearchable.
- A worker action contains only UUIDs, bounded enums, bounded counts, and a
  strictly validated provider request reference. It has no free-form error,
  prompt, metadata, header, key, or payload field.
- `worker_id` identifies one local installation but grants no authority by
  itself. The authenticated signing pubkey, workspace membership, entitlement,
  and current lease jointly authorize every mutation.
- `lease_id` is the existing random `claim_id`; `attempt` is the monotonically
  increasing fencing epoch shown to clients.
- A checkpoint sequence must be exactly the current durable sequence plus one.
  Repeating byte-identical sequence data is idempotent; changing data at an
  existing sequence is a conflict.
- An expired, cancelled, revoked, completed, or differently owned lease cannot
  heartbeat, checkpoint, or complete.
- The relay sets lease duration. The worker cannot request a longer lease.
- External and deterministic fake workers cannot be enabled simultaneously,
  preventing the fake relay loop from stealing a local-worker run.

### Task 1: Define worker contracts and reserve private event kinds

**Files:**

- Create: `crates/buzz-core/src/discovery_worker.rs`
- Modify: `crates/buzz-core/src/lib.rs`
- Modify: `crates/buzz-core/src/kind.rs`

- [ ] **Step 1: Write failing kind-registry tests**

Add these assertions to the existing Discovery kind test in
`crates/buzz-core/src/kind.rs`:

```rust
assert_eq!(KIND_DISCOVERY_WORKER_ACTION, 40019);
assert_eq!(KIND_DISCOVERY_WORKER_RECEIPT, 40020);
assert!(ALL_KINDS.contains(&KIND_DISCOVERY_WORKER_ACTION));
assert!(ALL_KINDS.contains(&KIND_DISCOVERY_WORKER_RECEIPT));
assert!(AUTHOR_ONLY_KINDS.contains(&KIND_DISCOVERY_WORKER_ACTION));
assert!(P_GATED_KINDS.contains(&KIND_DISCOVERY_WORKER_RECEIPT));
assert!(RESULT_GATED_KINDS.contains(&KIND_DISCOVERY_WORKER_RECEIPT));
assert!(is_command_kind(KIND_DISCOVERY_WORKER_ACTION));
assert!(is_relay_only_kind(KIND_DISCOVERY_WORKER_RECEIPT));
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-core kind::tests::discovery_kinds_are_private_commands
```

Expected: compilation fails because `KIND_DISCOVERY_WORKER_ACTION` and
`KIND_DISCOVERY_WORKER_RECEIPT` do not exist.

- [ ] **Step 3: Add kinds and the core worker types**

Add to `crates/buzz-core/src/kind.rs`:

```rust
/// Member-signed command from a trusted local Discovery worker.
pub const KIND_DISCOVERY_WORKER_ACTION: u32 = 40019;

/// Relay-signed, worker-private result of a local-worker command.
pub const KIND_DISCOVERY_WORKER_RECEIPT: u32 = 40020;
```

Register `40019` beside `KIND_DISCOVERY_ACTION` in `AUTHOR_ONLY_KINDS`,
`is_command_kind`, and `ALL_KINDS`. Register `40020` beside
`KIND_DISCOVERY_RECEIPT` in `P_GATED_KINDS`, `RESULT_GATED_KINDS`,
`is_relay_only_kind`, and `ALL_KINDS`. Add compile-time `u16` assertions beside
the existing Discovery assertions.

Create `crates/buzz-core/src/discovery_worker.rs` with these public shapes:

```rust
//! Core contracts for trusted local Discovery workers.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::discovery::DiscoveryRunProjection;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryWorkerOperation {
    Claim,
    Heartbeat,
    Checkpoint,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryProvider {
    Outscraper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryCheckpointKind {
    ProviderSubmitted,
    ProviderResultsReady,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerClaimRequest {
    pub request_id: Uuid,
    pub idempotency_key: Uuid,
    pub worker_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerLeaseRequest {
    pub request_id: Uuid,
    pub idempotency_key: Uuid,
    pub worker_id: Uuid,
    pub run_id: Uuid,
    pub lease_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerCheckpoint {
    pub sequence: u32,
    pub kind: DiscoveryCheckpointKind,
    pub provider: DiscoveryProvider,
    pub provider_request_id: Option<String>,
    pub item_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerCheckpointRequest {
    #[serde(flatten)]
    pub lease: DiscoveryWorkerLeaseRequest,
    pub checkpoint: DiscoveryWorkerCheckpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryWorkerAction {
    Claim(DiscoveryWorkerClaimRequest),
    Heartbeat(DiscoveryWorkerLeaseRequest),
    Checkpoint(DiscoveryWorkerCheckpointRequest),
    Complete(DiscoveryWorkerLeaseRequest),
}

impl DiscoveryWorkerAction {
    pub const fn operation(&self) -> DiscoveryWorkerOperation {
        match self {
            Self::Claim(_) => DiscoveryWorkerOperation::Claim,
            Self::Heartbeat(_) => DiscoveryWorkerOperation::Heartbeat,
            Self::Checkpoint(_) => DiscoveryWorkerOperation::Checkpoint,
            Self::Complete(_) => DiscoveryWorkerOperation::Complete,
        }
    }

    pub const fn request_id(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.request_id,
            Self::Heartbeat(value) | Self::Complete(value) => value.request_id,
            Self::Checkpoint(value) => value.lease.request_id,
        }
    }

    pub const fn idempotency_key(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.idempotency_key,
            Self::Heartbeat(value) | Self::Complete(value) => value.idempotency_key,
            Self::Checkpoint(value) => value.lease.idempotency_key,
        }
    }

    pub const fn worker_id(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.worker_id,
            Self::Heartbeat(value) | Self::Complete(value) => value.worker_id,
            Self::Checkpoint(value) => value.lease.worker_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerLeaseProjection {
    pub worker_id: Uuid,
    pub lease_id: Uuid,
    pub attempt: u32,
    pub lease_until: DateTime<Utc>,
    pub run: DiscoveryRunProjection,
    pub last_checkpoint: Option<DiscoveryWorkerCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status", content = "value")]
pub enum DiscoveryWorkerReceiptOutcome {
    Idle,
    Lease(DiscoveryWorkerLeaseProjection),
    LostLease(DiscoveryRunProjection),
    Completed(DiscoveryRunProjection),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerReceipt {
    pub operation: DiscoveryWorkerOperation,
    pub request_id: Uuid,
    pub idempotency_key: Uuid,
    pub outcome: DiscoveryWorkerReceiptOutcome,
}
```

Export it from `crates/buzz-core/src/lib.rs`:

```rust
pub mod discovery_worker;
```

- [ ] **Step 4: Add shape tests and run green**

In `crates/buzz-core/src/discovery_worker.rs`, add tests proving unknown fields
are rejected and enum JSON is stable:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_operation_json_is_stable() {
        assert_eq!(
            serde_json::to_string(&DiscoveryWorkerOperation::Checkpoint).unwrap(),
            "\"checkpoint\""
        );
    }

    #[test]
    fn claim_rejects_unknown_fields() {
        let value = serde_json::json!({
            "request_id": Uuid::new_v4(),
            "idempotency_key": Uuid::new_v4(),
            "worker_id": Uuid::new_v4(),
            "api_key": "must-not-fit-the-schema"
        });
        assert!(serde_json::from_value::<DiscoveryWorkerClaimRequest>(value).is_err());
    }
}
```

Run:

```bash
cargo test -p buzz-core discovery_worker kind::tests::discovery_kinds_are_private_commands
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the core contract**

```bash
git add crates/buzz-core/src/discovery_worker.rs crates/buzz-core/src/lib.rs crates/buzz-core/src/kind.rs
git commit -s -m "feat(discovery): define local worker protocol"
```

### Task 2: Build strict worker action and receipt envelopes

**Files:**

- Create: `crates/buzz-sdk/src/discovery_worker.rs`
- Modify: `crates/buzz-sdk/src/lib.rs`

- [ ] **Step 1: Write failing SDK tests for secret-shaped input and tag drift**

Start `crates/buzz-sdk/src/discovery_worker.rs` with tests that call the public
builders before they exist:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::discovery_worker::{
        DiscoveryCheckpointKind, DiscoveryProvider, DiscoveryWorkerCheckpoint,
        DiscoveryWorkerCheckpointRequest, DiscoveryWorkerLeaseRequest,
    };
    use nostr::Keys;

    fn lease() -> DiscoveryWorkerLeaseRequest {
        DiscoveryWorkerLeaseRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            lease_id: Uuid::new_v4(),
        }
    }

    #[test]
    fn provider_request_id_rejects_secret_punctuation() {
        let request = DiscoveryWorkerCheckpointRequest {
            lease: lease(),
            checkpoint: DiscoveryWorkerCheckpoint {
                sequence: 1,
                kind: DiscoveryCheckpointKind::ProviderSubmitted,
                provider: DiscoveryProvider::Outscraper,
                provider_request_id: Some("sk-live secret/value".into()),
                item_count: None,
            },
        };
        let relay = Keys::generate();
        assert!(build_discovery_worker_checkpoint_action(relay.public_key(), &request).is_err());
    }
}
```

- [ ] **Step 2: Run the SDK test and verify red**

```bash
cargo test -p buzz-sdk discovery_worker
```

Expected: compilation fails because the worker builder is undefined.

- [ ] **Step 3: Implement canonical schemas, builders, and parsers**

Implement these constants and public functions in
`crates/buzz-sdk/src/discovery_worker.rs`:

```rust
const ACTION_SCHEMA: &str = "colony.discovery-worker-action/v1";
const RECEIPT_SCHEMA: &str = "colony.discovery-worker-receipt/v1";
const MAX_PROVIDER_REQUEST_ID_LEN: usize = 128;

pub fn build_discovery_worker_claim_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkerClaimRequest,
) -> Result<EventBuilder, DiscoverySdkError>;

pub fn build_discovery_worker_heartbeat_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkerLeaseRequest,
) -> Result<EventBuilder, DiscoverySdkError>;

pub fn build_discovery_worker_checkpoint_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkerCheckpointRequest,
) -> Result<EventBuilder, DiscoverySdkError>;

pub fn build_discovery_worker_complete_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkerLeaseRequest,
) -> Result<EventBuilder, DiscoverySdkError>;

pub fn parse_discovery_worker_action(
    event: &Event,
) -> Result<ParsedDiscoveryWorkerAction, DiscoverySdkError>;

pub fn build_discovery_worker_receipt(
    actor_pubkey: PublicKey,
    action_event_id: EventId,
    receipt: &DiscoveryWorkerReceipt,
) -> Result<EventBuilder, DiscoverySdkError>;

pub fn parse_discovery_worker_receipt(
    event: &Event,
) -> Result<ParsedDiscoveryWorkerReceipt, DiscoverySdkError>;

pub struct ParsedDiscoveryWorkerAction {
    pub relay_pubkey: PublicKey,
    pub action: DiscoveryWorkerAction,
}

pub struct ParsedDiscoveryWorkerReceipt {
    pub event_id: EventId,
    pub actor_pubkey: PublicKey,
    pub action_event_id: EventId,
    pub receipt: DiscoveryWorkerReceipt,
}
```

Use exact tags:

```text
claim action:      p, worker, discovery-worker-action
other actions:    p, worker, run, lease, discovery-worker-action
worker receipt:   p, e, worker, discovery-worker-receipt
```

The tuple is always:

```text
["discovery-worker-action", "1", operation, request_id, idempotency_key]
```

Validate provider request IDs with this exact rule before canonicalizing:

```rust
fn validate_provider_request_id(value: &str) -> Result<(), DiscoverySdkError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_PROVIDER_REQUEST_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(DiscoverySdkError::InvalidEnvelope(
            "discovery provider request id",
        ))
    }
}
```

Enforce checkpoint field combinations:

```rust
match checkpoint.kind {
    DiscoveryCheckpointKind::ProviderSubmitted => {
        if checkpoint.provider_request_id.is_none() || checkpoint.item_count.is_some() {
            return Err(DiscoverySdkError::InvalidEnvelope(
                "provider submitted checkpoint",
            ));
        }
    }
    DiscoveryCheckpointKind::ProviderResultsReady => {
        if checkpoint.provider_request_id.is_some() || checkpoint.item_count.is_none() {
            return Err(DiscoverySdkError::InvalidEnvelope(
                "provider results checkpoint",
            ));
        }
    }
}
```

Reuse canonical JSON, exact-tag, UUID, relay-recipient, and tag/content parity
helpers from `crates/buzz-sdk/src/discovery.rs`; move helpers to a private
shared module only if Rust visibility prevents reuse. Do not loosen the existing
Discovery envelope.

Export from `crates/buzz-sdk/src/lib.rs`:

```rust
pub mod discovery_worker;
```

- [ ] **Step 4: Complete positive and mutation tests**

Add round-trip tests for all four actions and receipts. For every signed valid
event, mutate one of `worker`, `run`, `lease`, operation, request ID, or content
and assert parsing fails. Assert serialized action and receipt JSON never
contains a local fixture value:

```rust
let local_secret = "outscraper-secret-never-serialized";
let event = build_discovery_worker_claim_action(relay.public_key(), &request)
    .unwrap()
    .sign_with_keys(&actor)
    .unwrap();
assert!(!event.as_json().contains(local_secret));
```

Run:

```bash
cargo test -p buzz-sdk discovery_worker
```

Expected: every worker envelope test passes.

- [ ] **Step 5: Commit strict envelopes**

```bash
git add crates/buzz-sdk/src/discovery_worker.rs crates/buzz-sdk/src/lib.rs
git commit -s -m "feat(discovery): sign local worker exchanges"
```

### Task 3: Add durable worker ownership and checkpoints

**Files:**

- Create: `migrations/0032_discovery_local_worker_protocol.sql`
- Modify: `crates/buzz-db/src/migration.rs`
- Modify: `schema/schema.sql`
- Modify: `crates/buzz-search/tests/fts_integration.rs`

- [ ] **Step 1: Write the migration with strict shapes**

Create `migrations/0032_discovery_local_worker_protocol.sql`:

```sql
ALTER TABLE discovery_runs
    ADD COLUMN worker_id UUID,
    ADD COLUMN lease_owner_pubkey BYTEA
        CHECK (lease_owner_pubkey IS NULL OR octet_length(lease_owner_pubkey) = 32),
    ADD COLUMN last_checkpoint_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (last_checkpoint_sequence >= 0),
    ADD CONSTRAINT discovery_runs_external_worker_pair
        CHECK ((worker_id IS NULL) = (lease_owner_pubkey IS NULL));

CREATE TABLE discovery_run_checkpoints (
    community_id UUID NOT NULL,
    run_id UUID NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    checkpoint_kind TEXT NOT NULL
        CHECK (checkpoint_kind IN ('provider_submitted', 'provider_results_ready')),
    provider TEXT NOT NULL CHECK (provider = 'outscraper'),
    provider_request_id TEXT,
    item_count INTEGER CHECK (item_count IS NULL OR item_count >= 0),
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, run_id, sequence),
    FOREIGN KEY (community_id, run_id)
        REFERENCES discovery_runs(community_id, id) ON DELETE CASCADE,
    CHECK (
        (checkpoint_kind = 'provider_submitted'
            AND provider_request_id IS NOT NULL
            AND provider_request_id ~ '^[A-Za-z0-9_-]{1,128}$'
            AND item_count IS NULL)
        OR
        (checkpoint_kind = 'provider_results_ready'
            AND provider_request_id IS NULL
            AND item_count IS NOT NULL)
    )
);

CREATE UNIQUE INDEX discovery_outscraper_request_once_idx
    ON discovery_run_checkpoints (community_id, run_id, provider, provider_request_id)
    WHERE provider_request_id IS NOT NULL;

CREATE TABLE discovery_worker_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    operation TEXT NOT NULL
        CHECK (operation IN ('claim', 'heartbeat', 'checkpoint', 'complete')),
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

DO $$
DECLARE
    existing_expression TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO existing_expression
      FROM pg_attrdef d
      JOIN pg_attribute a
        ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = 'events'::regclass AND a.attname = 'search_tsv';

    IF existing_expression IS NULL THEN
        RAISE EXCEPTION 'events.search_tsv generated expression not found';
    END IF;

    ALTER TABLE events DROP COLUMN search_tsv;
    EXECUTE format(
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (CASE WHEN kind IN (40019, 40020) THEN NULL::tsvector ELSE (%s) END) STORED',
        existing_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;
```

- [ ] **Step 2: Add migration drift assertions**

In `crates/buzz-db/src/migration.rs`, extend the existing migration-count and
ordered-name assertions to include `0032_discovery_local_worker_protocol.sql`.
Add an assertion that its SQL contains both `discovery_run_checkpoints` and
`40019, 40020`.

Extend the `schema/schema.sql` `search_tsv` skip-set from:

```sql
40013, 40014, 40015, 40016, 40017, 40018, 44100
```

to:

```sql
40013, 40014, 40015, 40016, 40017, 40018, 40019, 40020, 44100
```

In `crates/buzz-search/tests/fts_integration.rs`, import both worker kind
constants, insert one row for each beside the existing Discovery action and
receipt rows, and include both in the explicit forbidden-kind array. The
generic `AUTHOR_ONLY_KINDS` and `P_GATED_KINDS` tests then provide a second drift
tripwire.

- [ ] **Step 3: Run migration tests**

```bash
cargo test -p buzz-db migration
BUZZ_TEST_DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz \
cargo test -p buzz-search --test fts_integration \
  excluded_kinds_are_storage_level_unsearchable \
  -- --ignored --nocapture
```

Expected: migration ordering, checksum, and structural assertions pass.

- [ ] **Step 4: Commit persistence schema**

```bash
git add migrations/0032_discovery_local_worker_protocol.sql crates/buzz-db/src/migration.rs schema/schema.sql crates/buzz-search/tests/fts_integration.rs
git commit -s -m "feat(discovery): persist local worker checkpoints"
```

### Task 4: Implement atomic external-worker lease operations

**Files:**

- Modify: `crates/buzz-db/src/discovery.rs`

- [ ] **Step 1: Add failing integration coverage for community-scoped claims**

Extend `database_enforces_entitlement_grants_idempotency_and_fenced_stops` in
`crates/buzz-db/src/discovery.rs`. Create a second community using the same
in-test SQL fixture pattern, queue one run in each community, call the new
method for community A, and assert it never returns community B:

```rust
let claimed = db
    .claim_discovery_run_for_worker(
        community_a,
        &actor_a,
        worker_id,
        chrono::Duration::seconds(30),
    )
    .await
    .unwrap()
    .unwrap();
assert_eq!(claimed.run.community_id, community_a);
assert_eq!(claimed.worker_id, worker_id);
assert_eq!(claimed.lease_owner_pubkey, actor_a);
```

Run:

```bash
BUZZ_TEST_DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz \
cargo test -p buzz-db \
  discovery::tests::database_enforces_entitlement_grants_idempotency_and_fenced_stops \
  -- --ignored --nocapture
```

Expected: compilation fails because the method and fields are absent.

- [ ] **Step 2: Extend records and define outcomes**

Add these shapes beside `ClaimedDiscoveryRun`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryCheckpointRecord {
    pub sequence: u32,
    pub checkpoint: DiscoveryWorkerCheckpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedExternalDiscoveryRun {
    pub run: DiscoveryRunRecord,
    pub worker_id: Uuid,
    pub lease_owner_pubkey: [u8; 32],
    pub lease_id: Uuid,
    pub lease_until: DateTime<Utc>,
    pub last_checkpoint: Option<DiscoveryCheckpointRecord>,
}

impl ClaimedExternalDiscoveryRun {
    pub fn projection(&self) -> DiscoveryWorkerLeaseProjection {
        DiscoveryWorkerLeaseProjection {
            worker_id: self.worker_id,
            lease_id: self.lease_id,
            attempt: self.run.attempt,
            lease_until: self.lease_until,
            run: self.run.projection(),
            last_checkpoint: self
                .last_checkpoint
                .as_ref()
                .map(|record| record.checkpoint.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryWorkerLeaseMutation {
    Lease(ClaimedExternalDiscoveryRun),
    Idle,
    LostLease(DiscoveryRunRecord),
    Completed(DiscoveryRunRecord),
}
```

Extend `DiscoveryRunRecord` with `worker_id`, `lease_owner_pubkey`, and
`last_checkpoint_sequence`, update every `SELECT ... RETURNING` list and
`run_from_row`, and update the fake runtime's test constructor with `None`,
`None`, and `0`.

- [ ] **Step 3: Add community-scoped claim and heartbeat methods**

Implement:

```rust
pub async fn claim_discovery_run_for_worker(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    worker_id: Uuid,
    lease_duration: Duration,
) -> Result<Option<ClaimedExternalDiscoveryRun>>;

pub async fn heartbeat_discovery_worker_lease(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    worker_id: Uuid,
    run_id: Uuid,
    lease_id: Uuid,
    lease_duration: Duration,
) -> Result<DiscoveryWorkerLeaseMutation>;
```

The claim query must include:

```sql
WHERE community_id = $1
  AND state IN ('queued', 'running')
  AND cancel_requested = FALSE
  AND (claim_id IS NULL OR lease_until < now())
```

The update must set `state='running'`, a new `claim_id`, relay-calculated
`lease_until`, `worker_id`, `lease_owner_pubkey`, and `attempt=attempt+1` in one
transaction after `require_discovery_authorized_tx` succeeds. Load the latest
checkpoint in the same transaction.

Heartbeat must lock the run, recheck active entitlement, exact actor pubkey,
worker ID, lease ID, state, and unexpired lease, then extend with the server
duration. On any ownership mismatch return `LostLease` without mutation.

- [ ] **Step 4: Make cancellation and revocation invalidate leases atomically**

Change both cancel paths to transition active runs immediately:

```sql
SET state = 'cancelled',
    cancel_requested = TRUE,
    terminal_reason = 'cancelled_by_actor',
    claim_id = NULL,
    lease_until = NULL,
    worker_id = NULL,
    lease_owner_pubkey = NULL,
    updated_at = now()
WHERE community_id = $1 AND id = $2
  AND state IN ('queued', 'running')
```

When `set_discovery_entitlement(..., false)` holds the authority lock, also
cancel every queued/running community run with
`terminal_reason='entitlement_revoked'` and clear the same lease columns before
committing.

Update fake runtime tests: an immediately cancelled run may now surface as
`LostLease` rather than committing another fake step. It must never advance.

- [ ] **Step 5: Run focused DB and runtime tests**

```bash
cargo test -p buzz-db discovery
cargo test -p buzz-relay discovery_runtime
```

Expected: community scoping, ownership checks, immediate cancel/revoke, and fake
runtime regression tests pass.

- [ ] **Step 6: Commit lease operations**

```bash
git add crates/buzz-db/src/discovery.rs crates/buzz-relay/src/discovery_runtime.rs
git commit -s -m "feat(discovery): fence external worker leases"
```

### Task 5: Implement monotonic checkpoints and completion

**Files:**

- Modify: `crates/buzz-db/src/discovery.rs`

- [ ] **Step 1: Write failing checkpoint tests**

Add database-backed cases proving:

```rust
let first = db
    .checkpoint_discovery_worker_lease(
        community,
        &actor,
        worker_id,
        run_id,
        lease_id,
        checkpoint.clone(),
    )
    .await
    .unwrap();
assert!(matches!(first, DiscoveryWorkerLeaseMutation::Lease(_)));

let duplicate = db
    .checkpoint_discovery_worker_lease(
        community,
        &actor,
        worker_id,
        run_id,
        lease_id,
        checkpoint.clone(),
    )
    .await
    .unwrap();
assert_eq!(first, duplicate);

let changed_same_sequence = DiscoveryWorkerCheckpoint {
    provider_request_id: Some("different_request".into()),
    ..checkpoint
};
assert!(db
    .checkpoint_discovery_worker_lease(
        community,
        &actor,
        worker_id,
        run_id,
        lease_id,
        changed_same_sequence,
    )
    .await
    .is_err());
```

Also prove sequence `2` before `1`, an expired lease, and an old lease after
reclaim cannot write.

- [ ] **Step 2: Run red**

```bash
cargo test -p buzz-db discovery_worker_checkpoint
```

Expected: compilation fails because checkpoint methods are undefined.

- [ ] **Step 3: Implement checkpoint fingerprinting and mutation**

Add:

```rust
pub async fn checkpoint_discovery_worker_lease(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    worker_id: Uuid,
    run_id: Uuid,
    lease_id: Uuid,
    checkpoint: DiscoveryWorkerCheckpoint,
) -> Result<DiscoveryWorkerLeaseMutation>;

pub async fn complete_discovery_worker_lease(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    worker_id: Uuid,
    run_id: Uuid,
    lease_id: Uuid,
) -> Result<DiscoveryWorkerLeaseMutation>;
```

Compute fingerprints from canonical primitives, never `Debug` output:

```rust
fn checkpoint_fingerprint(checkpoint: &DiscoveryWorkerCheckpoint) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"colony.discovery-checkpoint/v1\0");
    hasher.update(checkpoint.sequence.to_be_bytes());
    hasher.update([checkpoint_kind_code(checkpoint.kind)]);
    hasher.update([provider_code(checkpoint.provider)]);
    if let Some(value) = &checkpoint.provider_request_id {
        hasher.update(value.as_bytes());
    }
    hasher.update([0]);
    if let Some(value) = checkpoint.item_count {
        hasher.update(value.to_be_bytes());
    }
    hasher.finalize().into()
}
```

Within one transaction: lock and authorize the lease, compare `sequence` with
`last_checkpoint_sequence`, accept an exact existing fingerprint, reject a
changed existing sequence, insert the next checkpoint, and update
`last_checkpoint_sequence`. Completion sets `completed_steps=total_steps`,
`state='succeeded'`, clears every lease-owner column, and returns `Completed`.

- [ ] **Step 4: Run green and commit**

```bash
cargo test -p buzz-db discovery_worker_checkpoint
git add crates/buzz-db/src/discovery.rs
git commit -s -m "feat(discovery): checkpoint local worker progress"
```

Expected: exact replay is idempotent, sequence drift conflicts, and stale leases
cannot checkpoint or complete.

### Task 6: Persist worker commands and private receipts atomically

**Files:**

- Modify: `crates/buzz-db/src/discovery.rs`

- [ ] **Step 1: Define worker command mutations and apply outcomes**

Add:

```rust
pub enum DiscoveryWorkerCommandMutation {
    Claim { worker_id: Uuid, lease_duration: Duration },
    Heartbeat {
        worker_id: Uuid,
        run_id: Uuid,
        lease_id: Uuid,
        lease_duration: Duration,
    },
    Checkpoint {
        worker_id: Uuid,
        run_id: Uuid,
        lease_id: Uuid,
        checkpoint: DiscoveryWorkerCheckpoint,
    },
    Complete { worker_id: Uuid, run_id: Uuid, lease_id: Uuid },
}

pub enum DiscoveryWorkerCommandApply {
    Applied {
        action: Box<StoredEvent>,
        receipt: Box<StoredEvent>,
        outcome: DiscoveryWorkerLeaseMutation,
    },
    Duplicate {
        original_action_event_id: Vec<u8>,
        receipt_event_id: Vec<u8>,
    },
}
```

- [ ] **Step 2: Implement one atomic apply method**

Implement:

```rust
pub async fn apply_discovery_worker_command_once<F>(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    idempotency_key: Uuid,
    mutation: DiscoveryWorkerCommandMutation,
    action_event: &Event,
    build_receipt: F,
) -> Result<DiscoveryWorkerCommandApply>
where
    F: FnOnce(&DiscoveryWorkerLeaseMutation) -> Result<Event>;
```

Follow `apply_discovery_command_once`: acquire one transaction and authority
lock, validate signer equality, detect the idempotency claim before mutation,
execute the worker mutation using transaction-local helpers, build the receipt
from the exact committed outcome, store action and receipt, insert mentions,
insert `discovery_worker_action_claims`, and commit.

For an idle claim, persist `run_id=NULL`. The duplicate path returns the
original event IDs and never executes a second claim. Fingerprint operation,
worker ID, run ID, lease ID, and checkpoint fingerprint so reusing an
idempotency key for a different command returns `AccessDenied`.

- [ ] **Step 3: Add atomicity and retry tests**

Use a receipt closure that deliberately returns `DbError::InvalidData` and
assert the worker mutation, action event, receipt event, and action claim all
roll back. Retry a successful claim with the same idempotency key and assert
the run attempt remains `1` and the original receipt ID is returned.

Run:

```bash
cargo test -p buzz-db discovery_worker_command
```

Expected: rollback and exact retry behavior pass.

- [ ] **Step 4: Commit atomic command persistence**

```bash
git add crates/buzz-db/src/discovery.rs
git commit -s -m "feat(discovery): apply worker commands atomically"
```

### Task 7: Add the relay worker broker and feature gate

**Files:**

- Create: `crates/buzz-relay/src/discovery_worker_broker.rs`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-relay/src/config.rs`
- Modify: `crates/buzz-relay/src/discovery_broker.rs`
- Modify: `crates/buzz-relay/src/handlers/ingest.rs`

- [ ] **Step 1: Add failing configuration tests**

Add tests beside `DiscoveryConfig` parsing:

```rust
#[test]
fn fake_and_external_discovery_executors_are_mutually_exclusive() {
    let result = validate_discovery_execution_modes(&DiscoveryConfig {
        fake_executor_enabled: true,
        external_worker_enabled: true,
        ..DiscoveryConfig::default()
    });
    assert!(result.is_err());
}
```

Run the focused config test and verify red because the field and validation do
not exist.

- [ ] **Step 2: Add the external-worker configuration**

Extend `DiscoveryConfig`:

```rust
pub external_worker_enabled: bool,
```

Default it to `false`, load it from
`BUZZ_DISCOVERY_EXTERNAL_WORKER_ENABLED`, and return a configuration error when
it and `fake_executor_enabled` are both true. Keep `lease_seconds` server-owned.

In `discovery_broker.rs`, accept `Start` when exactly one execution mode is
enabled. Use `fake_total_steps` for fake runs and `1` as the temporary
compatibility step count for external runs; the Campaign projection plan will
replace step counting with domain phases.

- [ ] **Step 3: Implement the worker broker**

Create `discovery_worker_broker.rs` following `discovery_broker.rs`, with:

```rust
pub(crate) fn is_discovery_worker_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_DISCOVERY_WORKER_ACTION
}

pub(crate) async fn handle_discovery_worker_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<DiscoveryWorkerBrokerOutcome, DiscoveryBrokerError>;
```

Reject when the relay has no durable signing key or external workers are
disabled. Parse the strict SDK envelope, require its `p` tag to equal the relay
pubkey, translate it to `DiscoveryWorkerCommandMutation`, and call
`apply_discovery_worker_command_once` with `Duration::seconds` derived from
server config.

Map DB outcomes into core receipt outcomes exactly:

```rust
fn receipt_outcome(
    mutation: &DiscoveryWorkerLeaseMutation,
) -> DiscoveryWorkerReceiptOutcome {
    match mutation {
        DiscoveryWorkerLeaseMutation::Idle => DiscoveryWorkerReceiptOutcome::Idle,
        DiscoveryWorkerLeaseMutation::Lease(claimed) => {
            DiscoveryWorkerReceiptOutcome::Lease(claimed.projection())
        }
        DiscoveryWorkerLeaseMutation::LostLease(run) => {
            DiscoveryWorkerReceiptOutcome::LostLease(run.projection())
        }
        DiscoveryWorkerLeaseMutation::Completed(run) => {
            DiscoveryWorkerReceiptOutcome::Completed(run.projection())
        }
    }
}
```

Sign with the relay key and dispatch the stored action and receipt using
`KIND_DISCOVERY_WORKER_ACTION` and `KIND_DISCOVERY_WORKER_RECEIPT`.

Export the module from `crates/buzz-relay/src/lib.rs` as `pub(crate)`.

- [ ] **Step 4: Route worker commands before generic ingest**

In `crates/buzz-relay/src/handlers/ingest.rs`, add a branch immediately after
the human/agent Discovery broker branch. Reject channel-scoped auth, classify
worker broker errors with the same `invalid`, `restricted`, `conflict`, and
redacted internal messages, and return structured JSON containing only receipt
IDs and duplicate metadata.

Never include the parsed worker action or database error detail in the client
response or tracing fields.

- [ ] **Step 5: Run relay tests and commit**

```bash
cargo test -p buzz-relay discovery_worker_broker
cargo test -p buzz-relay discovery_broker
cargo test -p buzz-relay config
```

Expected: feature gating, strict routing, receipt signing, and existing run
control tests pass.

```bash
git add crates/buzz-relay/src/discovery_worker_broker.rs crates/buzz-relay/src/lib.rs crates/buzz-relay/src/config.rs crates/buzz-relay/src/discovery_broker.rs crates/buzz-relay/src/handlers/ingest.rs
git commit -s -m "feat(discovery): broker local worker leases"
```

### Task 8: Prove the protocol against a real relay

**Files:**

- Modify: `crates/buzz-test-client/tests/e2e_discovery.rs`

- [ ] **Step 1: Add exact worker submission helpers**

Add these imports and helpers to `e2e_discovery.rs`:

```rust
use buzz_core::{
    discovery::{DiscoveryRunRequest, DiscoveryStartRequest},
    discovery_worker::{
        DiscoveryCheckpointKind, DiscoveryProvider, DiscoveryWorkerCheckpoint,
        DiscoveryWorkerCheckpointRequest, DiscoveryWorkerClaimRequest,
        DiscoveryWorkerLeaseRequest, DiscoveryWorkerReceiptOutcome,
    },
    kind::{KIND_DISCOVERY_RECEIPT, KIND_DISCOVERY_WORKER_RECEIPT},
};
use buzz_sdk::{
    discovery::{
        build_discovery_cancel_action, build_discovery_start_action,
        parse_discovery_receipt,
    },
    discovery_worker::{
        build_discovery_worker_checkpoint_action,
        build_discovery_worker_claim_action,
        build_discovery_worker_complete_action,
        build_discovery_worker_heartbeat_action,
        parse_discovery_worker_receipt, ParsedDiscoveryWorkerReceipt,
    },
};

async fn relay_pubkey() -> nostr::PublicKey {
    let info: Value = reqwest::Client::new()
        .get(relay_http_url())
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("fetch NIP-11")
        .json()
        .await
        .expect("parse NIP-11");
    nostr::PublicKey::parse(
        info.get("self")
            .and_then(Value::as_str)
            .expect("NIP-11 self key"),
    )
    .expect("valid relay pubkey")
}

async fn submit_worker_action(
    client: &mut BuzzTestClient,
    actor: &Keys,
    relay: nostr::PublicKey,
    builder: nostr::EventBuilder,
) -> ParsedDiscoveryWorkerReceipt {
    let event = builder
        .sign_with_keys(actor)
        .expect("sign worker action");
    let action_id = event.id;
    let ok = client
        .send_event(event)
        .await
        .expect("publish worker action");
    let answer: Value = serde_json::from_str(&ok.message).expect("structured worker response");
    let receipt_id = EventId::from_hex(
        answer
            .get("receipt_event_id")
            .and_then(Value::as_str)
            .expect("worker receipt event id"),
    )
    .expect("valid worker receipt id");
    let p_tag = SingleLetterTag::lowercase(Alphabet::P);
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_WORKER_RECEIPT as u16))
        .id(receipt_id)
        .event(action_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    let subscription_id = format!("worker-receipt-{receipt_id}");
    client
        .subscribe(&subscription_id, vec![filter])
        .await
        .expect("subscribe to worker receipt");
    let receipts = client
        .collect_until_eose(&subscription_id, Duration::from_secs(5))
        .await
        .expect("collect worker receipt");
    assert_eq!(receipts.len(), 1);
    receipts[0].verify().expect("worker receipt signature");
    assert_eq!(receipts[0].pubkey, relay);
    let parsed = parse_discovery_worker_receipt(&receipts[0])
        .expect("strict worker receipt");
    assert_eq!(parsed.actor_pubkey, actor.public_key());
    assert_eq!(parsed.action_event_id, action_id);
    parsed
}

async fn start_run(
    client: &mut BuzzTestClient,
    actor: &Keys,
    relay: nostr::PublicKey,
) -> Uuid {
    let request = DiscoveryStartRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        campaign_id: Uuid::new_v4(),
    };
    let event = build_discovery_start_action(relay, &request)
        .expect("valid start action")
        .sign_with_keys(actor)
        .expect("sign start action");
    let ok = client.send_event(event).await.expect("publish start");
    let answer: Value = serde_json::from_str(&ok.message).expect("structured start response");
    Uuid::parse_str(
        answer
            .get("run")
            .and_then(|run| run.get("run_id"))
            .and_then(Value::as_str)
            .expect("start run id"),
    )
    .expect("valid start run id")
}
```

- [ ] **Step 2: Add the ignored real-relay scenario**

Add the test with the following concrete sequence:

```rust
#[tokio::test]
#[ignore = "requires isolated Postgres, Redis, and relay with external Discovery workers enabled"]
async fn local_worker_is_restart_safe_private_and_fenced() {
    const LOCAL_SECRET: &str = "outscraper-secret-never-crosses-relay";
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_owned());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core::tenant::relay_url_authority(&relay_url());
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community exists")
        .try_get("id")
        .expect("community UUID");
    let actor = Keys::generate();
    let foreign = Keys::generate();
    provision_member(&pool, community_id, &actor).await;
    provision_member(&pool, community_id, &foreign).await;
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
         VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
         DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable entitlement");
    let relay = relay_pubkey().await;
    let mut actor_client = BuzzTestClient::connect(&relay_url(), &actor)
        .await
        .expect("authenticate actor");

    let first_run = start_run(&mut actor_client, &actor, relay).await;
    let worker_a = Uuid::new_v4();
    let claim_a = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_a,
    };
    let claimed_a = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_claim_action(relay, &claim_a).expect("claim builder"),
    )
    .await;
    let DiscoveryWorkerReceiptOutcome::Lease(lease_a) = claimed_a.receipt.outcome else {
        panic!("worker A must receive a lease");
    };
    assert_eq!(lease_a.run.run_id, first_run);
    assert_eq!(lease_a.attempt, 1);

    let submitted = DiscoveryWorkerCheckpointRequest {
        lease: DiscoveryWorkerLeaseRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: worker_a,
            run_id: first_run,
            lease_id: lease_a.lease_id,
        },
        checkpoint: DiscoveryWorkerCheckpoint {
            sequence: 1,
            kind: DiscoveryCheckpointKind::ProviderSubmitted,
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: Some("outscraper_req_001".into()),
            item_count: None,
        },
    };
    let checkpoint_a = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_checkpoint_action(relay, &submitted)
            .expect("checkpoint builder"),
    )
    .await;
    assert!(matches!(checkpoint_a.receipt.outcome, DiscoveryWorkerReceiptOutcome::Lease(_)));

    tokio::time::sleep(Duration::from_secs(6)).await;
    let worker_b = Uuid::new_v4();
    let claim_b = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
    };
    let claimed_b = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_claim_action(relay, &claim_b).expect("reclaim builder"),
    )
    .await;
    let DiscoveryWorkerReceiptOutcome::Lease(lease_b) = claimed_b.receipt.outcome else {
        panic!("worker B must reclaim the run");
    };
    assert_eq!(lease_b.run.run_id, first_run);
    assert_eq!(lease_b.attempt, 2);
    assert_eq!(
        lease_b
            .last_checkpoint
            .as_ref()
            .and_then(|value| value.provider_request_id.as_deref()),
        Some("outscraper_req_001")
    );

    let stale = DiscoveryWorkerCheckpointRequest {
        lease: DiscoveryWorkerLeaseRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: worker_a,
            run_id: first_run,
            lease_id: lease_a.lease_id,
        },
        checkpoint: DiscoveryWorkerCheckpoint {
            sequence: 2,
            kind: DiscoveryCheckpointKind::ProviderResultsReady,
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: None,
            item_count: Some(10),
        },
    };
    let stale_result = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_checkpoint_action(relay, &stale).expect("stale builder"),
    )
    .await;
    assert!(matches!(stale_result.receipt.outcome, DiscoveryWorkerReceiptOutcome::LostLease(_)));

    let cancel = DiscoveryRunRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        run_id: first_run,
    };
    let cancel_event = build_discovery_cancel_action(relay, &cancel)
        .expect("cancel builder")
        .sign_with_keys(&actor)
        .expect("sign cancel");
    actor_client
        .send_event(cancel_event)
        .await
        .expect("cancel run");
    let heartbeat_after_cancel = DiscoveryWorkerLeaseRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
        run_id: first_run,
        lease_id: lease_b.lease_id,
    };
    let cancelled_heartbeat = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_heartbeat_action(relay, &heartbeat_after_cancel)
            .expect("cancelled heartbeat builder"),
    )
    .await;
    assert!(matches!(cancelled_heartbeat.receipt.outcome, DiscoveryWorkerReceiptOutcome::LostLease(_)));

    let second_run = start_run(&mut actor_client, &actor, relay).await;
    let claim_c = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
    };
    let claimed_c = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_claim_action(relay, &claim_c).expect("second claim builder"),
    )
    .await;
    let DiscoveryWorkerReceiptOutcome::Lease(lease_c) = claimed_c.receipt.outcome else {
        panic!("second run must be leased");
    };
    assert_eq!(lease_c.run.run_id, second_run);
    sqlx::query(
        "UPDATE discovery_entitlements SET active=FALSE,updated_at=now() WHERE community_id=$1",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("revoke entitlement");
    sqlx::query(
        "UPDATE discovery_runs SET state='cancelled',cancel_requested=TRUE, \
         terminal_reason='entitlement_revoked',claim_id=NULL,lease_until=NULL, \
         worker_id=NULL,lease_owner_pubkey=NULL,updated_at=now() \
         WHERE community_id=$1 AND state IN ('queued','running')",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("apply revocation stop as entitlement authority");
    let revoke_heartbeat = DiscoveryWorkerLeaseRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
        run_id: second_run,
        lease_id: lease_c.lease_id,
    };
    let revoked_event = build_discovery_worker_heartbeat_action(relay, &revoke_heartbeat)
        .expect("revoked heartbeat builder")
        .sign_with_keys(&actor)
        .expect("sign revoked heartbeat");
    match actor_client.send_event(revoked_event).await {
        Ok(answer) => assert!(!answer.accepted, "revoked worker action must be rejected"),
        Err(error) => assert!(
            error.to_string().contains("subscription")
                || error.to_string().contains("restricted"),
            "unexpected revoke error: {error}"
        ),
    }

    sqlx::query(
        "UPDATE discovery_entitlements SET active=TRUE,updated_at=now() WHERE community_id=$1",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("restore entitlement");
    let third_run = start_run(&mut actor_client, &actor, relay).await;
    let claim_d = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
    };
    let claimed_d = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_claim_action(relay, &claim_d).expect("third claim builder"),
    )
    .await;
    let private_receipt_id = claimed_d.event_id;
    let DiscoveryWorkerReceiptOutcome::Lease(lease_d) = claimed_d.receipt.outcome else {
        panic!("third run must be leased");
    };
    assert_eq!(lease_d.run.run_id, third_run);
    let live_lease = DiscoveryWorkerLeaseRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: worker_b,
        run_id: third_run,
        lease_id: lease_d.lease_id,
    };
    let heartbeat = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_heartbeat_action(relay, &live_lease)
            .expect("heartbeat builder"),
    )
    .await;
    assert!(matches!(heartbeat.receipt.outcome, DiscoveryWorkerReceiptOutcome::Lease(_)));
    let completed = submit_worker_action(
        &mut actor_client,
        &actor,
        relay,
        build_discovery_worker_complete_action(relay, &DiscoveryWorkerLeaseRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            ..live_lease
        })
        .expect("complete builder"),
    )
    .await;
    assert!(matches!(completed.receipt.outcome, DiscoveryWorkerReceiptOutcome::Completed(_)));

    let leaked_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE community_id=$1 AND content LIKE '%' || $2 || '%'",
    )
    .bind(community_id)
    .bind(LOCAL_SECRET)
    .fetch_one(&pool)
    .await
    .expect("scan event content");
    let leaked_checkpoints: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_run_checkpoints \
         WHERE community_id=$1 AND provider_request_id LIKE '%' || $2 || '%'",
    )
    .bind(community_id)
    .bind(LOCAL_SECRET)
    .fetch_one(&pool)
    .await
    .expect("scan checkpoint content");
    assert_eq!((leaked_events, leaked_checkpoints), (0, 0));

    let mut foreign_client = BuzzTestClient::connect(&relay_url(), &foreign)
        .await
        .expect("authenticate foreign member");
    let p_tag = SingleLetterTag::lowercase(Alphabet::P);
    let foreign_filter = Filter::new()
        .kind(Kind::Custom(KIND_DISCOVERY_WORKER_RECEIPT as u16))
        .id(private_receipt_id)
        .custom_tags(p_tag, [actor.public_key().to_hex()]);
    foreign_client
        .subscribe("foreign-worker-receipt", vec![foreign_filter])
        .await
        .expect("send foreign worker receipt query");
    assert!(matches!(
        foreign_client
            .recv_event(Duration::from_secs(5))
            .await
            .expect("foreign query response"),
        RelayMessage::Closed { .. }
    ));
}
```

Populate `ParsedDiscoveryWorkerReceipt.event_id` from the parsed receipt event
in Task 2 so the foreign-read assertion targets the exact receipt. Keep the
six-second sleep as the only lease-expiry wait; all other state changes are
acknowledged by signed receipts.

- [ ] **Step 3: Prove the test fails without the completed protocol**

Run against an isolated relay before the worker broker is wired, or temporarily
disable `BUZZ_DISCOVERY_EXTERNAL_WORKER_ENABLED`, and verify the worker claim is
rejected. Restore the implementation/config before the green run. Record the
red failure message in the implementation log.

- [ ] **Step 4: Run the real-relay gate**

Start the isolated harness with:

```bash
BUZZ_DISCOVERY_FAKE_EXECUTOR_ENABLED=false
BUZZ_DISCOVERY_EXTERNAL_WORKER_ENABLED=true
BUZZ_DISCOVERY_LEASE_SECONDS=5
```

Then run:

```bash
RELAY_URL=ws://localhost:3030 \
DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz \
cargo test -p buzz-test-client --test e2e_discovery \
  local_worker_is_restart_safe_private_and_fenced -- --ignored --nocapture
```

Expected: one pass proving claim, checkpoint, reclaim attempt `2`, checkpoint
recovery, stale fencing, immediate cancel, entitlement revoke, heartbeat,
completion, receipt privacy, and secret absence.

- [ ] **Step 5: Commit the E2E proof**

```bash
git add crates/buzz-test-client/tests/e2e_discovery.rs
git commit -s -m "test(discovery): prove local worker recovery"
```

### Task 9: Run the phase gate and record evidence

**Files:**

- Modify: `docs/superpowers/specs/2026-08-02-colony-discovery-outscraper-businesses-design.md`

- [ ] **Step 1: Run focused gates**

```bash
. ./bin/activate-hermit
cargo test -p buzz-core discovery_worker
cargo test -p buzz-sdk discovery_worker
cargo test -p buzz-db discovery
cargo test -p buzz-relay discovery
```

Expected: all focused tests pass.

- [ ] **Step 2: Run repository gates**

```bash
just ci
```

Expected: formatting, strict clippy, desktop, web, mobile, unit tests, and builds
all pass. If an unrelated suite failure appears, reproduce it on a clean
`origin/develop` worktree before classifying it as baseline.

- [ ] **Step 3: Re-run the real-relay fault gate**

Run the Task 8 command once more against a freshly initialized isolated
database. Expected: pass with attempt `2`, no duplicate checkpoint/provider
reference, stale lease rejection, and private receipts.

- [ ] **Step 4: Update the design evidence**

Under the design specification's acceptance gate, add a dated
`Local worker protocol evidence` subsection listing:

- exact commit IDs;
- focused test commands and pass counts;
- `just ci` outcome;
- isolated relay/Postgres/Redis ports;
- red test failure observed before the fix;
- crash/reclaim attempt number;
- cancel and revoke results;
- foreign receipt read rejection;
- fixture-secret database/event search result;
- explicit statement that Outscraper, LLM, Tauri credentials, Campaign data,
  Leads, frontend integration, merge, deployment, and live customer use remain
  unproven.

- [ ] **Step 5: Commit the gate record**

```bash
git add docs/superpowers/specs/2026-08-02-colony-discovery-outscraper-businesses-design.md
git commit -s -m "docs(discovery): record local worker protocol gate"
```

## Stop boundary

Stop after Task 9 and return the proof gate to the user. Do not start keychain,
Outscraper, LLM, Campaign, Business, Lead, production `DiscoveryDataSource`, or
chat-reference implementation in the same phase. Recommend the next plan only
after this protocol is proven under the real-relay fault gate.
