# Channel Workspace Phase B1 Implementation Plan: ownership protocol (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the relay-side contract for workspace tab ownership: a tab has an
owner and exactly one driver, the driver seat changes hands only through the
relay, and every change is atomic and auditable. Stage 1 proves an open-and-take-back
handover against a live relay; Stage 2 adds grants to agents and agent read scope.

**Architecture:** Canonical tab state is **one Postgres row** per
`(community, channel, tab_id)` with a `revision` for compare-and-swap. Clients
never write ownership; they submit a signed **action** and the relay validates
it, mutates the row in one transaction, and emits a relay-signed **receipt**
plus a relay-signed **head projection** for shared channel UI. Tab payloads
never reach the relay.

**Tech Stack:** Postgres migration, `buzz-db` for the CAS, `buzz-core` for kinds
and action parsing, `buzz-relay` for the broker and ingest wiring, `buzz-cli`
for the agent surface, `buzz-test-client` for the live proof.

## Why v2 exists, and what v1 got wrong

v1 modelled the tab head as a client-authored NIP-33 replaceable event with
`d = tab_id`, and assumed that produced one canonical head per tab. **It does
not.** The replacement key is `(community, kind, pubkey, d_tag)`
(`crates/buzz-db/src/lib.rs:180-189`, `schema/schema.sql:264-266`), author
included, so two members publishing the same `d` produce two live rows each
claiming a driver. v1 also gated only grants at ingest, leaving heads and
takeovers forgeable by any channel member, and then authorized grants by reading
one of those forgeable heads.

`migrations/0044_jobs.sql` states the governing principle in this repo's own
words: *"Nostr events cannot answer it. They are append-only and unordered
across clients, so two workers appending 'I'll take it' are both equally true.
Mutual exclusion needs a compare-and-set against one authority."* Tab ownership
is the same problem, and gets the same answer.

Three further v1 defects this plan fixes:

- v1's payload test proved only that a Rust struct ignored `event.content`. The
  signed event still carried it and ingest still stored and fanned it out. Task 6
  rejects non-empty content at the boundary, which is what makes the guarantee real.
- v1 added kinds to `ALL_KINDS` and stopped. `required_scope_for_kind`
  (`crates/buzz-relay/src/handlers/ingest.rs:430-592`) is an explicit allowlist
  and an unmapped kind is refused with `restricted: unknown event kind`.
- v1 refused a grant for an unknown tab with a message naming the tab, an
  existence oracle in a plan that argued two sections earlier against exactly that.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-07-colony-channel-browser-workspace-design.md`, **Ownership and concurrency**.
- **The DB row is the authority.** Events project it and audit it. No code may
  infer ownership from an event when it could read the row.
- **Payloads never cross the relay.** Enforced by rejecting non-empty content on
  workspace kinds at ingest, not by a parser that looks away.
- **Every state change is one transaction.** Row update, audit and head
  projection commit together or not at all. No read-then-write without a
  revision check.
- Channel ids on the wire are **UUIDs**: `extract_channel_id`
  (`ingest.rs:594-605`) parses them as such, so `"chan-a"` works only in pure
  unit tests, never in a wire test.
- All kind integers live in `crates/buzz-core/src/kind.rs`. Registering a kind
  means: the constant, `ALL_KINDS`, the classification lists it belongs in,
  `required_scope_for_kind`, and `requires_h_channel_scope` (`ingest.rs:785-818`).
- Migrations are numbered; the latest on this branch is `0055`, so this is
  **`0056`**. `schema/schema.sql` must be updated in the same commit, because
  provisioned installs can skip embedded migrations
  (`crates/buzz-db/src/migration.rs:1-20,51-63`).
- No `unsafe`. No new `unwrap()`/`expect()` in production paths. New public API
  needs doc comments. 1000-line ceiling per file.
- Commit with `git commit -s`. `just ci` and `just test` (Postgres + Redis)
  before the PR.

## Staging

**Stage 1 (Tasks 1-8): open and take back.** Canonical state, the broker, two
operations, the CLI, and a live proof including two racing takes. This is a
shippable slice: a human opens a tab, something else holds it, the human takes
it back, and the relay decides who won.

**Stage 2 (Tasks 9-12): grant and read scope.** Handing a tab to an agent, and
narrowing what an agent can see. Do not start Stage 2 until Stage 1's race test
passes against a live relay.

Ship Stage 1 as its own PR. A half-built ownership system merged into `develop`
is safe here only because nothing in the desktop app reads it yet (Phase B2 is a
separate plan and lands after).

## Out of scope for B1

| Deferred | Why | Lands in |
| --- | --- | --- |
| The whole desktop surface | Needs this protocol settled first | Phase B2 |
| Pausing an agent turn, invalidating pending refs, explicit continuation | Runtime concern, not a protocol one; the spec requires it and **B1 does not deliver it** | Phase B2 |
| Recording a takeover in the thread | The spec requires it; the receipt is not a thread message | Phase B2, with the thread mirror |
| Agent-created tabs rendering on a human's screen | Needs payload transport; heads carry metadata only | When a portable kind needs it |
| Approvals, evidence, ledger | Separate surfaces | Phase B3 |
| `web`, `terminal`, `video` kinds | Unchanged | Phases C and D |

**This plan does not claim full coverage of the spec's "Ownership and
concurrency" section.** It delivers single-driver arbitration, grant, takeover
and agent read scope. It does not deliver pausing, ref invalidation, or the
thread record. Those are named above, not silently skipped.

## File structure

| File | Responsibility |
| --- | --- |
| `migrations/0056_workspace_tabs.sql` | Canonical tab state |
| `schema/schema.sql` | Same table, kept in sync |
| `crates/buzz-db/src/workspace_tabs.rs` | Insert, read, and the CAS transitions |
| `crates/buzz-core/src/workspace_tab.rs` | Kinds' payloads: parse and validate actions |
| `crates/buzz-relay/src/workspace_tab_broker.rs` | Apply an action, emit receipt and head |
| `crates/buzz-cli/src/commands/workspace.rs` | `buzz workspace tabs …` |
| `crates/buzz-test-client/tests/e2e_workspace_tabs.rs` | Live proof, races included |
| `docs/nips/NIP-WS.md` | The protocol, written down |

Modified: `crates/buzz-core/src/kind.rs`, `crates/buzz-db/src/lib.rs`,
`crates/buzz-relay/src/lib.rs`, `crates/buzz-relay/src/handlers/ingest.rs`,
`crates/buzz-cli/src/lib.rs` (**not `main.rs`** — the command enum and dispatch
live in `lib.rs` around lines 189-300 and 2907-2938).

---

# Stage 1: open and take back

## Task 1: Canonical tab state

**Files:**
- Create: `migrations/0056_workspace_tabs.sql`
- Modify: `schema/schema.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `workspace_tabs`.

- [ ] **Step 1: Read the precedent**

Read `migrations/0044_jobs.sql` in full. It is the closest thing in the tree: a
row that exists specifically to arbitrate between claimants, with a comment
explaining why events cannot. Match its conventions: `community_id` first, FK to
`communities` with `ON DELETE CASCADE`, composite tenant key, an FK on
`(community_id, channel_id)` to `channels`, a channel index, `CHECK`
constraints, and BIGINT epoch timestamps.

Note its `head_at` column and the reason for it: NIP-33 resolves two revisions
by `created_at` at one-second resolution, and two transitions in the same second
would otherwise produce a head that loses to its own predecessor. Tab open and
tab grant will routinely land in the same second, so this table needs the same
device.

- [ ] **Step 2: Write the migration**

```sql
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
```

Confirm the `channels` FK target matches that table's real primary key before
committing; if it differs, follow what `0044_jobs.sql` does for its channel
reference and report the difference.

- [ ] **Step 3: Mirror it into `schema/schema.sql`**

Add the same table and indexes. Provisioned installs can skip embedded
migrations, so a table that exists only in `migrations/` is missing in
production.

- [ ] **Step 4: Verify**

Run: `just test`

Expected: migrations apply cleanly on a fresh database, no regressions. If
`pgschema` complains on a re-run, use the isolated harness rather than a reused
database.

- [ ] **Step 5: Commit**

```bash
git add migrations/0056_workspace_tabs.sql schema/schema.sql
git commit -s -m "feat(workspace): canonical tab ownership state"
```

---

## Task 2: The compare-and-swap

The whole arbitration, in two queries. Everything else is bookkeeping around them.

**Files:**
- Create: `crates/buzz-db/src/workspace_tabs.rs`
- Modify: `crates/buzz-db/src/lib.rs`

**Interfaces:**
- Consumes: Task 1's table.
- Produces: `struct WorkspaceTabRow { channel_id, tab_id, tab_kind, title, creator, owner, driver, revision, head_at }`,
  `open_tab(...) -> Result<Option<WorkspaceTabRow>>`,
  `get_tab(...) -> Result<Option<WorkspaceTabRow>>`,
  `set_driver(pool, community, channel, tab_id, expected_revision, new_driver, actor, now) -> Result<Option<WorkspaceTabRow>>`.

- [ ] **Step 1: Read the precedent**

Read `crates/buzz-db/src/jobs.rs:230-274` (`claim_job`) and `276-360`
(heartbeat fencing). `claim_job` is the shape to copy: a conditional
`UPDATE … WHERE … RETURNING`, where a losing caller matches no rows and gets
`Ok(None)`. Copy that idiom, including returning `Option` rather than an error
for a lost race, and how `head_at` is stamped strictly increasing (`jobs.rs:436-485`).

- [ ] **Step 2: Write the failing test**

**Where DB tests live.** `jobs.rs` has no test module and there is no
`crates/buzz-db/tests/` directory; DB-layer functions are exercised from
**`crates/buzz-relay/tests/*.rs`**. Copy the harness from
`crates/buzz-relay/tests/ask_broker.rs:24-40`: it resolves
`BUZZ_TEST_DATABASE_URL` / `DATABASE_URL` with a local default and calls
`buzz_db::migration::run_migrations_unless_provisioned(&pool)`. Use that
function, **not** `run_migrations` — the comment beside it explains that
replaying `0001` against a provisioned database aborts on `CREATE TYPE`.

So the implementation lands in `crates/buzz-db/src/workspace_tabs.rs` and the
tests in a new `crates/buzz-relay/tests/workspace_tabs.rs`.

```rust
#[tokio::test]
async fn two_racing_takes_produce_one_winner() {
    let (pool, community, channel) = fixture().await;
    let human = [1u8; 32];
    let agent_a = [2u8; 32];
    let agent_b = [3u8; 32];

    let tab = open_tab(&pool, community, channel, "tab-1", "scratchpad", "Notes", &human, 100)
        .await
        .unwrap()
        .expect("a fresh tab opens");
    assert_eq!(tab.revision, 1);
    assert_eq!(tab.driver, human.to_vec());

    // Both callers read revision 1 and both try to take the seat.
    let first = set_driver(&pool, community, channel, "tab-1", 1, &agent_a, &human, 101)
        .await
        .unwrap();
    let second = set_driver(&pool, community, channel, "tab-1", 1, &agent_b, &human, 102)
        .await
        .unwrap();

    assert!(first.is_some(), "the first transition wins");
    assert!(
        second.is_none(),
        "a transition against a stale revision must be a no-op, not a second winner"
    );
    let current = get_tab(&pool, community, channel, "tab-1").await.unwrap().unwrap();
    assert_eq!(current.driver, agent_a.to_vec());
    assert_eq!(current.revision, 2);
}

#[tokio::test]
async fn head_at_is_strictly_increasing_even_within_one_second() {
    let (pool, community, channel) = fixture().await;
    let human = [1u8; 32];
    let agent = [2u8; 32];
    let opened = open_tab(&pool, community, channel, "tab-1", "scratchpad", "Notes", &human, 100)
        .await
        .unwrap()
        .unwrap();
    // Same wall-clock second as the open.
    let taken = set_driver(&pool, community, channel, "tab-1", 1, &agent, &human, 100)
        .await
        .unwrap()
        .unwrap();
    assert!(
        taken.head_at > opened.head_at,
        "two transitions in one second must still order: {} vs {}",
        opened.head_at,
        taken.head_at
    );
}

#[tokio::test]
async fn opening_the_same_tab_twice_is_idempotent_not_a_hijack() {
    let (pool, community, channel) = fixture().await;
    let human = [1u8; 32];
    let stranger = [9u8; 32];
    open_tab(&pool, community, channel, "tab-1", "scratchpad", "Notes", &human, 100)
        .await
        .unwrap()
        .unwrap();
    // A second open of the same coordinate must NOT reset ownership: that would
    // be a free takeover for anyone who can guess a tab id.
    let again = open_tab(&pool, community, channel, "tab-1", "scratchpad", "Mine now", &stranger, 101)
        .await
        .unwrap();
    assert!(again.is_none(), "re-opening an existing tab must not succeed");
    let current = get_tab(&pool, community, channel, "tab-1").await.unwrap().unwrap();
    assert_eq!(current.creator, human.to_vec());
    assert_eq!(current.title, "Notes");
}

#[tokio::test]
async fn a_tab_in_another_channel_is_a_different_tab() {
    let (pool, community, channel_a) = fixture().await;
    let channel_b = second_channel(&pool, community).await;
    let human = [1u8; 32];
    open_tab(&pool, community, channel_a, "tab-1", "scratchpad", "A", &human, 100)
        .await
        .unwrap()
        .unwrap();
    let in_b = open_tab(&pool, community, channel_b, "tab-1", "scratchpad", "B", &human, 100)
        .await
        .unwrap();
    assert!(in_b.is_some(), "the same tab id in another channel is free");
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p buzz-db workspace_tabs`

Expected: FAIL, `cannot find function open_tab`.

- [ ] **Step 4: Write the implementation**

`set_driver` is the important one:

```rust
/// Move the driver seat, if the caller is looking at the current revision.
///
/// The whole arbitration is the `WHERE`: it matches only when the row is still
/// at the revision the caller read. Two racing transitions therefore produce
/// one winner and one `Ok(None)`, which is how a loser learns it lost. This is
/// `claim_job`'s idiom (buzz-db/src/jobs.rs:245) applied to a driver seat.
///
/// `head_at` is stamped strictly greater than the row's current value rather
/// than from the clock, because NIP-33 orders revisions by `created_at` at
/// one-second resolution and two transitions in the same second are ordinary
/// here.
pub async fn set_driver(
    pool: &PgPool,
    community: CommunityId,
    channel: Uuid,
    tab_id: &str,
    expected_revision: i64,
    new_driver: &[u8],
    now: i64,
) -> Result<Option<WorkspaceTabRow>> {
    let row = sqlx::query(
        "UPDATE workspace_tabs \
            SET driver = $5, \
                revision = revision + 1, \
                head_at = GREATEST($6, head_at + 1), \
                updated_at = $6 \
          WHERE community_id = $1 AND channel_id = $2 AND tab_id = $3 \
            AND revision = $4 \
      RETURNING channel_id, tab_id, tab_kind, title, creator, owner, driver, \
                revision, head_at, created_at, updated_at",
    )
    .bind(community.as_uuid())
    .bind(channel)
    .bind(tab_id)
    .bind(expected_revision)
    .bind(new_driver)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_tab).transpose()
}
```

`open_tab` inserts with `ON CONFLICT DO NOTHING` and returns `Ok(None)` when the
coordinate is taken, which is what makes a second open a no-op rather than a
hijack. `get_tab` is a plain select. Add `pub mod workspace_tabs;` to
`crates/buzz-db/src/lib.rs`.

Authorization is **not** in this layer: these functions do what they are told.
The broker decides who may tell them.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p buzz-db workspace_tabs`

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-db/src/workspace_tabs.rs crates/buzz-db/src/lib.rs
git commit -s -m "feat(workspace): compare-and-swap for the driver seat"
```

---

## Task 3: Kinds and action parsing

**Files:**
- Modify: `crates/buzz-core/src/kind.rs`
- Create: `crates/buzz-core/src/workspace_tab.rs`
- Modify: `crates/buzz-core/src/lib.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `KIND_WORKSPACE_TAB_ACTION: u32 = 44400`,
  `KIND_WORKSPACE_TAB_RECEIPT: u32 = 44401`,
  `KIND_WORKSPACE_TAB_HEAD: u32 = 30192`,
  `enum WorkspaceTabOp { Open { tab_kind, title }, Take, Grant { grantee }, Release }`,
  `struct WorkspaceTabAction { channel_id, tab_id, op, expected_revision: Option<i64>, actor }`,
  `parse_tab_action(&nostr::Event) -> Result<WorkspaceTabAction, WorkspaceTabError>`.

Stage 1 parses all four ops; the broker rejects `Grant` and `Release` until
Stage 2, so the wire format does not change under B2 later.

- [ ] **Step 1: Note the test helper**

There is **no** `crate::test_support::signed_event`. The real helpers are
`crate::test_helpers::make_event(kind)` and `make_event_with_keys(keys, kind)`
(`crates/buzz-core/src/lib.rs:78-104`), and neither takes tags or content.
Build events with `nostr::EventBuilder` + `Keys` in the test module, or extend
`test_helpers` with one clearly named addition. Say which you did.

The pinned crate is `nostr 0.44.7`, where `Tags::iter`, `Tag::as_slice() -> &[String]`
and `PublicKey::to_hex()` all exist and behave as expected. That part of v1 was
verified correct and can be reused.

- [ ] **Step 2: Write the failing test**

Cover, at minimum: a well-formed `open` action parses; an action whose `h` is
not a UUID is refused; an unknown `op` is refused; a `grant` naming the actor
itself is refused at parse time; a duplicate `tab` tag is refused rather than
first-wins; an oversized title is refused. Assert error variants, not strings.

Duplicate-tag rejection matters: v1's `first_tag` silently took the first of a
duplicate pair, which lets a crafted event show one thing to a validator and
another to a later reader.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p buzz-core workspace_tab`

Expected: FAIL, no such module.

- [ ] **Step 4: Implement**

Register the three kinds in `kind.rs`: the constants, `ALL_KINDS`, and the
classification lists. Decide each deliberately and write the reason in a
comment:

- The **action** is client-signed and channel-scoped.
- The **receipt** is relay-signed. If it should be private to the actor, it needs
  both a `p` tag and an entry in the right result-gate list, and you must confirm
  the owner can still read it if the design wants that; the generic rule requires
  **all** `p` values to equal the reader.
- The **head** is relay-signed and readable by channel members, narrowed for
  agents in Task 11.

Write `parse_tab_action` with exactly-one-tag enforcement and explicit length
bounds. Reject non-empty tag values that are not valid UUIDs for `h`.

- [ ] **Step 5: Run the test to verify it passes**

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-core/src/kind.rs crates/buzz-core/src/workspace_tab.rs \
        crates/buzz-core/src/lib.rs
git commit -s -m "feat(workspace): tab action kinds and parsing"
```

---

## Task 4: The broker

**Files:**
- Create: `crates/buzz-relay/src/workspace_tab_broker.rs`
- Modify: `crates/buzz-relay/src/lib.rs`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `apply_tab_action(state, tenant, action) -> Result<TabActionOutcome, String>`.

- [ ] **Step 1: Read the precedents**

- `crates/buzz-relay/src/job_broker.rs:73-90,214-251,344-429` — the closest small
  broker with relay-owned head publication and a handful of transitions.
- `crates/buzz-relay/src/company_broker.rs:96-186` with
  `crates/buzz-db/src/lib.rs:2626-2887` (`apply_company_action_once`) — the
  precedent for locking rows, checking an expected head, claiming idempotency,
  and writing action, head and receipt in **one transaction**.

Report which envelope you followed and why. `discovery_workspace_broker.rs` is
the same family but carries an 881-line domain model that does not apply here.

- [ ] **Step 2: Write the failing test**

Authorization is the point of this module, so test it directly:

- the creator may `Take` their own tab back;
- a bystander may not `Take` a tab they neither own nor drive;
- a stale `expected_revision` is refused as a conflict, not applied;
- a refusal for a tab that does not exist is **indistinguishable** from a refusal
  for a tab the caller may not touch (assert the two error strings are equal —
  this is the existence-oracle fix, and a test is the only thing that keeps it
  true as messages get edited);
- `Grant` and `Release` are refused in Stage 1 with a "not yet supported" error
  distinct from an authorization failure.

- [ ] **Step 3: Run the test to verify it fails**

- [ ] **Step 4: Implement**

`Open` inserts and, on conflict, returns the indistinguishable refusal. `Take`
requires the caller to be the row's `owner`, and passes the caller's
`expected_revision` to `set_driver`; `Ok(None)` from the CAS is a conflict, not
a success. Emit the receipt and the projected head inside the same transaction
as the row change.

**The head's `d` must be `{channel_id}:{tab_id}`**, not `tab_id`. The replaceable
index has no channel component, so a bare tab id collides across channels.

- [ ] **Step 5: Run the test to verify it passes**

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-relay/src/workspace_tab_broker.rs crates/buzz-relay/src/lib.rs
git commit -s -m "feat(workspace): transactional tab ownership broker"
```

---

## Task 5: Ingest wiring

The step v1 skipped entirely, which would have left every workspace event
refused at the door.

**Files:**
- Modify: `crates/buzz-relay/src/handlers/ingest.rs`

- [ ] **Step 1: Register the kinds in every registry**

1. `required_scope_for_kind` (`ingest.rs:430-592`) — an explicit allowlist;
   unmapped kinds are refused with `restricted: unknown event kind` (line 590).
2. `requires_h_channel_scope` (`ingest.rs:785-818`) — all three are channel-scoped.
3. The dispatcher, so an action reaches the broker. The real per-kind security
   branches are around `ingest.rs:2714-2807`; that is the shape to follow, not
   the discovery lines v1 cited (those are scope mapping, not authorization).

- [ ] **Step 2: Refuse what clients must not author**

Clients may submit **actions** only. A client-signed receipt or head must be
refused, otherwise the projection is forgeable and the whole design collapses
back into v1.

- [ ] **Step 3: Make the payload guarantee real**

Reject **non-empty `content`** on all three workspace kinds at ingest. Without
this, "payloads never cross the relay" is a property of a parser, not of the
relay: the event is stored and fanned out whole.

- [ ] **Step 4: Write the tests**

Through the real ingest boundary, not a `kind.rs` unit test: an action with a
UUID `h` is accepted; a client-signed head is refused; a client-signed receipt
is refused; an action with non-empty content is refused; an action with a
non-UUID `h` is refused.

- [ ] **Step 5: Run and commit**

```bash
just test
git add crates/buzz-relay/src/handlers/ingest.rs
git commit -s -m "feat(workspace): register and gate workspace kinds at ingest"
```

---

## Task 6: `buzz workspace tabs` CLI (open, take, list)

**Files:**
- Create: `crates/buzz-cli/src/commands/workspace.rs`
- Modify: `crates/buzz-cli/src/commands/mod.rs`, `crates/buzz-cli/src/lib.rs`

The command enum and dispatch are in **`lib.rs`** (around lines 189-300 and
2907-2938), not `main.rs`, which is only a thin `run_from_args` entrypoint.

The error variant is **`CliError::Usage(String)`** (`crates/buzz-cli/src/error.rs:3-45`).
There is no `CliError::Input`.

- [ ] **Step 1: Read `crates/buzz-cli/src/commands/grants.rs`** for the
  build-sign-submit shape and its conflict handling. Exit codes: 0 ok, 1 input,
  2 network/relay, 3 auth, 4 other, 5 write conflict. A lost CAS race is **exit 5**,
  and the message must say so plainly rather than looking like a crash.

- [ ] **Step 2: Write the failing test** for the pure input validation
  (`--channel` must parse as a UUID; `--tab` must be non-empty), asserting
  `CliError::Usage`.

- [ ] **Step 3: Run it, watch it fail, implement, watch it pass.**

- [ ] **Step 4: Commit**

```bash
git add crates/buzz-cli/src/commands/workspace.rs crates/buzz-cli/src/commands/mod.rs \
        crates/buzz-cli/src/lib.rs
git commit -s -m "feat(workspace): buzz workspace tabs open, take, list"
```

---

## Task 7: Live proof, races included

**Files:**
- Create: `crates/buzz-test-client/tests/e2e_workspace_tabs.rs`

**There is no `TestContext` in `buzz-test-client`.** `tests/common/mod.rs:18-148`
has `relay_http_url`, a DB fixture, `submit`, NIP-98 helpers, `query` and
`tag_value`; `src/lib.rs:83-180` has the low-level `BuzzTestClient`. Existing
E2E setup is manual (`e2e_relay.rs`, `e2e_interrupts.rs`). Building fixtures is
part of this task, not a given.

- [ ] **Step 1: Read `e2e_relay.rs` and `e2e_interrupts.rs`** and copy their
  setup. Channels must be real UUIDs.

- [ ] **Step 2: Write the failing tests**

1. A human opens a tab; the projected head appears with the human as owner and driver.
2. A bystander's `take` is refused.
3. The owner's `take` succeeds and bumps the revision.
4. **Two concurrent takes with the same expected revision: exactly one succeeds.**
   This is the test the whole redesign exists for. Submit both before either
   completes; assert one 5-class conflict and one success, and that the row's
   driver is the winner's.
5. A client-signed head is refused.
6. An action with non-empty content is refused.

- [ ] **Step 3: Run, fix, and re-run until green.** `just test`.

- [ ] **Step 4: Commit**

```bash
git add crates/buzz-test-client/tests/e2e_workspace_tabs.rs
git commit -s -m "test(workspace): live ownership handover and race proof"
```

---

## Task 8: Stage 1 gate and PR

- [ ] `just ci` and `just test`, both green.
- [ ] PR against `develop` with `--auto`, every `gh` call carrying
      `--repo AI-Native-Ventures/Colony`.
- [ ] The PR body states plainly that this is Stage 1: open and take back, no
      grants, no agent read scope, and nothing in the desktop app reads it yet.

**Stop here and get Stage 1 reviewed before starting Task 9.**

---

# Stage 2: grant and read scope

## Task 9: Grant and release

Extends the broker with the two remaining ops. A `Grant` requires the caller to
be the row's owner or current driver, refuses a self-grant, and moves the seat
by the same CAS. A `Release` returns the seat to the owner.

Tests mirror Task 4's, plus: a grant from a bystander is refused
indistinguishably from a grant for a nonexistent tab; two concurrent grants
produce one winner; a grant to the caller itself is refused.

## Task 10: Agent read scope

An agent may read a tab head only when it is the row's `owner` or `driver`.
Humans see every tab in their channel.

- [ ] **Step 1: Decide agent-ness.** `interrupt_gate::agent_tier` is
  `(&TenantContext, &AppState, &PublicKey) -> Result<Option<AgentTier>, String>`
  (`interrupt_gate.rs:143-147`). `None` means human or unmanaged. **Fail closed
  on the `Result`.** A test "agent" must be a real employee or managed-agent
  head, not a random key, or it is treated as a human and the test proves nothing.

- [ ] **Step 2: Wire one predicate into every surface.** v1 named two files and
  missed seven. The full set:
  - REQ historical: `handlers/req.rs:373-411`, `690-724`
  - local live fan-out: `handlers/event.rs:115-221`, called at `224-247`
  - Redis fan-out: `event.rs:280-307`
  - persistent ingest fan-out: `event.rs:429-439`
  - HTTP query: `api/bridge.rs:1307-1320`
  - HTTP count: `bridge.rs:1525-1535`, `1595-1605`
  - HTTP search: `bridge.rs:1774-1785`
  - WS count: `handlers/count.rs:201-209`, `274-281`

  `filter_fanout_by_access` does not receive the `TenantContext`/`PublicKey`
  shape `agent_tier` needs, so this requires a deliberate signature change.
  Report what you changed.

- [ ] **Step 3: Push the predicate into SQL, or overfetch deliberately.**
  Filtering after a `LIMIT` (`req.rs:943-989` builds a bounded query, visibility
  applies at `373-394`) returns a short or empty page even when visible tabs
  exist. State which you chose.

- [ ] **Step 4: Prove it live.** Two agents in a channel, one tab granted to the
  first: the bystander's query returns empty **without a refusal**, the human's
  returns everything, and taking the tab back ends the grantee's visibility.
  Cover the bypasses v1 missed: explicit-kind `ids`, kindless `ids`,
  channel-scoped REQ, HTTP `/query`, and live delivery.

## Task 11: NIP-WS

Document the three kinds, the four ops, the CAS and revision semantics, the
projection-not-state relationship, the read scope, and **what is deliberately
not covered**: pausing, ref invalidation, the thread record, and agent-created
tab payload transport. Match `docs/nips/NIP-IQ.md`'s structure.

Stage `AGENTS.md`, never `CLAUDE.md`: it is a symlink and staging it is a no-op.

## Task 12: Stage 2 gate and PR

Same gate as Task 8.

---

## Self-review

**What the spec asks and where it lands.** One driver at a time: the `driver`
column plus the CAS, Task 2, proven by the race test in Task 7. Drivers are the
human and one agent: same column. An agent drives only what it was granted: the
broker, Tasks 4 and 9. An agent sees only what it owns or drives: Task 10.
Granting hands control over and is recorded: Task 9 plus the receipt. Multiple
agents never drive the same tab: one row, one conditional update.

**What the spec asks and this plan does NOT deliver**, listed in "Out of scope"
and repeated here so no self-review claims otherwise: pausing the previous
driver's turn, invalidating its pending refs, explicit continuation, recording
the takeover **in the thread**, and any path by which an agent-created tab
becomes visible and usable on a human's screen.

**Type consistency.** `WorkspaceTabRow`'s columns are identical in Tasks 1, 2
and 4. `WorkspaceTabOp`'s four variants are parsed in Task 3, rejected in Task 4
for the two Stage 2 ops, and accepted in Task 9. `set_driver`'s
`expected_revision` parameter is the same value the broker reads from the row
and the CLI surfaces as exit code 5.
