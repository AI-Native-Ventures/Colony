# Interrupt Core (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay-side interrupt system from the spec `docs/superpowers/specs/2026-08-04-colony-interrupt-hierarchy-design.md`: typed Ask events, relay-enforced agent tiers, dedupe, relay timers (auto-promotion, default-on-timeout, stalls), and CLI verbs so agents can raise/escalate/file and tests can answer.

**Architecture:** One event primitive (`KIND_ASK`) used at three altitudes (worker→leader raise, leader→executive escalation, executive→owner filing), mirroring the existing company-broker pattern: an ingest candidate-gate routes agent-signed Ask events to a broker that validates tier rules and dedupe, stores a Postgres projection, and the relay's interval scheduler sweeps that projection for promotions, default executions, and stalls, emitting relay-signed events. Tier lives in the owner-authored managed-agent head (kind 30177). Contact enforcement (workers/leaders cannot address owners) is a new ingest gate on message/DM kinds.

**Tech Stack:** Rust (relay: axum/tokio/sqlx-style buzz-db, nostr crate), Postgres migrations, buzz-cli (clap), buzz-test-client integration tests.

**Out of scope (Plan 2 and 3):** Open Issues desktop/mobile UI, mention-autocomplete hiding, push notification wiring, credential vault, cost imputation, daily report. Plan 1 must leave the relay fully functional for chat as-is.

## Global Constraints

- No `unsafe`. No new `unwrap()`/`expect()` in production paths; use `?` and error types (CLAUDE.md).
- New public API needs doc comments (CLAUDE.md).
- All new kind integers go in `crates/buzz-core/src/kind.rs` first, added to `ALL_KINDS`, with compile-time range asserts (repo convention).
- Channel scoping uses `h` tags; relay queries must always specify `kinds` (CLAUDE.md gotchas 1-2).
- Commit with `git commit -s` (DCO) plus the session trailers used in this session.
- Run `just ci` before any PR; integration tests (`just test`) require Postgres + Redis running (`just setup` environment).
- Tier vocabulary is exactly: `executive`, `leader`, `worker` (spec). Ask types exactly: `decision`, `question`, `credential`, `blocker`, `stall` (stall is relay-only).
- Hard list categories exactly: `spend`, `external_send`, `hiring`, `legal`, `pricing`, `deletion`, `vendor` (spec: no default-on-timeout on these).
- Default timeout window: company-level setting, initial 3600 seconds (spec).
- No em-dashes in any user-facing string.

## Kind number allocation (Task 1 locks these)

| Constant | Value | Authoring |
|---|---|---|
| `KIND_ASK` | 44300 | agent-signed (or relay-signed for promotions/stalls) |
| `KIND_ASK_RESOLUTION` | 44301 | audience-signed (or relay-signed for default execution) |
| `KIND_ASK_WITHDRAWAL` | 44302 | executive-signed |
| `KIND_DECISION_LOG` | 44303 | leader/executive-signed autonomy trail |
| `KIND_DELEGATION_GRANT` | 30188 | owner-signed NIP-33 head, `d` = grant id |

44300-44303 sit in the free space after `KIND_USAGE_RECORD` (44210); 30188 follows the ledger heads (30184-30187). Verify both are absent from `kind.rs` before committing Task 1 (`grep -n "44300\|30188" crates/buzz-core/src/kind.rs` must return nothing).

## File Structure

- `crates/buzz-core/src/kind.rs`, new kind constants (modify)
- `crates/buzz-core/src/interrupt.rs`, Ask/Resolution/Grant parsing, tier enum, validation (create; one responsibility: pure event <-> struct logic, no IO)
- `crates/buzz-core/src/lib.rs`, export `interrupt` module (modify)
- `migrations/0042_interrupt_asks.sql`, asks projection table (create)
- `crates/buzz-db/src/asks.rs`, projection reads/writes (create)
- `crates/buzz-db/src/lib.rs`, module wiring + method surface (modify)
- `crates/buzz-relay/src/ask_broker.rs`, validate + store + receipt Ask lifecycle events (create)
- `crates/buzz-relay/src/interrupt_gate.rs`, tier lookup + owner-contact enforcement on message/DM kinds (create)
- `crates/buzz-relay/src/interrupt_runtime.rs`, interval sweep: promotions, defaults, stalls (create)
- `crates/buzz-relay/src/handlers/ingest.rs`, route candidates to broker + call gate (modify)
- `crates/buzz-relay/src/main.rs`, spawn the sweep task (modify, mirror the reminder scheduler at ~line 783)
- `crates/buzz-relay/src/lib.rs`, module exports (modify)
- `crates/buzz-cli/src/commands/asks.rs`, `buzz asks ...` verbs (create)
- `crates/buzz-cli/src/commands/mod.rs`, `main.rs`, `client.rs`, wire subcommand (modify)
- `crates/buzz-test-client/tests/e2e_interrupts.rs`, end-to-end chain proof (create)
- `docs/nips/NIP-IQ.md`, protocol doc for the Ask kinds (create)

---

### Task 1: Kind constants and the interrupt module skeleton

**Files:**
- Modify: `crates/buzz-core/src/kind.rs`
- Create: `crates/buzz-core/src/interrupt.rs`
- Modify: `crates/buzz-core/src/lib.rs`

**Interfaces:**
- Produces: `KIND_ASK`, `KIND_ASK_RESOLUTION`, `KIND_ASK_WITHDRAWAL`, `KIND_DECISION_LOG`, `KIND_DELEGATION_GRANT` (u32 consts); `interrupt::AskType`, `interrupt::AgentTier` enums with `as_str()`/`parse()`; `interrupt::HARD_LIST_CATEGORIES: &[&str]`.

- [ ] **Step 1: Write the failing unit tests** in `crates/buzz-core/src/interrupt.rs` (bottom `#[cfg(test)]`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_type_round_trips() {
        for (s, t) in [
            ("decision", AskType::Decision),
            ("question", AskType::Question),
            ("credential", AskType::Credential),
            ("blocker", AskType::Blocker),
            ("stall", AskType::Stall),
        ] {
            assert_eq!(AskType::parse(s), Some(t));
            assert_eq!(t.as_str(), s);
        }
        assert_eq!(AskType::parse("prose"), None);
    }

    #[test]
    fn tier_round_trips_and_orders() {
        assert_eq!(AgentTier::parse("worker"), Some(AgentTier::Worker));
        assert_eq!(AgentTier::parse("leader"), Some(AgentTier::Leader));
        assert_eq!(AgentTier::parse("executive"), Some(AgentTier::Executive));
        assert_eq!(AgentTier::parse("owner"), None); // humans are not agent tiers
        assert!(AgentTier::Worker.escalation_target() == AgentTier::Leader);
        assert!(AgentTier::Leader.escalation_target() == AgentTier::Executive);
    }

    #[test]
    fn hard_list_is_exact() {
        assert_eq!(
            HARD_LIST_CATEGORIES,
            &["spend", "external_send", "hiring", "legal", "pricing", "deletion", "vendor"]
        );
        assert!(is_hard_list_category("spend"));
        assert!(!is_hard_list_category("copy_change"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-core interrupt 2>&1 | tail -5`
Expected: compile error, module `interrupt` does not exist.

- [ ] **Step 3: Implement.** In `kind.rs` (near `KIND_USAGE_RECORD`, keeping the numeric grouping comment style), add the five constants with doc comments describing authoring rules; append all five to `ALL_KINDS`; add compile-time asserts (`!is_ephemeral(KIND_ASK)`, `!is_replaceable(KIND_ASK)`, `is_parameterized_replaceable(KIND_DELEGATION_GRANT)`, `KIND_ASK <= u16::MAX as u32`). Then create `interrupt.rs`:

```rust
//! Colony interrupt primitives: typed Asks, agent tiers, delegation policy.
//!
//! Pure event/tag/JSON logic only. No IO. See docs/nips/NIP-IQ.md.

/// Escalation categories that must always reach a human owner and may never
/// carry a default-on-timeout (spec: the hard list).
pub const HARD_LIST_CATEGORIES: &[&str] =
    &["spend", "external_send", "hiring", "legal", "pricing", "deletion", "vendor"];

/// Returns `true` if `category` is on the immutable hard list.
pub fn is_hard_list_category(category: &str) -> bool {
    HARD_LIST_CATEGORIES.contains(&category)
}

/// The type of a Colony Ask event (tag `ask-type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskType {
    /// Pick an option; each option states its exact external effect.
    Decision,
    /// Something only the audience knows.
    Question,
    /// A key or account secret; payload never carries the secret itself.
    Credential,
    /// A real-world action only a human owner can perform.
    Blocker,
    /// Relay-generated: a task went event-silent (crashed or hung agent).
    Stall,
}

impl AskType {
    /// Canonical tag value.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Decision => "decision",
            Self::Question => "question",
            Self::Credential => "credential",
            Self::Blocker => "blocker",
            Self::Stall => "stall",
        }
    }
    /// Parse a tag value; `None` for anything not in the pinned vocabulary.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "decision" => Some(Self::Decision),
            "question" => Some(Self::Question),
            "credential" => Some(Self::Credential),
            "blocker" => Some(Self::Blocker),
            "stall" => Some(Self::Stall),
            _ => None,
        }
    }
    /// Credential and blocker asks forward mechanically (spec: fast path).
    pub fn is_fast_path(&self) -> bool {
        matches!(self, Self::Credential | Self::Blocker)
    }
}

/// An agent's rank in the interrupt hierarchy (managed-agent head field `tier`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTier {
    /// Produces work; raises to its own leader; may never address owners.
    Worker,
    /// Runs a team; escalates to the executive; may never address owners.
    Leader,
    /// Chief of Staff: the only agent that may address owners.
    Executive,
}

impl AgentTier {
    /// Canonical string, matching the managed-agent head JSON field.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Worker => "worker",
            Self::Leader => "leader",
            Self::Executive => "executive",
        }
    }
    /// Parse the head field; `None` for unknown values (fail closed as worker
    /// is the CALLER's decision, not this parser's).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "worker" => Some(Self::Worker),
            "leader" => Some(Self::Leader),
            "executive" => Some(Self::Executive),
            _ => None,
        }
    }
    /// The tier an unhandled ask at this altitude promotes toward.
    pub fn escalation_target(&self) -> Self {
        match self {
            Self::Worker => Self::Leader,
            Self::Leader => Self::Executive,
            Self::Executive => Self::Executive,
        }
    }
}
```

Add `pub mod interrupt;` to `crates/buzz-core/src/lib.rs` beside the existing module list.

- [ ] **Step 4: Run tests**

Run: `cargo test -p buzz-core interrupt 2>&1 | tail -5` and `cargo test -p buzz-core kind 2>&1 | tail -5`
Expected: PASS (including the existing duplicate-kind registry test picking up the new constants).

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/kind.rs crates/buzz-core/src/interrupt.rs crates/buzz-core/src/lib.rs
git commit -s -m "feat(core): interrupt kinds, ask types, agent tiers"
```

---

### Task 2: Ask event parsing and validation (pure logic)

**Files:**
- Modify: `crates/buzz-core/src/interrupt.rs`

**Interfaces:**
- Consumes: Task 1 enums.
- Produces: `interrupt::ParsedAsk { ask_type: AskType, audience_hex: String, initiative_id: String, task_ids: Vec<String>, origin_thread_hex: Option<String>, need_key: String, prior_ask_hex: Option<String>, category: Option<String>, cost_of_delay: String, default_option: Option<String>, default_window_secs: Option<u64>, headline: String }`; `interrupt::parse_ask(event: &nostr::Event) -> Result<ParsedAsk, AskParseError>`; `interrupt::AskParseError` (thiserror-style enum with `Display`). Also `parse_resolution(event) -> Result<ParsedResolution, AskParseError>` where `ParsedResolution { ask_event_hex: String, answer: serde_json::Value, default_executed: bool }`, and `parse_withdrawal(event) -> Result<ParsedWithdrawal, AskParseError>` where `ParsedWithdrawal { ask_event_hex: String, reason: String }`.

Ask event shape (this task pins it; document in the doc comment):
- kind 44300, regular stored event
- tags: exactly one `["ask-type", <vocab>]`; exactly one `["p", <audience hex>]`; exactly one `["initiative", <id>]`; one or more `["task", <id>]`; exactly one `["need", <slug>]` (dedupe key, `[a-z0-9-]{1,64}`); optional one `["e", <origin thread root hex>]`; optional one `["prior", <ask event hex>]` (escalation chain); optional one `["category", <slug>]`; optional one `["h", <channel uuid>]` (present on raises so the team channel sees them)
- content: JSON `{"headline": "...", "cost_of_delay": "...", "options": [{"label","consequence","recommended"?}], "default_option"?: "...", "default_window_secs"?: 3600, ...}` with `headline` and `cost_of_delay` required and non-empty.

Validation rules to enforce in `parse_ask` (each gets its own test):
1. Wrong tag cardinality (zero or two `ask-type`/`p`/`initiative`/`need` tags) is an error.
2. Empty `headline` or `cost_of_delay` is an error (schema-enforced filing; prose cannot slip through as empty structure).
3. `default_option` present while `category` is on the hard list is an error (`AskParseError::DefaultOnHardList`).
4. `default_option` present requires `options` to contain a matching `label`.
5. `ask_type` = `stall` never carries `default_option`.
6. Hex fields must be 64 lowercase hex chars (reuse the `validate_hex64` idiom from `buzz-cli/src/validate.rs` as a local helper).

- [ ] **Step 1: Write the failing tests.** Build events with `nostr::EventBuilder` in tests (mirror how existing buzz-core tests construct events; see `persona_event_is_shared` tests in `kind.rs` for the tag-construction idiom). One test per rule above, plus one happy-path test asserting every `ParsedAsk` field.

```rust
#[test]
fn parse_ask_happy_path_extracts_all_fields() {
    let keys = nostr::Keys::generate();
    let content = r#"{"headline":"Choose batch size","cost_of_delay":"47 leads wait","options":[{"label":"A","consequence":"sends 47 emails"},{"label":"B","consequence":"sends 15 emails","recommended":true}],"default_option":"B","default_window_secs":3600}"#;
    let event = nostr::EventBuilder::new(nostr::Kind::Custom(44300), content)
        .tags([
            nostr::Tag::custom(nostr::TagKind::custom("ask-type"), ["decision"]),
            nostr::Tag::custom(nostr::TagKind::custom("initiative"), ["init-1"]),
            nostr::Tag::custom(nostr::TagKind::custom("need", ), ["batch-size"]),
            nostr::Tag::custom(nostr::TagKind::custom("task"), ["task-9"]),
            nostr::Tag::custom(nostr::TagKind::custom("category"), ["outreach_pacing"]),
            nostr::Tag::public_key(keys.public_key()),
        ])
        .sign_with_keys(&keys)
        .expect("sign");
    let ask = parse_ask(&event).expect("parse");
    assert_eq!(ask.ask_type, AskType::Decision);
    assert_eq!(ask.initiative_id, "init-1");
    assert_eq!(ask.need_key, "batch-size");
    assert_eq!(ask.task_ids, vec!["task-9".to_string()]);
    assert_eq!(ask.default_option.as_deref(), Some("B"));
    assert_eq!(ask.default_window_secs, Some(3600));
}

#[test]
fn parse_ask_rejects_default_on_hard_list() {
    // same construction but category=spend + default_option present
    // assert matches AskParseError::DefaultOnHardList
}
```

(Write the remaining five rule tests with real constructions; the `expect` calls are test-only, allowed.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-core interrupt 2>&1 | tail -8`
Expected: FAIL, `parse_ask` not found.

- [ ] **Step 3: Implement** `ParsedAsk`, `AskParseError` (derive `Debug`, implement `std::fmt::Display` + `std::error::Error` manually or with the crate's existing error style; check `crates/buzz-core/src/block.rs` for the established error pattern and copy it), and the three parse functions. Iterate tags with the `tag.as_slice()` idiom from `persona_event_is_shared` in `kind.rs`. Content JSON via `serde_json::from_str::<serde_json::Value>` and explicit field extraction; do not `unwrap`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p buzz-core interrupt 2>&1 | tail -5`
Expected: PASS, all rules covered.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/interrupt.rs
git commit -s -m "feat(core): ask event parsing with schema-enforced filing rules"
```

---

### Task 3: Asks projection table and buzz-db module

**Files:**
- Create: `migrations/0042_interrupt_asks.sql`
- Create: `crates/buzz-db/src/asks.rs`
- Modify: `crates/buzz-db/src/lib.rs`

**Interfaces:**
- Consumes: nothing from other tasks (pure DB layer).
- Produces (methods on the existing `Db` type, following the style of neighboring modules like `relay_members.rs`):
  - `insert_ask(&self, community: &str, row: NewAskRow<'_>) -> Result<(), DbError>` where `NewAskRow { ask_event_id: &[u8], ask_type: &str, initiative_id: &str, need_key: &str, audience_pubkey: &[u8], filer_pubkey: &[u8], origin_thread: Option<&[u8]>, prior_ask: Option<&[u8]>, category: Option<&str>, default_option: Option<&str>, deadline_at: Option<i64> }`
  - `find_open_ask_by_need(&self, community: &str, initiative_id: &str, need_key: &str) -> Result<Option<AskRow>, DbError>`
  - `resolve_ask(&self, community: &str, ask_event_id: &[u8], resolution_event_id: &[u8], resolved_by: &[u8], default_executed: bool) -> Result<bool, DbError>` (returns false when no open row matched)
  - `withdraw_ask(&self, community: &str, ask_event_id: &[u8], withdrawal_event_id: &[u8]) -> Result<bool, DbError>`
  - `mark_ask_promoted(&self, community: &str, ask_event_id: &[u8], promoted_to_event_id: &[u8]) -> Result<bool, DbError>`
  - `query_due_asks(&self, now_secs: i64, limit: i64) -> Result<Vec<AskRow>, DbError>` (open + `deadline_at <= now`, across tenants, mirroring `query_due_reminders`)
  - `AskRow` mirrors the columns; status is a `TEXT CHECK` column: `open | resolved | withdrawn | promoted`.

Migration (auto-applied on relay startup per repo convention; copy the header comment style of `migrations/0041_discovery_trials.sql`):

```sql
-- 0042: interrupt asks projection.
-- One row per open Ask event; the relay's interrupt sweep and the future
-- Open Issues surface read this instead of scanning events.
CREATE TABLE IF NOT EXISTS asks (
    community        TEXT NOT NULL,
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
    PRIMARY KEY (community, ask_event_id)
);
-- Dedupe: at most one OPEN ask per (community, initiative, need).
CREATE UNIQUE INDEX IF NOT EXISTS asks_open_need_uniq
    ON asks (community, initiative_id, need_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS asks_due_idx ON asks (deadline_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS asks_audience_idx ON asks (community, audience_pubkey) WHERE status = 'open';
```

- [ ] **Step 1: Write the failing integration test.** Find how buzz-db integration tests get a test database (look at an existing test in `crates/buzz-db` or the callers in `crates/buzz-relay/tests/`; follow that harness exactly). Test: insert an ask, `find_open_ask_by_need` returns it, second insert with same (initiative, need) errors with the unique violation, `resolve_ask` flips it and `find_open_ask_by_need` then returns `None`, `query_due_asks` returns rows whose deadline passed and not others.
- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-db asks 2>&1 | tail -5` (requires `just setup` infra running)
Expected: FAIL, module missing.

- [ ] **Step 3: Implement** the migration file and `asks.rs` with the methods above, following the query style of `relay_members.rs` (same error type, same `community` scoping discipline). `updated_at` set on every mutation.
- [ ] **Step 4: Run tests**

Run: `cargo test -p buzz-db asks 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/0042_interrupt_asks.sql crates/buzz-db/src/asks.rs crates/buzz-db/src/lib.rs
git commit -s -m "feat(db): asks projection with open-need dedupe and due-sweep query"
```

---

### Task 4: Tier lookup and owner-contact gate

**Files:**
- Create: `crates/buzz-relay/src/interrupt_gate.rs`
- Modify: `crates/buzz-relay/src/lib.rs` (export module)
- Modify: `crates/buzz-relay/src/handlers/ingest.rs` (call the gate)
- Test: `crates/buzz-relay/tests/interrupt_gate.rs`

**Interfaces:**
- Consumes: `buzz_core::interrupt::AgentTier`, `MemberRole` (via `state.db` membership reads), managed-agent heads (kind 30177).
- Produces:
  - `interrupt_gate::agent_tier(tenant, state, pubkey: &nostr::PublicKey) -> Result<Option<AgentTier>, String>` reads the latest kind 30177 head whose `d` tag equals the pubkey hex and parses the content JSON field `"tier"`. `None` when the pubkey has no managed-agent head (humans, unmanaged agents) or the field is absent.
  - `interrupt_gate::enforce_owner_contact(tenant, state, event: &nostr::Event) -> Result<(), String>` returning `Err(reason)` when the event must be rejected.

Enforcement rules (spec: tiers):
1. Applies to kinds 9, 40002, 40003 (stream messages) and 41010 (`KIND_DM_OPEN`).
2. Look up the signer's tier. `None` (human or unmanaged) → allow, return `Ok(())`.
3. Signer is `Executive` → allow.
4. Signer is `Worker` or `Leader`: collect the event's `p`-tag pubkeys (and for 41010, all participant `p` tags). For each, check community membership role via the existing relay-members read (the same lookup `relay_admin.rs` uses); if any target has `MemberRole::Owner`:
   - For 41010: reject (`"restricted: <tier> agents cannot open a DM with an owner"`).
   - For message kinds: allow only the reply exemption, the event carries an `e` tag whose referenced thread-root event exists and satisfies either (a) root author is that owner, or (b) any stored event in the thread authored by that owner carries a `p` tag of the signer. Implement the lookup as `owner_thread_permits(tenant, state, thread_root: &[u8], owner: &[u8], agent: &[u8]) -> Result<bool, String>` using existing event queries in buzz-db (`get_event_by_id` and a thread query; find the thread-reply query used by the reply-count maintenance path and reuse it). Otherwise reject (`"restricted: <tier> agents cannot address an owner"`).
5. Fail closed on DB errors (mirror the ban-check comment at `ingest.rs:1741`).

Wire into `ingest.rs` immediately after the ban/timeout write-block (after line ~1749), before the company-action candidate check, guarded to the four kinds so ordinary traffic pays one tier lookup only on p-tagged messages (skip the whole gate when the event has no `p` tags).

- [ ] **Step 1: Write failing integration tests** in `crates/buzz-relay/tests/interrupt_gate.rs` (mirror the harness of `crates/buzz-relay/tests/block_attention_feed.rs`, which already boots tenant + state):
  - worker sends kind 9 p-tagging owner in a fresh thread → rejected with `restricted:`
  - worker replies inside a thread whose root the owner authored, p-tagging owner → accepted
  - worker opens DM (41010) with owner → rejected
  - leader p-tags owner → rejected; executive p-tags owner → accepted
  - human member p-tags owner → accepted (no tier head)
- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-relay --test interrupt_gate 2>&1 | tail -8`
Expected: FAIL (module missing / gate not wired).

- [ ] **Step 3: Implement** `interrupt_gate.rs` and the `ingest.rs` wiring per the rules above. Tier head read: query stored events `kinds=[30177]` with `d` = pubkey hex scoped to the tenant (there is an existing parameterized-head read used by persona sync; reuse the same DB call rather than writing a new SQL path).
- [ ] **Step 4: Run tests**

Run: `cargo test -p buzz-relay --test interrupt_gate 2>&1 | tail -5`, then `cargo test -p buzz-relay 2>&1 | tail -5` (no regressions in other relay tests).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/interrupt_gate.rs crates/buzz-relay/src/lib.rs crates/buzz-relay/src/handlers/ingest.rs crates/buzz-relay/tests/interrupt_gate.rs
git commit -s -m "feat(relay): tier-enforced owner-contact gate on messages and DMs"
```

---

### Task 5: Ask broker (filing, altitude rules, dedupe)

**Files:**
- Create: `crates/buzz-relay/src/ask_broker.rs`
- Modify: `crates/buzz-relay/src/lib.rs`, `crates/buzz-relay/src/handlers/ingest.rs`
- Test: `crates/buzz-relay/tests/ask_broker.rs`

**Interfaces:**
- Consumes: `interrupt::parse_ask` (Task 2), `interrupt_gate::agent_tier` (Task 4), `Db::insert_ask`/`find_open_ask_by_need` (Task 3).
- Produces:
  - `ask_broker::is_ask_candidate(event: &nostr::Event) -> bool` (kind is 44300/44301/44302)
  - `ask_broker::handle_ask_event(tenant, state, event) -> Result<AskBrokerOutcome, String>` with `enum AskBrokerOutcome { Applied, Duplicate { original_ask_event_id: [u8; 32] }, Refused { message: String } }` (mirror `CompanyBrokerOutcome` naming exactly).
  - Ingest wiring identical in shape to the company-broker branch at `ingest.rs:1754-1787` (Applied → accepted, Duplicate → `duplicate:` message with original id, Refused → `conflict:`).

Broker rules for kind 44300 (each is a test):
1. Parse via `parse_ask`; parse errors → `Refused`.
2. Altitude check: signer tier `Worker` → audience must have tier `Leader`; `Leader` → audience tier `Executive`; `Executive` → audience must hold `MemberRole::Owner`. Relay-signed asks (signer == relay pubkey) bypass. Signer with no tier (human) → `Refused` ("owners answer asks; they do not file them" for owner-audience asks from non-executive agents; humans never need to file).
3. Dedupe: `find_open_ask_by_need` hit → `Duplicate` with the original id (spec: five agents, one key, one ask).
4. Deadline: `deadline_at = created_at + default_window_secs` where `default_window_secs` comes from the ask content when present, else the company default. Read the company default from the company profile head (kind 30179) content field `"ask_window_secs"`, falling back to 3600 when absent. Implement as `fn company_ask_window_secs(tenant, state) -> u64` in the broker.
5. On accept: `insert_ask` row, store the event normally (return control to the standard storage path the way company actions do NOT, unlike company actions, ask events ARE stored as regular events so channels and future UI can subscribe; follow the storage path used for regular stored kinds).
6. Kind 44301 (resolution): signer must be the ask's audience (or an owner for owner-audience asks, or the relay). `resolve_ask`; unknown/closed ask → `Refused`. Applied resolutions with an `origin_thread` cause a relay-signed kind 9 receipt message into that thread's channel (`h` tag from the origin thread root's stored event) with content `"Ask resolved: <headline>"` p-tagging the blocked agent(s) = the filer, so the waiting agent wakes (spec: consumed state). Mirror how relay-signed system messages are emitted elsewhere (`KIND_SYSTEM_MESSAGE` senders in the codebase; grep `KIND_SYSTEM_MESSAGE` for the builder used).
7. Kind 44302 (withdrawal): signer tier must be `Executive` (or relay); `withdraw_ask`; emits the same style of in-thread receipt ("Ask withdrawn: <reason>").

- [ ] **Step 1: Write failing integration tests** covering rules 1-7 (one test each) in `crates/buzz-relay/tests/ask_broker.rs`, using the same harness as Task 4's test file. Seed managed-agent heads (30177) for a worker, leader, executive with `tier` fields, and an owner member.
- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-relay --test ask_broker 2>&1 | tail -8`
Expected: FAIL.

- [ ] **Step 3: Implement** the broker + ingest wiring.
- [ ] **Step 4: Run tests**

Run: `cargo test -p buzz-relay --test ask_broker 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/ask_broker.rs crates/buzz-relay/src/lib.rs crates/buzz-relay/src/handlers/ingest.rs crates/buzz-relay/tests/ask_broker.rs
git commit -s -m "feat(relay): ask broker with altitude rules, dedupe, and thread receipts"
```

---

### Task 6: Owner thread-reply auto-resolution

**Files:**
- Modify: `crates/buzz-relay/src/ask_broker.rs` (add `try_auto_resolve_from_reply`)
- Modify: `crates/buzz-relay/src/handlers/ingest.rs` (hook after successful storage of message kinds)
- Test: extend `crates/buzz-relay/tests/ask_broker.rs`

**Interfaces:**
- Consumes: `Db::resolve_ask`, asks rows (`origin_thread` column), owner role lookup.
- Produces: `ask_broker::try_auto_resolve_from_reply(tenant, state, event: &nostr::Event) -> Result<(), String>`; called fire-and-forget-with-logging after a kind 9/40002 message from an owner is stored.

Rule (spec: "You can still just answer in the thread"): when an owner posts a message whose `e`-tag thread root matches the `origin_thread` of an open ask whose audience is an owner, resolve that ask with `resolution_event = the message id`, `resolved_by = owner`, `default_executed = false`. Needs one new db read: `find_open_asks_by_thread(&self, community, thread_root: &[u8]) -> Result<Vec<AskRow>, DbError>` added to `asks.rs` (covered by a unit test there first).

- [ ] **Step 1: Failing test**: file an owner-audience ask with an origin thread; owner replies in that thread (plain kind 9, no card); assert the asks row flips to `resolved` and `find_open_ask_by_need` misses.
- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-relay --test ask_broker auto_resolve 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement** the db read + hook. The hook must not turn message-storage errors into user-visible failures: log and continue (a missed auto-resolve is recoverable; a blocked owner message is not).
- [ ] **Step 4: Run tests**

Run: `cargo test -p buzz-relay --test ask_broker 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/ask_broker.rs crates/buzz-relay/src/handlers/ingest.rs crates/buzz-db/src/asks.rs crates/buzz-relay/tests/ask_broker.rs
git commit -s -m "feat(relay): owner thread replies auto-resolve their open asks"
```

---

### Task 7: Delegation grants and decision logs

**Files:**
- Modify: `crates/buzz-core/src/interrupt.rs` (grant + decision-log parsing)
- Modify: `crates/buzz-relay/src/handlers/ingest.rs` (validation at ingest for kinds 30188 and 44303)
- Test: `crates/buzz-core/src/interrupt.rs` unit tests + extend `crates/buzz-relay/tests/ask_broker.rs`

**Interfaces:**
- Produces: `interrupt::ParsedGrant { grant_id: String, category: String, scope: String, cap_nano_usd: Option<i64>, active: bool }`, `interrupt::parse_grant(event) -> Result<ParsedGrant, AskParseError>`; `interrupt::ParsedDecisionLog { grant_id: String, task_ids: Vec<String>, decision: String, undo_path: String }`, `interrupt::parse_decision_log(event) -> Result<ParsedDecisionLog, AskParseError>`.

Rules:
1. Grant (kind 30188, NIP-33 head, `d` = grant id): content JSON requires non-empty `category`, `scope`, boolean `active`; `category` must NOT be on the hard list (`AskParseError::GrantOnHardList`); vague scope rejected: `scope` must be non-empty and not equal to `"*"` or `"all"`.
2. Ingest accepts 30188 only from pubkeys holding `MemberRole::Owner` (spec: signed by an owner key).
3. Decision log (kind 44303): tags `["grant", <id>]` + one or more `["task", <id>]`; content requires non-empty `decision` and `undo_path` (spec: no stateable undo path means no autonomy). Ingest accepts only from signers whose tier is `Leader` or `Executive` and only when the referenced grant head exists with `active: true`.

- [ ] **Step 1: Failing unit tests** for both parsers (happy path, hard-list grant, vague scope, missing undo_path) and failing integration tests for the two ingest rules (non-owner grant rejected; decision log citing a missing grant rejected).
- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-core grant 2>&1 | tail -5` and `cargo test -p buzz-relay --test ask_broker grant 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement** parsers + ingest checks (grant head existence read reuses the same parameterized-head lookup as Task 4's tier read, kind 30188 with `d` = grant id).
- [ ] **Step 4: Run tests**, both commands above, expected PASS.
- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/interrupt.rs crates/buzz-relay/src/handlers/ingest.rs crates/buzz-relay/tests/ask_broker.rs
git commit -s -m "feat: delegation grants and undo-path-required decision logs"
```

---

### Task 8: Interrupt runtime sweep (auto-promotion and default execution)

**Files:**
- Create: `crates/buzz-relay/src/interrupt_runtime.rs`
- Modify: `crates/buzz-relay/src/lib.rs`, `crates/buzz-relay/src/main.rs`
- Test: `crates/buzz-relay/tests/interrupt_runtime.rs`

**Interfaces:**
- Consumes: `Db::query_due_asks`, `Db::mark_ask_promoted`, `Db::resolve_ask`, `interrupt::AgentTier::escalation_target`, relay keypair (`state.relay_keypair`).
- Produces: `interrupt_runtime::run_interrupt_tick(state: &Arc<AppState>, now_secs: i64, batch_limit: i64) -> Result<InterruptTickStats, String>` where `InterruptTickStats { promoted: u32, defaults_executed: u32 }`. `main.rs` spawns it on an interval (default 60s, env `BUZZ_INTERRUPT_SWEEP_SECS`), mirroring the reminder scheduler block at `main.rs:~783` including its comment style and per-tick error logging.

Per due ask (deadline passed, still `open`):
1. **Has `default_option` and audience is an owner:** relay signs a kind 44301 resolution with content `{"answer": {"option": <default_option>}, "default_executed": true}`, `e`-tags the ask; `resolve_ask(..., default_executed=true)`; emit the in-thread receipt from Task 5 rule 6 with content `"Default executed: <headline> -> <default_option>"`.
2. **No default (or audience not owner): promote.** Relay signs a NEW kind 44300 ask copying the original's tags and content, with `["prior", <original hex>]`, audience replaced by the next altitude: leader audience → the executive (lookup: the unique managed-agent head with `tier == "executive"`; zero or multiple executives → log and skip, never guess), executive audience → skip promotion (already at top; the ask simply stays, but is re-deadlined `now + window` so the sweep does not spin on it: add `Db::extend_ask_deadline(&self, community, ask_event_id, new_deadline) -> Result<bool, DbError>` to `asks.rs`). Mark the original `promoted`.
3. Idempotency: each row is claimed by the status flip before the relay-signed event is emitted; a crash between flip and emit loses one notification, never duplicates state (mirror the reasoning comment style used in `company_broker.rs`).

- [ ] **Step 1: Failing integration tests:** (a) worker→leader ask past deadline promotes to an executive-audience relay-signed ask and the original row reads `promoted`; (b) owner-audience decision ask with default past deadline resolves with `default_executed = true`; (c) owner-audience ask without default gets its deadline extended, status stays `open`; (d) sweep with nothing due returns zero stats.
- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-relay --test interrupt_runtime 2>&1 | tail -8`
Expected: FAIL.

- [ ] **Step 3: Implement** `interrupt_runtime.rs`, `extend_ask_deadline` in `asks.rs`, and the `main.rs` spawn.
- [ ] **Step 4: Run tests**

Run: `cargo test -p buzz-relay --test interrupt_runtime 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/interrupt_runtime.rs crates/buzz-relay/src/lib.rs crates/buzz-relay/src/main.rs crates/buzz-db/src/asks.rs crates/buzz-relay/tests/interrupt_runtime.rs
git commit -s -m "feat(relay): interrupt sweep with auto-promotion and default execution"
```

---

### Task 9: Stall detection sweep

**Files:**
- Modify: `crates/buzz-relay/src/interrupt_runtime.rs`
- Test: extend `crates/buzz-relay/tests/interrupt_runtime.rs`

**Interfaces:**
- Consumes: task heads (kind 30181) via the head lookup used in `company_broker.rs` (`load_head`), managed-agent tier lookup, `ask_broker` filing path.
- Produces: `interrupt_runtime::run_stall_tick(state, now_secs, stall_after_secs) -> Result<u32, String>` added to the same interval task (env `BUZZ_STALL_AFTER_SECS`, default 21600 = 6h).

Rule (spec: dead agents): a task head whose content `status` field is an in-progress value and whose head event `created_at` is older than `stall_after_secs` produces one relay-signed kind 44300 ask, `ask-type = stall`, audience = the task's owning team leader (task head content field `qa` or `assignee_leader`; read the actual task-head schema in `desktop/src/features/company/contracts.ts` and use the field that names the QA identity; if the schema has no such field yet, audience = the executive), `need` = `stall-<task id>` (so dedupe suppresses repeats), initiative from the head. Task heads already carrying an open stall ask are skipped by the dedupe index for free.

- [ ] **Step 1: Failing test:** seed an in-progress task head older than the threshold; run `run_stall_tick`; assert one open `stall` ask exists with `need_key = "stall-<id>"`; run it again; assert still exactly one.
- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-relay --test interrupt_runtime stall 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests**, same command, PASS, plus full `cargo test -p buzz-relay 2>&1 | tail -5` for regressions.
- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/interrupt_runtime.rs crates/buzz-relay/tests/interrupt_runtime.rs
git commit -s -m "feat(relay): stall detection files deduped stall asks"
```

---

### Task 10: CLI verbs for agents

**Files:**
- Create: `crates/buzz-cli/src/commands/asks.rs`
- Modify: `crates/buzz-cli/src/commands/mod.rs`, `crates/buzz-cli/src/main.rs`, `crates/buzz-cli/src/client.rs`

**Interfaces:**
- Consumes: ask event shape from Task 2 (construct the same tags/content), `BuzzClient` signing + publish (mirror `commands/issues.rs` which shows the `sign_event` + publish pattern and the `{event_id, accepted, message}` write-result convention).
- Produces subcommands (all writes return the standard write JSON; exit code 5 on `duplicate:`/`conflict:` responses per the CLI's NIP-33 conflict convention):
  - `buzz asks raise --type <decision|question|credential|blocker> --to <leader-pubkey> --initiative <id> --task <id>... --need <slug> --headline <s> --cost-of-delay <s> [--thread <hex>] [--category <slug>] [--option label=consequence]... [--default <label>] [--window-secs <n>] [--channel <uuid>]`
  - `buzz asks escalate --prior <ask-hex> --to <pubkey>` plus the same field flags (re-files upward with `prior` tag; agents enrich by editing fields)
  - `buzz asks list [--audience me|--filed-by me] [--status open]` (reads via the standard query path, kind 44300, `#p` = self for audience)
  - `buzz asks answer --ask <hex> --answer-json <s>` (kind 44301)
  - `buzz asks withdraw --ask <hex> --reason <s>` (kind 44302)

- [ ] **Step 1: Failing unit test** in `asks.rs` for the event-construction helper: `build_ask_event(...)` produces tags that `buzz_core::interrupt::parse_ask` accepts round-trip (buzz-cli already depends on signing; add the dev-dependency on buzz-core if not present).
- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p buzz-cli asks 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Implement** the command module + clap wiring, mirroring `commands/issues.rs` (validation helpers from `validate.rs`, `read_or_stdin` for long text flags).
- [ ] **Step 4: Run tests + build**

Run: `cargo test -p buzz-cli 2>&1 | tail -5` and `cargo build --release -p buzz-cli 2>&1 | tail -3`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-cli/src/commands/asks.rs crates/buzz-cli/src/commands/mod.rs crates/buzz-cli/src/main.rs crates/buzz-cli/src/client.rs
git commit -s -m "feat(cli): buzz asks raise/escalate/list/answer/withdraw"
```

---

### Task 11: End-to-end chain proof

**Files:**
- Create: `crates/buzz-test-client/tests/e2e_interrupts.rs`

**Interfaces:**
- Consumes: everything above through the real relay WebSocket path (mirror the client harness of `crates/buzz-test-client/tests/e2e_relay.rs`).

The one test that encodes spec acceptance gates 1, 2, and 5:

- [ ] **Step 1: Write the test** (it should FAIL only if earlier tasks are broken; run it expecting PASS, and treat any failure as a real defect in Tasks 4-9, not the test):
  1. Boot relay; create owner, executive, leader, worker identities; publish 30177 heads with tiers; owner holds `MemberRole::Owner`.
  2. Worker publishes kind 9 p-tagging owner → relay rejects with `restricted:`.
  3. Worker raises an ask to leader (kind 44300); leader escalates to executive (`prior` tag); executive files to owner. All three accepted.
  4. Second worker raises same (initiative, need) → `duplicate:` with the first id.
  5. Owner answers via kind 44301 → asks row resolved; the origin thread receives the relay's receipt message p-tagging the filer.
  6. Assert the full chain is walkable: filed ask's `prior` → escalation → raise.
- [ ] **Step 2: Run**

Run: `cargo test -p buzz-test-client --test e2e_interrupts 2>&1 | tail -10` (infra running)
Expected: PASS end to end.

- [ ] **Step 3: Fix any defects surfaced**, re-running until green; keep fixes in the owning task's files.
- [ ] **Step 4: Full gate**

Run: `just ci 2>&1 | tail -15` and `just test 2>&1 | tail -10`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-test-client/tests/e2e_interrupts.rs
git commit -s -m "test: end-to-end interrupt chain proof (tiers, dedupe, resolution)"
```

---

### Task 12: Protocol doc

**Files:**
- Create: `docs/nips/NIP-IQ.md`
- Modify: `CLAUDE.md` (one line in Key Patterns pointing agents at the asks CLI)

- [ ] **Step 1: Write `docs/nips/NIP-IQ.md`** following the structure of an existing doc in `docs/nips/` (e.g. NIP-AM): kinds table (44300-44303, 30188), tag schema from Task 2, altitude rules, dedupe key, deadline/promotion semantics, relay-signed event behaviors, hard-list constant. Copy exact vocabulary from the Global Constraints section.
- [ ] **Step 2: Add to `CLAUDE.md` Key Patterns:** "Agent asks: agents never message owners directly; they raise typed asks via `buzz asks raise` (see docs/nips/NIP-IQ.md). Tiers live in the managed-agent head `tier` field."
- [ ] **Step 3: Verify docs build nothing (plain markdown), run `just ci` once more** for the CLAUDE.md lint surface if any.
- [ ] **Step 4: Commit**

```bash
git add docs/nips/NIP-IQ.md CLAUDE.md
git commit -s -m "docs: NIP-IQ ask protocol and agent guidance"
```

---

## Self-review notes (performed while writing)

- **Spec coverage in Plan 1:** tiers + enforcement (Tasks 1, 4), one-primitive lifecycle + altitude rules + fast-path exemption (Task 5; fast-path needs no code beyond type flag since judgment lives in agents, the relay only enforces altitude), dedupe/bundle key (Task 3 unique index; bundle *presentation* is Plan 2), default-on-timeout incl. hard-list ban (Tasks 2, 8), withdrawal receipts (Task 5), thread auto-resolve (Task 6), grants + undo-path decision logs (Task 7), relay timers + stalls (Tasks 8, 9), CLI for agents (Task 10), acceptance gates 1/2/5 (Task 11). Deferred to Plan 2: queue UI, pivots, mention-autocomplete hiding, push, mobile, bundles rendering, metrics dashboards in the daily report. Deferred to Plan 3: vault, cost imputation, daily report, purchase flow.
- **Empty-hop metric:** captured implicitly by `promoted` rows (relay-promoted = empty hop). Surfacing it is Plan 3's daily-report work; no extra schema needed now.
- **Type consistency:** `AskBrokerOutcome` mirrors `CompanyBrokerOutcome`; `query_due_asks` mirrors `query_due_reminders`; tier vocabulary identical across Tasks 1, 4, 5, 9.
- **Known verification points for implementers:** exact `nostr::EventBuilder`/`Tag` constructor names vary by crate version; confirm against existing test code before writing Task 2 tests. Task-head QA field name must be read from `desktop/src/features/company/contracts.ts` in Task 9 (do not invent it).
