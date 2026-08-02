# Colony Discovery Foundation Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:test-driven-development` for every behavior change. Do not begin implementation until the product owner explicitly approves the acceptance gate in this document.

**Goal:** Deliver the smallest production-shaped Discovery backend slice that lets an entitled Colony member or authorized agent start, inspect, and cancel a restart-safe business-discovery run through signed Nostr commands and the Colony CLI, using a deterministic zero-cost fake executor.

**Architecture:** Treat Nostr as the signed control and reference plane, while private relay storage owns run state, leases, authorization grants, entitlement state, and progress. Reuse the existing Company Action broker pattern for strict event validation and relay-signed receipts, and reuse the push queue's fenced lease pattern for crash-safe work claiming. Keep the executor behind a narrow interface so real discovery providers can replace the fake executor without changing the command, run, or CLI contracts.

**Tech Stack:** Rust, Tokio, SQLx/Postgres, Nostr events, Colony relay, `buzz-core`, `buzz-sdk`, `buzz-db`, `buzz-relay`, `buzz-cli`, and `buzz-test-client`.

---

## Scope and Acceptance Gate

This plan covers one independent subsystem: the Discovery foundation vertical slice.

It includes:

- strict signed Nostr `start`, `status`, and `cancel` Discovery actions;
- relay-signed Discovery receipts containing only a safe run projection;
- manually provisioned workspace entitlement state;
- server-enforced Discovery grants for agents;
- private persisted run state and command idempotency;
- fenced leases and restart-safe job execution;
- a deterministic, zero-cost fake executor;
- matching `buzz discovery` CLI commands;
- unit, database, relay, CLI, and real-relay integration tests.

It explicitly excludes:

- live Outscraper, Brave, Exa, or other discovery sources;
- API-key management or encryption;
- LLM qualification or rules-only qualification;
- business result persistence, lead creation, workspace-wide lead suppression, campaigns, or clients;
- People discovery;
- frontend changes;
- checkout, pricing, billing-provider integration, or automatic subscription provisioning;
- Outreach and Conversations.

The phase passes only when all of the following are proven against a real local relay with Postgres and Redis:

1. An entitled human member can start a run from the CLI and receive a relay-signed receipt.
2. An agent cannot start a run until a durable Discovery capability grant exists.
3. Replaying the same idempotency key returns the original run and does not create a second run.
4. Status reflects durable progress after reconnecting a CLI client.
5. A worker process can stop after claiming a run; after lease expiry, a replacement worker resumes it without applying any step twice.
6. Cancellation stops progress and reaches a durable terminal `cancelled` state.
7. Revoking entitlement immediately prevents new commands, stops an active run at the next fenced step boundary, records `entitlement_revoked`, and prevents status access.
8. The fake executor is disabled by default and cannot accidentally become a production Discovery source.
9. `just ci` passes from the implementation worktree.

## Non-Negotiable Invariants

- Never trust `users.capabilities` for authorization. It is descriptive profile data and may be self-declared.
- Human relay membership permits native Discovery only while the workspace entitlement is active.
- Agent pubkeys require an active `discovery.run` grant in addition to workspace entitlement.
- Reject channel-scoped authorization tokens for Discovery commands. Discovery is workspace-scoped.
- Do not place provider credentials, raw business records, qualification notes, or lead data in Nostr event content or tags.
- All state-changing commands are idempotent within a workspace.
- A lease claimant may update a run only while its claim token still matches and its lease is valid.
- Check entitlement and cancellation inside the same transaction that advances a step.
- A run target, campaign definition, providers, and results are outside this slice. `campaign_id` is an opaque UUID reference only.
- The fake executor has fixed server-configured behavior. A user cannot submit fake results or arbitrary fake step counts.

## Protocol Contract

Reserve two persistent kinds in `buzz-core`:

```rust
pub const KIND_DISCOVERY_ACTION: u32 = 40017;
pub const KIND_DISCOVERY_RECEIPT: u32 = 40018;
```

No ephemeral progress kind is needed in this slice. Durable progress is queried through a signed `status` action. This keeps the first contract small; realtime fan-out can be added without changing the run state model.

Actions use canonical JSON content and exact tags:

```text
kind: 40017
tags:
  ["p", "<relay pubkey>"]
  ["discovery-action", "start|status|cancel", "<request uuid>", "<idempotency uuid>"]
  ["campaign", "<campaign uuid>"]  # start only
  ["run", "<run uuid>"]            # status and cancel only
content: canonical JSON matching the tag values
```

Receipts are signed by the relay and contain:

```text
kind: 40018
tags:
  ["p", "<requesting actor pubkey>"]
  ["e", "<action event id>"]
  ["run", "<run uuid>"]
  ["discovery-receipt", "<operation>", "<request uuid>"]
content: canonical JSON safe run projection
```

The safe projection contains only:

```rust
pub struct DiscoveryRunProjection {
    pub run_id: Uuid,
    pub campaign_id: Uuid,
    pub state: DiscoveryRunState,
    pub completed_steps: u32,
    pub total_steps: u32,
    pub cancel_requested: bool,
    pub terminal_reason: Option<DiscoveryTerminalReason>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

It contains no business records and no source-specific payload.

## Task 0: Preflight the Dedicated Implementation Worktree

**Files:**

- Inspect only: `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine`
- Inspect only: `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-next`
- Inspect only: `/Users/mac/Desktop/Billion/AI-Native-Ventures-App`

- [ ] **Step 1: Confirm no other session has added overlapping engine work**

Run from any checkout:

```bash
git -C /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine status --short --branch
git -C /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine log --oneline --decorate -8
git -C /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine diff --stat origin/develop...HEAD
```

Expected: the worktree and current branch are identified before any edit. If overlapping files already exist, reconcile this plan with that actual work instead of duplicating it.

- [ ] **Step 2: Refresh branch truth without modifying another worktree**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine
. ./bin/activate-hermit
git fetch origin
git status --short --branch
git rev-parse HEAD
git rev-parse origin/develop
```

Expected: exact local and remote commit IDs are recorded. Do not reset, rebase, switch branches, or discard changes without the owning session's explicit coordination.

- [ ] **Step 3: Confirm kind and migration numbers are still free**

```bash
rg "40017|40018|DISCOVERY_(ACTION|RECEIPT)" crates desktop migrations
rg --files migrations | sort | tail -10
```

Expected: no existing use of kinds `40017`/`40018`, and migration `0030` is available. If either has been allocated, select the next free values consistently and update this plan before implementation.

- [ ] **Step 4: Establish baseline checks**

```bash
cargo test -p buzz-core --lib
cargo test -p buzz-sdk --lib
cargo test -p buzz-cli --lib
```

Expected: the baseline passes. Record any pre-existing failure before writing code.

No commit is created for this task.

## Task 1: Define the Strict Discovery Protocol

**Files:**

- Modify: `crates/buzz-core/src/kind.rs`
- Create: `crates/buzz-core/src/discovery.rs`
- Modify: `crates/buzz-core/src/lib.rs`
- Create: `crates/buzz-sdk/src/discovery.rs`
- Modify: `crates/buzz-sdk/src/lib.rs`
- Modify: `schema/schema.sql`
- Modify: `migrations/0001_initial_schema.sql`
- Test: `crates/buzz-search/tests/fts_integration.rs`
- Test: `crates/buzz-core/src/discovery.rs`
- Test: `crates/buzz-sdk/src/discovery.rs`

- [ ] **Step 1: Write failing core contract tests**

Add tests proving the exact enum vocabulary and state behavior:

```rust
#[test]
fn terminal_states_are_terminal() {
    assert!(!DiscoveryRunState::Queued.is_terminal());
    assert!(!DiscoveryRunState::Running.is_terminal());
    assert!(DiscoveryRunState::Succeeded.is_terminal());
    assert!(DiscoveryRunState::Cancelled.is_terminal());
    assert!(DiscoveryRunState::Failed.is_terminal());
}

#[test]
fn entitlement_revocation_is_a_stable_terminal_reason() {
    let json = serde_json::to_string(&DiscoveryTerminalReason::EntitlementRevoked)
        .expect("test serialization must succeed");
    assert_eq!(json, "\"entitlement_revoked\"");
}
```

Run:

```bash
cargo test -p buzz-core discovery -- --nocapture
```

Expected: FAIL because the Discovery types do not exist.

- [ ] **Step 2: Add the core domain types**

Define public, documented types with snake-case serde names:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryOperation {
    Start,
    Status,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryRunState {
    Queued,
    Running,
    Succeeded,
    Cancelled,
    Failed,
}

impl DiscoveryRunState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryTerminalReason {
    CancelledByActor,
    EntitlementRevoked,
    ExecutorFailed,
}
```

Add documented `DiscoveryStartRequest`, `DiscoveryRunRequest`, `DiscoveryAction`, `DiscoveryRunProjection`, and `DiscoveryReceipt` structs. Use UUIDs for request, idempotency, campaign, and run identifiers. Use `chrono::DateTime<Utc>` for timestamps.

- [ ] **Step 3: Reserve and classify the two kinds**

Add `KIND_DISCOVERY_ACTION` and `KIND_DISCOVERY_RECEIPT` in the next available product-kind block and make every registry update required by `kind.rs`:

- add both to `ALL_KINDS` and the compile-time `u16` bounds;
- add `KIND_DISCOVERY_ACTION` to `is_command_kind` and `AUTHOR_ONLY_KINDS`;
- add `KIND_DISCOVERY_RECEIPT` to `is_relay_only_kind`, `P_GATED_KINDS`, and `RESULT_GATED_KINDS`;
- add numeric, duplicate-registry, command-kind, relay-only-kind, and replaceability assertions beside the Company Action tests.

The action is author-only because its `p` tag addresses the relay, not the requester. The receipt is `p`-gated to the requester. Both are excluded from FTS.

Add tests alongside the existing kind-gate tests:

```rust
#[test]
fn discovery_receipts_are_privacy_gated() {
    assert!(P_GATED_KINDS.contains(&KIND_DISCOVERY_RECEIPT));
    assert!(RESULT_GATED_KINDS.contains(&KIND_DISCOVERY_RECEIPT));
    assert!(AUTHOR_ONLY_KINDS.contains(&KIND_DISCOVERY_ACTION));
}
```

Update the fresh-install expression in both `schema/schema.sql` and `migrations/0001_initial_schema.sql` so kinds `40017` and `40018` produce a NULL `search_tsv`. Extend `excluded_kinds_are_storage_level_unsearchable` in `crates/buzz-search/tests/fts_integration.rs` with both kinds. The upgrade for existing databases belongs in migration `0030` in Task 2.

- [ ] **Step 4: Write failing SDK builder/parser tests**

Follow the strict `company.rs` pattern. Test all three operations, canonical JSON, exact tag count, tag/content agreement, relay recipient, wrong signer, unknown tags, duplicate tags, missing identifiers, mismatched identifiers, and wrong kind.

Representative test:

```rust
#[test]
fn start_action_round_trips_with_exact_tags() {
    let keys = Keys::generate();
    let relay_keys = Keys::generate();
    let request = DiscoveryStartRequest {
        request_id: Uuid::from_u128(1),
        idempotency_key: Uuid::from_u128(2),
        campaign_id: Uuid::from_u128(3),
    };
    let event = build_discovery_start_action(relay_keys.public_key(), &request)
        .expect("test event must build")
        .sign_with_keys(&keys)
        .expect("test event must sign");

    let parsed = parse_discovery_action(&event)
        .expect("strict parser must accept its builder");
    assert_eq!(parsed, DiscoveryAction::Start(request));
    assert_eq!(event.tags.len(), 3);
}
```

Run:

```bash
cargo test -p buzz-sdk discovery -- --nocapture
```

Expected: FAIL because builders and parsers do not exist.

- [ ] **Step 5: Implement strict action and receipt builders/parsers**

Expose only operation-specific builders plus strict parsers:

```rust
pub fn build_discovery_start_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryStartRequest,
) -> Result<EventBuilder, DiscoverySdkError>;

pub fn build_discovery_status_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryRunRequest,
) -> Result<EventBuilder, DiscoverySdkError>;

pub fn build_discovery_cancel_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryRunRequest,
) -> Result<EventBuilder, DiscoverySdkError>;

pub fn parse_discovery_action(event: &Event) -> Result<DiscoveryAction, DiscoverySdkError>;

pub fn parse_discovery_receipt(event: &Event) -> Result<DiscoveryReceipt, DiscoverySdkError>;
```

Parser requirements:

- require the exact expected kind;
- require exactly one relay `p` tag on actions;
- require the exact operation-specific tags and reject extras;
- parse canonical content and compare every duplicated tag value;
- reject zero UUIDs;
- never log raw event content on parse failure.

Match the existing SDK trust boundary: builders return unsigned `EventBuilder` values, and strict parsers validate the envelope but do not decide signer authority. Relay ingest verifies the action signature and relay recipient; the CLI verifies the receipt signature and configured relay author before calling the parser. The relay broker owns its private relay-signed receipt builder, matching `company_broker.rs`.

- [ ] **Step 6: Run the focused protocol suites**

```bash
cargo test -p buzz-core discovery -- --nocapture
cargo test -p buzz-sdk discovery -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit the protocol contract**

```bash
git add crates/buzz-core/src/kind.rs crates/buzz-core/src/discovery.rs crates/buzz-core/src/lib.rs crates/buzz-sdk/src/discovery.rs crates/buzz-sdk/src/lib.rs schema/schema.sql migrations/0001_initial_schema.sql crates/buzz-search/tests/fts_integration.rs
git commit -s -m "feat(discovery): define signed run protocol"
```

## Task 2: Add Private Entitlement, Grant, Command, and Run Persistence

**Files:**

- Create: `migrations/0031_discovery_foundation.sql`
- Create: `crates/buzz-db/src/discovery.rs`
- Modify: `crates/buzz-db/src/lib.rs`
- Test: `crates/buzz-db/src/discovery.rs`

- [ ] **Step 1: Write the migration contract first**

Create the following private relay tables:

```sql
CREATE TABLE discovery_entitlements (
    community_id UUID PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE discovery_actor_grants (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor_pubkey BYTEA NOT NULL CHECK (octet_length(actor_pubkey) = 32),
    capability TEXT NOT NULL CHECK (capability = 'discovery.run'),
    granted_by BYTEA NOT NULL CHECK (octet_length(granted_by) = 32),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, actor_pubkey, capability)
);

CREATE TABLE discovery_runs (
    id UUID PRIMARY KEY,
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL,
    requested_by BYTEA NOT NULL CHECK (octet_length(requested_by) = 32),
    start_idempotency_key UUID NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'cancelled', 'failed')),
    completed_steps INTEGER NOT NULL DEFAULT 0 CHECK (completed_steps >= 0),
    total_steps INTEGER NOT NULL CHECK (total_steps > 0),
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    claim_id UUID,
    lease_until TIMESTAMPTZ,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    terminal_reason TEXT CHECK (terminal_reason IN ('cancelled_by_actor', 'entitlement_revoked', 'executor_failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (community_id, start_idempotency_key),
    CHECK (completed_steps <= total_steps),
    CHECK ((claim_id IS NULL) = (lease_until IS NULL))
);

CREATE INDEX discovery_runs_claimable_idx
    ON discovery_runs (state, lease_until, created_at)
    WHERE state IN ('queued', 'running');

CREATE TABLE discovery_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    idempotency_key UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('start', 'status', 'cancel')),
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    receipt_event_id BYTEA NOT NULL CHECK (octet_length(receipt_event_id) = 32),
    run_id UUID NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, idempotency_key),
    UNIQUE (community_id, action_event_id)
);
```

Add comments in the migration explaining that these tables are private relay state, not user-queryable Nostr data.

At the end of migration `0030`, preserve the installed database's current generated expression and wrap it with the new exclusions, following `migrations/0014_push_lease_fts.sql`:

```sql
DO $$
DECLARE
    existing_expression TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO existing_expression
      FROM pg_attrdef d
      JOIN pg_attribute a
        ON a.attrelid = d.adrelid
       AND a.attnum = d.adnum
     WHERE d.adrelid = 'events'::regclass
       AND a.attname = 'search_tsv';

    IF existing_expression IS NULL THEN
        RAISE EXCEPTION 'events.search_tsv generated expression not found';
    END IF;

    ALTER TABLE events DROP COLUMN search_tsv;
    EXECUTE format(
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (CASE WHEN kind IN (40017, 40018) THEN NULL::tsvector ELSE (%s) END) STORED',
        existing_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;
```

This upgrade must preserve the fresh-install positive allowlist and any operator-managed brownfield expression for all pre-existing kinds.

- [ ] **Step 2: Write failing ignored database tests**

Use the existing `BUZZ_TEST_DATABASE_URL`/`DATABASE_URL` setup pattern and isolated community fixtures. Add tests named:

```text
discovery_entitlement_defaults_to_inactive
discovery_human_member_is_authorized_when_entitled
discovery_agent_requires_active_server_grant
discovery_start_is_idempotent_within_community
discovery_same_idempotency_key_is_independent_across_communities
discovery_cancel_is_idempotent
discovery_claim_uses_fencing_token
discovery_expired_lease_can_be_reclaimed
discovery_stale_claim_cannot_advance_progress
discovery_step_transaction_stops_on_cancel
discovery_step_transaction_stops_on_entitlement_revocation
```

Representative fencing test:

```rust
#[tokio::test]
#[ignore = "requires Postgres"]
async fn discovery_stale_claim_cannot_advance_progress() {
    let fixture = DiscoveryDbFixture::new().await;
    let run = fixture.insert_entitled_run(3).await;
    let first = fixture.db.claim_discovery_run(Duration::seconds(1))
        .await
        .expect("claim query must succeed")
        .expect("run must be claimable");
    fixture.expire_lease(run.id).await;
    let second = fixture.db.claim_discovery_run(Duration::seconds(30))
        .await
        .expect("reclaim query must succeed")
        .expect("expired run must be reclaimable");

    let stale = fixture.db.advance_discovery_step(run.id, first.claim_id)
        .await
        .expect("stale advance query must complete");
    assert_eq!(stale, DiscoveryAdvance::LostLease);

    let current = fixture.db.advance_discovery_step(run.id, second.claim_id)
        .await
        .expect("current claimant must advance");
    assert!(matches!(current, DiscoveryAdvance::Advanced { completed_steps: 1, .. }));
}
```

Run:

```bash
cargo test -p buzz-db discovery -- --ignored --nocapture
```

Expected: FAIL because the schema and DB API do not exist.

- [ ] **Step 3: Add typed database records and errors**

Define documented database-facing types in `crates/buzz-db/src/discovery.rs`:

```rust
pub struct DiscoveryRunRecord {
    pub id: Uuid,
    pub community_id: CommunityId,
    pub campaign_id: Uuid,
    pub requested_by: Vec<u8>,
    pub start_idempotency_key: Uuid,
    pub state: DiscoveryRunState,
    pub completed_steps: i32,
    pub total_steps: i32,
    pub cancel_requested: bool,
    pub claim_id: Option<Uuid>,
    pub lease_until: Option<DateTime<Utc>>,
    pub attempt: i32,
    pub terminal_reason: Option<DiscoveryTerminalReason>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct ClaimedDiscoveryRun {
    pub run: DiscoveryRunRecord,
    pub claim_id: Uuid,
}

pub enum DiscoveryAdvance {
    Advanced { completed_steps: i32, total_steps: i32 },
    Completed,
    Cancelled(DiscoveryTerminalReason),
    LostLease,
}

pub enum DiscoveryAuthorization {
    AuthorizedHuman,
    AuthorizedAgent,
    EntitlementInactive,
    MembershipRequired,
    AgentGrantRequired,
}
```

Map SQL text values explicitly. Unknown database values must return a typed error; do not silently coerce them.

- [ ] **Step 4: Implement server-enforced authorization queries**

Add DB methods:

```rust
pub async fn discovery_authorization(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
) -> Result<DiscoveryAuthorization, DbError>;

pub async fn set_discovery_entitlement(
    &self,
    community_id: CommunityId,
    active: bool,
) -> Result<(), DbError>;

pub async fn set_discovery_actor_grant(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    granted_by: &[u8; 32],
    active: bool,
) -> Result<(), DbError>;
```

Authorization query order must be:

1. require active workspace entitlement;
2. require an exact row in the community-scoped `relay_members` table;
3. inspect the authoritative `users.agent_owner_pubkey` field;
4. permit a human member;
5. require an active `discovery.run` grant for an agent.

Do not accept a capability string from action content or from `users.capabilities`.

- [ ] **Step 5: Implement atomic command application**

Reuse the existing `pub(crate)` `event::insert_event_with_thread_metadata_tx` helper so the Discovery transaction preserves every event index and thread-metadata invariant. Do not change its visibility or duplicate its insert logic.

Add operation-specific methods that perform command claim, state mutation, action persistence, and receipt persistence in one SQL transaction:

```rust
pub async fn apply_discovery_start_once(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    request: &DiscoveryStartRequest,
    run_id: Uuid,
    total_steps: i32,
    action: &Event,
    receipt: &Event,
) -> Result<DiscoveryCommandResult, DiscoveryDbError>;

pub async fn apply_discovery_status_once(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    request: &DiscoveryRunRequest,
    action: &Event,
    receipt: &Event,
) -> Result<DiscoveryCommandResult, DiscoveryDbError>;

pub async fn apply_discovery_cancel_once(
    &self,
    community_id: CommunityId,
    actor_pubkey: &[u8; 32],
    request: &DiscoveryRunRequest,
    action: &Event,
    receipt: &Event,
) -> Result<DiscoveryCommandResult, DiscoveryDbError>;
```

Rules:

- Recheck authorization inside the transaction before every command.
- Start derives `run_id` deterministically from `community_id + idempotency_key` using UUID v5, so retries can build the identical queued receipt.
- A duplicate idempotency key returns the original action event ID, receipt event ID, and run projection.
- Reusing an idempotency key for a different operation or payload returns a conflict.
- Status and cancel require an entitled, authorized actor and a run in the same server-resolved community. They are intentionally workspace-collaborative: an entitled human member or granted agent may inspect or cancel a run started by another authorized actor. Cross-workspace access returns not found without revealing existence.
- Cancel sets `cancel_requested = TRUE`; it does not pretend the worker has already stopped.
- Persist only the safe action and receipt events. Private run rows never pass through generic Nostr query paths.

- [ ] **Step 6: Implement claim, renewal, and fenced progress APIs**

Add:

```rust
pub async fn claim_discovery_run(
    &self,
    lease_duration: chrono::Duration,
) -> Result<Option<ClaimedDiscoveryRun>, DiscoveryDbError>;

pub async fn renew_discovery_lease(
    &self,
    run_id: Uuid,
    claim_id: Uuid,
    lease_duration: chrono::Duration,
) -> Result<bool, DiscoveryDbError>;

pub async fn advance_discovery_step(
    &self,
    run_id: Uuid,
    claim_id: Uuid,
) -> Result<DiscoveryAdvance, DiscoveryDbError>;

pub async fn fail_discovery_run(
    &self,
    run_id: Uuid,
    claim_id: Uuid,
    reason: DiscoveryTerminalReason,
) -> Result<bool, DiscoveryDbError>;
```

Use `FOR UPDATE SKIP LOCKED` when claiming. This is a relay-wide background queue: the claim query does not accept client or connection tenant input and returns the `CommunityId` read from the claimed database row. Every subsequent mutation includes both that DB-resolved community and the run ID in its predicate. Add a two-community test proving a claimed row can never cause a write to the other community.

`advance_discovery_step` must lock the run row and entitlement row, then follow this order in one transaction:

1. verify `claim_id` and unexpired `lease_until`;
2. if entitlement inactive, set `cancelled`, reason `entitlement_revoked`, clear the lease, and return `Cancelled`;
3. if `cancel_requested`, set `cancelled`, reason `cancelled_by_actor`, clear the lease, and return `Cancelled`;
4. increment `completed_steps` exactly once;
5. if the new value equals `total_steps`, set `succeeded` and clear the lease;
6. otherwise keep `running` and retain the claim.

- [ ] **Step 7: Run migration and DB tests**

```bash
cargo test -p buzz-db discovery -- --ignored --nocapture
cargo test -p buzz-search --test fts_integration excluded_kinds_are_storage_level_unsearchable -- --ignored --nocapture
cargo test -p buzz-search --test fts_integration p_gated_persistent_kinds_have_storage_null_tsvector -- --ignored --nocapture
```

Expected: all Discovery database tests PASS against the configured test database, and both storage-level search privacy tripwires PASS with kinds `40017` and `40018`.

- [ ] **Step 8: Commit private persistence**

```bash
git add migrations/0031_discovery_foundation.sql crates/buzz-db/src/discovery.rs crates/buzz-db/src/lib.rs
git commit -s -m "feat(discovery): persist entitled restart-safe runs"
```

## Task 3: Add the Relay Discovery Broker

**Files:**

- Create: `crates/buzz-relay/src/discovery_broker.rs`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-relay/src/handlers/ingest.rs`
- Test: `crates/buzz-relay/src/discovery_broker.rs`

- [ ] **Step 1: Write failing broker tests**

Build tests around a narrow broker service with fake authorization/database seams where possible. Cover:

```text
rejects_invalid_signature
rejects_wrong_recipient_relay
rejects_channel_scoped_authorization
rejects_inactive_entitlement
rejects_agent_without_server_grant
accepts_entitled_human_member
accepts_granted_agent
start_returns_relay_signed_queued_receipt
duplicate_start_returns_original_run
status_returns_safe_projection
cancel_returns_cancel_requested_projection
cross_workspace_run_is_not_found
receipt_contains_no_private_source_or_result_fields
```

Representative test assertion:

```rust
assert_eq!(receipt_event.kind.as_u16(), KIND_DISCOVERY_RECEIPT);
assert_eq!(receipt_event.pubkey, relay_keys.public_key());
assert_eq!(receipt.run.run_id, expected_run_id);
assert_eq!(receipt.run.state, DiscoveryRunState::Queued);
assert!(!receipt_event.content.contains("api_key"));
assert!(!receipt_event.content.contains("provider"));
assert!(!receipt_event.content.contains("business"));
```

Run:

```bash
cargo test -p buzz-relay discovery_broker -- --nocapture
```

Expected: FAIL because the broker does not exist.

- [ ] **Step 2: Implement the broker handler**

Mirror the free-function shape of `company_broker.rs`, but keep Discovery-specific authorization in the DB layer and preserve the server-resolved tenant fence:

```rust
pub(crate) async fn handle_discovery_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<DiscoveryBrokerOutcome, DiscoveryBrokerError>;
```

Handler order:

1. require a durable configured relay signing key, as Company Action does;
2. verify signature and strict SDK parsing;
3. require the action `p` tag to equal this relay's public key;
4. reject `start` when the fake executor config is disabled;
5. query authorization under `tenant.community()` without exposing whether a run exists;
6. create and relay-sign the safe operation-specific receipt with a private broker helper;
7. call the atomic DB method;
8. publish the stored action and receipt through the normal relay fan-out;
9. return the receipt event ID and projection in the NIP-01 `OK` message.

The ingest handler, not the broker function, rejects `auth.channel_ids().is_some()` before calling the broker. Never construct a `TenantContext` or accept a community UUID from event content.

Map errors deliberately:

```rust
pub enum DiscoveryBrokerError {
    InvalidAction,
    ChannelScopeForbidden,
    EntitlementRequired,
    MembershipRequired,
    CapabilityRequired,
    RunNotFound,
    IdempotencyConflict,
    ExecutorUnavailable,
    Internal,
}
```

Only `Internal` logs server detail. Client messages must not contain SQL errors, authorization internals, or private state.

- [ ] **Step 3: Intercept Discovery actions in ingest**

In `handlers/ingest.rs`, add Discovery handling beside Company Action handling, after generic moderation/authentication gates and before normal event storage. The generic path must never store an unvalidated Discovery action.

Add `KIND_DISCOVERY_ACTION` to the explicit required-scope mapping with the same workspace write scope used by Company Action. The broker remains responsible for entitlement and human/agent capability authorization.

- [ ] **Step 4: Prove generic queries obey receipt privacy gates**

Extend existing relay query-policy tests so:

- a receipt query without matching authenticated `p` access is rejected;
- an authenticated actor can query their own receipt by event ID;
- another member cannot query that receipt;
- open-ended result queries cannot include kind `40018`.

- [ ] **Step 5: Run focused relay tests**

```bash
cargo test -p buzz-relay discovery -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit the relay command plane**

```bash
git add crates/buzz-relay/src/discovery_broker.rs crates/buzz-relay/src/lib.rs crates/buzz-relay/src/handlers/ingest.rs
git commit -s -m "feat(discovery): broker signed run commands"
```

## Task 4: Add the Durable Fake Discovery Worker

**Files:**

- Create: `crates/buzz-relay/src/discovery_runtime.rs`
- Modify: `crates/buzz-relay/src/config.rs`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-relay/src/main.rs`
- Test: `crates/buzz-relay/src/discovery_runtime.rs`

- [ ] **Step 1: Write failing runtime tests using a controllable clock/executor**

Define tests for:

```text
fake_executor_is_disabled_by_default
worker_claims_one_eligible_run
worker_advances_deterministic_steps
worker_completes_at_total_steps
cancel_stops_before_next_step
entitlement_revoke_stops_before_next_step
lost_lease_prevents_stale_worker_progress
expired_lease_resumes_from_persisted_progress
executor_failure_marks_run_failed
shutdown_releases_no_unfenced_progress
```

The restart test must assert exact progress, not merely terminal state:

```rust
assert_eq!(before_restart.completed_steps, 2);
assert_eq!(after_recovery.completed_steps, 5);
assert_eq!(after_recovery.total_steps, 5);
assert_eq!(after_recovery.state, DiscoveryRunState::Succeeded);
assert_eq!(executor.recorded_steps(run_id), vec![1, 2, 3, 4, 5]);
```

Run:

```bash
cargo test -p buzz-relay discovery_runtime -- --nocapture
```

Expected: FAIL because the runtime does not exist.

- [ ] **Step 2: Add explicit, safe config**

Add environment-backed relay config with these defaults:

```rust
pub struct DiscoveryConfig {
    pub fake_executor_enabled: bool, // BUZZ_DISCOVERY_FAKE_EXECUTOR_ENABLED, default false
    pub fake_total_steps: u32,       // BUZZ_DISCOVERY_FAKE_TOTAL_STEPS, default 5, range 1..=100
    pub worker_count: usize,         // BUZZ_DISCOVERY_WORKER_COUNT, default 1, range 1..=16
    pub lease_seconds: u64,          // BUZZ_DISCOVERY_LEASE_SECONDS, default 30, minimum 5
    pub poll_millis: u64,            // BUZZ_DISCOVERY_POLL_MILLIS, default 500, minimum 50
}
```

When the executor is disabled, do not spawn Discovery workers and reject new starts with `ExecutorUnavailable`. Existing run rows remain untouched for inspection after the executor is re-enabled by an operator.

- [ ] **Step 3: Define a narrow executor boundary**

```rust
#[async_trait]
pub trait DiscoveryExecutor: Send + Sync {
    async fn execute_step(
        &self,
        run: &DiscoveryRunRecord,
        step_number: u32,
    ) -> Result<(), DiscoveryExecutorError>;
}

pub struct DeterministicFakeDiscoveryExecutor;
```

The fake executor performs no network I/O, no LLM call, and no filesystem write. It records no fake businesses. Its only effect is returning success for a numbered step so the DB can advance durable progress.

- [ ] **Step 4: Implement the bounded worker loop**

Follow `push_runtime.rs` for shutdown and bounded concurrency. Separate the loop from one-iteration logic:

```rust
pub async fn run_discovery_worker(
    db: Db,
    executor: Arc<dyn DiscoveryExecutor>,
    config: DiscoveryWorkerConfig,
    shutdown: CancellationToken,
) -> Result<(), DiscoveryRuntimeError>;

pub async fn process_one_discovery_run(
    db: &Db,
    executor: &dyn DiscoveryExecutor,
    config: &DiscoveryWorkerConfig,
) -> Result<ProcessOneOutcome, DiscoveryRuntimeError>;
```

For each step:

1. claim or reclaim one run from the relay-wide queue and retain its DB-resolved `CommunityId`;
2. calculate `next_step = completed_steps + 1` from durable state;
3. execute that step;
4. call the fenced transaction to commit the step;
5. stop immediately on `LostLease`, cancellation, entitlement revocation, completion, or shutdown;
6. renew the lease before it reaches half its configured duration during any long-running step.

The fake step is side-effect-free, so executing a step before a crash and retrying it is harmless. Real source adapters are not permitted until they supply their own provider idempotency key or durable outbox/receipt strategy.

- [ ] **Step 5: Spawn workers from relay startup**

In `main.rs`, spawn exactly `worker_count` tasks only when `fake_executor_enabled` is true. Give each task the existing relay shutdown signal. Log worker start/stop and run IDs, but never log request event content or future provider payloads.

- [ ] **Step 6: Run runtime and database fault tests**

```bash
cargo test -p buzz-relay discovery_runtime -- --nocapture
cargo test -p buzz-db discovery -- --ignored --nocapture
```

Expected: PASS, including lost-lease and entitlement-revocation tests.

- [ ] **Step 7: Commit the worker runtime**

```bash
git add crates/buzz-relay/src/discovery_runtime.rs crates/buzz-relay/src/config.rs crates/buzz-relay/src/lib.rs crates/buzz-relay/src/main.rs
git commit -s -m "feat(discovery): run fenced fake discovery jobs"
```

## Task 5: Add Matching Agent-First CLI Commands

**Files:**

- Create: `crates/buzz-cli/src/commands/discovery.rs`
- Modify: `crates/buzz-cli/src/commands/mod.rs`
- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/client.rs`
- Test: `crates/buzz-cli/src/commands/discovery.rs`
- Test: `crates/buzz-cli/src/lib.rs`

- [ ] **Step 1: Write failing CLI parsing and output tests**

Add Clap tests for the exact surface:

```text
buzz discovery start --campaign <uuid>
buzz discovery start --campaign <uuid> --idempotency-key <uuid>
buzz discovery status --run <uuid>
buzz discovery status --run <uuid> --idempotency-key <uuid>
buzz discovery cancel --run <uuid>
buzz discovery cancel --run <uuid> --idempotency-key <uuid>
```

Test invalid UUIDs, missing required flags, mutually incorrect flags, compact JSON, and human-readable output.

Run:

```bash
cargo test -p buzz-cli discovery -- --nocapture
```

Expected: FAIL because the command does not exist.

- [ ] **Step 2: Add the Clap command model**

```rust
#[derive(Debug, Subcommand)]
pub enum DiscoveryCommand {
    Start {
        #[arg(long)]
        campaign: Uuid,
        #[arg(long)]
        idempotency_key: Option<Uuid>,
    },
    Status {
        #[arg(long)]
        run: Uuid,
        #[arg(long)]
        idempotency_key: Option<Uuid>,
    },
    Cancel {
        #[arg(long)]
        run: Uuid,
        #[arg(long)]
        idempotency_key: Option<Uuid>,
    },
}
```

Generate a UUID v4 when `--idempotency-key` is omitted. Print it in the output so an agent can safely retry the same command after a network interruption.

- [ ] **Step 3: Implement publish-and-fetch behavior**

Follow `commands/company.rs`:

1. discover the relay public key through the existing authenticated client path;
2. build and sign the strict action with the actor key;
3. publish it as a stored event;
4. parse the structured `OK` response;
5. fetch the relay-signed receipt by `kind`, `#p`, and `#e`;
6. verify and parse the receipt with `buzz-sdk`;
7. print the safe projection.

Do not treat an `OK` response alone as authoritative if the matching signed receipt cannot be fetched and verified.

Use exit codes consistently:

- `0`: accepted and verified;
- `1`: invalid local input;
- `2`: relay/network failure;
- `3`: authentication, membership, entitlement, or capability rejection;
- `4`: malformed/unverifiable relay result;
- `5`: idempotency conflict.

- [ ] **Step 4: Stabilize machine-readable output**

Compact JSON must have this shape:

```json
{
  "request_id": "00000000-0000-0000-0000-000000000001",
  "idempotency_key": "00000000-0000-0000-0000-000000000002",
  "receipt_event_id": "<64 lowercase hex characters>",
  "run": {
    "run_id": "00000000-0000-0000-0000-000000000003",
    "campaign_id": "00000000-0000-0000-0000-000000000004",
    "state": "queued",
    "completed_steps": 0,
    "total_steps": 5,
    "cancel_requested": false,
    "terminal_reason": null,
    "created_at": "2026-08-02T00:00:00Z",
    "updated_at": "2026-08-02T00:00:00Z"
  }
}
```

Human-readable output should lead with state and run ID, then progress and campaign ID. Do not print internal claim IDs, attempts, lease timestamps, actor grants, or entitlement rows.

- [ ] **Step 5: Run CLI tests**

```bash
cargo test -p buzz-cli discovery -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit the CLI surface**

```bash
git add crates/buzz-cli/src/commands/discovery.rs crates/buzz-cli/src/commands/mod.rs crates/buzz-cli/src/lib.rs crates/buzz-cli/src/client.rs
git commit -s -m "feat(discovery): add run CLI commands"
```

## Task 6: Prove the Vertical Slice Against a Real Relay

**Files:**

- Create: `crates/buzz-test-client/tests/e2e_discovery.rs`
- Modify if required by existing test registration: `crates/buzz-test-client/Cargo.toml`
- Test: `crates/buzz-test-client/tests/e2e_discovery.rs`

- [ ] **Step 1: Write the failing end-to-end test before completing wiring**

The test must launch or use the standard isolated relay fixture with Postgres and Redis, enable the fake executor, and create:

- one entitled community;
- one human member;
- one agent member owned by that human;
- one agent Discovery grant;
- one opaque campaign UUID.

Add separate tests:

```text
e2e_discovery_entitled_human_run_completes
e2e_discovery_agent_requires_grant
e2e_discovery_duplicate_start_returns_one_run
e2e_discovery_cancel_stops_run
e2e_discovery_entitlement_revoke_stops_and_locks
e2e_discovery_expired_lease_resumes_exactly_once
e2e_discovery_receipt_is_private_to_actor
```

Run:

```bash
cargo test -p buzz-test-client --test e2e_discovery -- --ignored --nocapture
```

Expected: FAIL until every relay/runtime/CLI path is wired into the test harness.

- [ ] **Step 2: Prove the human CLI flow**

From the test harness, execute the built CLI or exercise the identical client command layer:

```bash
buzz --format compact discovery start --campaign "$DISCOVERY_TEST_CAMPAIGN_ID" --idempotency-key "$DISCOVERY_TEST_IDEMPOTENCY_KEY"
buzz --format compact discovery status --run "$DISCOVERY_TEST_RUN_ID"
```

Assertions:

- returned receipt verifies against relay pubkey;
- status reaches `succeeded`;
- progress is exactly `5/5`;
- only one `discovery_runs` row exists for the start idempotency key;
- exactly one start claim exists.

- [ ] **Step 3: Prove capability enforcement**

Run the same start as the agent before and after inserting the server grant.

Expected:

- before grant: exit `3`, no run, no stored action or receipt;
- after grant: exit `0`, one run, verified receipt.

- [ ] **Step 4: Prove restart safety with a forced lease handoff**

Use a test-only executor barrier to pause after two committed steps. Stop the first worker without marking the run failed. Advance the test clock or wait for the deliberately short test lease, start a replacement worker, and assert:

```text
persisted progress before stop: 2/5
persisted progress after reclaim: 2/5
final progress: 5/5
committed step sequence: 1,2,3,4,5
stale claimant update count: 0
```

- [ ] **Step 5: Prove cancellation**

Pause after one committed step, publish `cancel`, release the worker, and poll signed status.

Expected:

```text
state: cancelled
completed_steps: 1
terminal_reason: cancelled_by_actor
cancel_requested: true
no later progress after terminal state
```

- [ ] **Step 6: Prove entitlement revocation and lockout**

Pause after one committed step, set `discovery_entitlements.active = FALSE` through the DB fixture, and release the worker.

Expected:

- the next fenced step transaction records `cancelled` with `entitlement_revoked` without incrementing progress;
- a new `start` is rejected;
- `status` is rejected even for the original actor;
- the private run row remains stored;
- no Discovery receipt or projection is accessible through an unauthorized generic query.

- [ ] **Step 7: Run the complete integration test**

```bash
cargo test -p buzz-test-client --test e2e_discovery -- --ignored --nocapture
```

Expected: all seven Discovery E2E tests PASS.

- [ ] **Step 8: Commit end-to-end proof**

```bash
git add crates/buzz-test-client/tests/e2e_discovery.rs crates/buzz-test-client/Cargo.toml
git commit -s -m "test(discovery): prove entitled restart-safe runs"
```

If `Cargo.toml` does not require a change, do not stage it.

## Task 7: Run the Final Proof Gate and Produce the Handoff

**Files:**

- Modify only if implementation truth requires it: `docs/superpowers/specs/2026-08-02-colony-discovery-production-phase-one-design.md`
- Create: `docs/superpowers/proofs/2026-08-02-colony-discovery-foundation-proof.md`

- [ ] **Step 1: Run formatting and focused checks**

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test -p buzz-core discovery -- --nocapture
cargo test -p buzz-sdk discovery -- --nocapture
cargo test -p buzz-cli discovery -- --nocapture
cargo test -p buzz-relay discovery -- --nocapture
cargo test -p buzz-db discovery -- --ignored --nocapture
cargo test -p buzz-search --test fts_integration excluded_kinds_are_storage_level_unsearchable -- --ignored --nocapture
cargo test -p buzz-search --test fts_integration p_gated_persistent_kinds_have_storage_null_tsvector -- --ignored --nocapture
cargo test -p buzz-test-client --test e2e_discovery -- --ignored --nocapture
```

Expected: every command PASS.

- [ ] **Step 2: Run the repository gate**

```bash
just ci
```

Expected: PASS. If a failure also reproduces on clean `origin/develop`, record it as baseline evidence; do not silently label the feature proven while its relevant checks are failing.

- [ ] **Step 3: Inspect the implementation diff**

```bash
git status --short
git diff --check origin/develop...HEAD
git diff --stat origin/develop...HEAD
git log --show-signature --format=fuller origin/develop..HEAD
```

Expected:

- no unstaged implementation files;
- no whitespace errors;
- only the foundation files in this plan changed;
- every new commit has a `Signed-off-by` trailer;
- no frontend, provider, People, LLM, billing, Outreach, or CRM implementation slipped into the diff.

- [ ] **Step 4: Write the proof record**

The proof document must record:

```markdown
# Colony Discovery Foundation Proof

## Proven
- Exact commit SHA and branch.
- Protocol tests and their command output summary.
- Database lease and fencing tests.
- Real-relay E2E cases.
- `just ci` result.

## Faults Injected
- Worker stopped after two committed steps.
- Lease expired and was reclaimed.
- Stale claimant attempted an update.
- Cancellation requested during a paused run.
- Entitlement revoked during a paused run.

## Corrected During the Phase
- List only defects actually found and corrected.

## Not Yet Proven
- Live provider calls.
- Credential encryption.
- LLM or rules qualification.
- Business result and Lead persistence.
- UI integration.

## Next Recommended Phase
- Provider-neutral business result contract, encrypted BYOK source configuration, one live source adapter, qualification boundary, workspace suppression, and automatic Lead persistence—subject to a new approved acceptance gate.
```

- [ ] **Step 5: Commit only proof-related changes**

```bash
git add docs/superpowers/proofs/2026-08-02-colony-discovery-foundation-proof.md
git commit -s -m "docs(discovery): record foundation proof gate"
```

If the approved design spec required a factual correction, stage it explicitly and explain why in the proof record. Do not broaden the product contract during implementation.

- [ ] **Step 6: Stop at the gate**

Report separately:

- implemented;
- locally unit-tested;
- integration-tested against real Postgres/Redis/relay;
- committed;
- pushed or not pushed;
- merged or not merged;
- deployed or not deployed;
- live-used or not live-used.

Do not begin live-provider work, frontend integration, or Phase Two from this plan.

## Review Checklist for the Implementing Session

Before calling the phase complete, verify every answer is **yes**:

- [ ] Are command events strictly signed, addressed to the relay, and parsed with exact tags?
- [ ] Are receipts relay-signed and limited to a safe run projection?
- [ ] Are receipt queries protected by both `p` and result gates?
- [ ] Does authorization ignore self-declared capability metadata?
- [ ] Are agent grants durable and server-enforced?
- [ ] Does every command recheck active entitlement inside its transaction?
- [ ] Is command replay idempotent and payload conflict explicit?
- [ ] Can no cross-workspace request reveal that a run exists?
- [ ] Does every progress write require the current unexpired claim token?
- [ ] Does step advancement check entitlement and cancellation before incrementing?
- [ ] Can a reclaimed run finish without duplicate committed steps?
- [ ] Is the fake executor disabled by default and guaranteed zero-cost?
- [ ] Are no raw businesses, provider payloads, API keys, or lead data stored in Nostr events?
- [ ] Do the CLI commands verify the relay-signed receipt?
- [ ] Has entitlement revocation been fault-injected during an active run?
- [ ] Has worker death been fault-injected after partial progress?
- [ ] Has the full repository gate passed?
