# Interrupt Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the enforcement and detection gaps found in the interrupt-core review: make delegation grants bind (category + cap enforced at ingest), key stall detection to the assigned agent's own activity instead of channel chatter, wake the original worker when a manually escalated ask is answered, bound the managed-agent roster by agents rather than head revisions, give grants and decision logs a CLI surface, and teach managed agents to use the asks verbs.

**Architecture:** All changes extend the interrupt core that PR #86 merged into develop. No new event kinds, no schema migrations: parser tightening in `buzz-core`, ingest-time enforcement and runtime signal changes in `buzz-relay`, two new read queries in `buzz-db`, two new command modules in `buzz-cli`, and prompt/doc updates. Every enforcement change is proven with a test that fails against the pre-change code.

**Tech Stack:** Rust workspace (buzz-core, buzz-db, buzz-relay, buzz-cli), sqlx + Postgres, nostr crate 0.44, clap.

## Global Constraints

- **No em-dashes** in any added line: prose, doc comments, strings, docs. Use `--` in Rust doc comments (existing convention), or a regular dash/colon in docs.
- **No `unsafe`. No new `unwrap()` or `expect()` in production paths** (test code may). Use `?` and proper error types.
- **New public API must have doc comments.**
- **Commit with `git commit -s`** (DCO check). Every commit.
- **Hermit in the same shell command**: shell state does not persist between tool calls, so every command that runs `git`, `cargo`, or `just` starts with `. ./bin/activate-hermit && ` in that same command.
- **Postgres integration tests are `#[ignore]`d.** Run form (from repo root):
  `. ./bin/activate-hermit && set -a && . ./.env && set +a && cargo test -p buzz-relay --test <file> -- --ignored --nocapture --test-threads=1`
  `--test-threads=1` is mandatory: the suite is flaky under parallel threading (issue #89).
- **Unit tests**: `. ./bin/activate-hermit && cargo test -p buzz-core --lib` (and `-p buzz-cli`).
- **No schema changes in this plan.** Everything is a query against existing tables. If you believe you need a migration, stop and report BLOCKED instead of writing one.
- **DB test assertions must be community-scoped** (every query filtered by `community_id`).
- **Regression tests must be shown to fail against the pre-change code** (write test, run red, implement, run green). Where a task says "expected: FAIL", actually run it and confirm the failure is for the stated reason.
- Kind constants already exist (`KIND_ASK` 44300, `KIND_ASK_RESOLUTION` 44301, `KIND_ASK_WITHDRAWAL` 44302, `KIND_DECISION_LOG` 44303, `KIND_DELEGATION_GRANT` 30189 in `crates/buzz-core/src/kind.rs`). Do not add kinds.
- `docs/nips/NIP-IQ.md` is the protocol document. Tasks that change wire schema or enforcement update the matching section in the same commit. Zero em-dashes there too.

---

### Task 1: Decision logs declare a category and an amount (buzz-core)

Decision logs (kind 44303) currently carry only `decision` and `undo_path`, so the relay has nothing to compare against the cited grant. Add a required `category` content field and an optional `amount_nano_usd` content field to the parser. Also validate `cap_nano_usd` on grants (currently accepted silently even when negative).

**Files:**
- Modify: `crates/buzz-core/src/interrupt.rs` (struct `ParsedDecisionLog` ~line 277, `parse_decision_log` ~line 613, `parse_grant` ~line 569, `AskParseError` ~line 128, plus the module's tests)
- Modify: `crates/buzz-relay/tests/ask_broker.rs` (test helper `decision_log_content` ~line 322 only, so the existing relay integration tests stay green; no relay source changes in this task)
- Modify: `docs/nips/NIP-IQ.md` (the kind 44303 schema section and the 30189 `cap_nano_usd` description)

**Interfaces:**
- Consumes: existing `is_hard_list_category`, `required_content_field`, `parse_content`.
- Produces (Task 2 and Task 6 rely on these exact shapes):
  - `ParsedDecisionLog` gains `pub category: String` (ASCII-lowercased, never hard-list) and `pub amount_nano_usd: Option<i64>` (non-negative when present).
  - `ParsedGrant.cap_nano_usd` is now guaranteed non-negative when `Some`.
  - New `AskParseError` variants: `DecisionOnHardList(String)`, `InvalidAmount(String)`.

- [ ] **Step 1: Write the failing unit tests** in `crates/buzz-core/src/interrupt.rs`'s `mod tests`, next to the existing decision-log tests. Use the existing test helpers in that module (`t(...)` for tags, and the existing sign helpers for kind 44303 / 30189 events; read the neighboring decision-log tests first and mirror their fixture style exactly):

```rust
#[test]
fn decision_log_requires_a_category() {
    // Existing fixture content: {"decision": "...", "undo_path": "..."} with no category.
    // Expect Err(AskParseError::EmptyField(f)) with f == "category".
}

#[test]
fn decision_log_category_is_lowercased_and_round_trips() {
    // content category "Copy_Change" parses Ok with parsed.category == "copy_change".
}

#[test]
fn decision_log_claiming_a_hard_list_category_is_rejected() {
    // content category "Spend" (mixed case on purpose) must be
    // Err(AskParseError::DecisionOnHardList(c)) with c == "Spend".
    // The case-folded predicate must catch it BEFORE lowercasing is applied.
}

#[test]
fn decision_log_amount_round_trips() {
    // "amount_nano_usd": 7500000000 parses Ok with Some(7_500_000_000).
}

#[test]
fn decision_log_without_amount_parses_as_none() {}

#[test]
fn decision_log_negative_amount_is_rejected() {
    // "amount_nano_usd": -1 must be Err(AskParseError::InvalidAmount(_)).
}

#[test]
fn decision_log_non_integer_amount_is_rejected() {
    // "amount_nano_usd": "7500000000" (a string) and 7.5 (a float) must both be
    // Err(AskParseError::InvalidAmount(_)) -- a silently ignored wrong type
    // would let a capped grant's amount requirement be dodged in Task 2.
}

#[test]
fn grant_with_negative_cap_is_rejected() {
    // "cap_nano_usd": -5 on a kind 30189 grant must be
    // Err(AskParseError::InvalidAmount(_)).
}
```

Write these as real tests with real fixtures (the comments above state the required behavior; the fixtures come from the module's existing helpers).

- [ ] **Step 2: Run them to verify they fail**

Run: `. ./bin/activate-hermit && cargo test -p buzz-core --lib interrupt`
Expected: FAIL. The category tests fail because `parse_decision_log` does not read a `category` field; the amount tests fail because the field does not exist.

- [ ] **Step 3: Implement.** In `AskParseError` add:

```rust
    /// A decision log claimed a category on [`HARD_LIST_CATEGORIES`]
    /// (spec: hard-list decisions always go to the owner; no grant can cover
    /// one, so no decision log may claim one).
    #[error("category `{0}` is on the hard list; a decision log may never claim it")]
    DecisionOnHardList(String),
    /// `amount_nano_usd` (decision logs) or `cap_nano_usd` (grants) was
    /// present but not a non-negative JSON integer.
    #[error("{0} must be a non-negative integer")]
    InvalidAmount(String),
```

In `ParsedDecisionLog` add (with doc comments in the file's existing voice):

```rust
    /// The content `category` field: what kind of decision this claims to
    /// be. ASCII-lowercased by [`parse_decision_log`]; never a value on
    /// [`HARD_LIST_CATEGORIES`]. Ingest separately enforces equality with
    /// the cited grant's `category`; see
    /// `buzz-relay::interrupt_gate::enforce_decision_log_authority`.
    pub category: String,
    /// The content `amount_nano_usd` field: the money this decision moves,
    /// in integer nanoUSD, when it moves any. Ingest requires it whenever
    /// the cited grant carries `cap_nano_usd`, and refuses it above the cap.
    pub amount_nano_usd: Option<i64>,
```

In `parse_decision_log`, after `undo_path`:

```rust
    let category = required_content_field(&content, "category")?;
    if is_hard_list_category(&category) {
        return Err(AskParseError::DecisionOnHardList(category));
    }
    let category = category.to_ascii_lowercase();

    let amount_nano_usd = parse_non_negative_amount(&content, "amount_nano_usd")?;
```

Add one shared helper (used by both parsers):

```rust
/// Read an optional non-negative integer money field from content JSON.
/// A present-but-wrong-typed or negative value is an error, never a silent
/// `None`: a silently dropped amount would dodge cap enforcement at ingest.
fn parse_non_negative_amount(
    content: &serde_json::Value,
    field: &str,
) -> Result<Option<i64>, AskParseError> {
    match content.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => match value.as_i64() {
            Some(amount) if amount >= 0 => Ok(Some(amount)),
            _ => Err(AskParseError::InvalidAmount(field.to_owned())),
        },
    }
}
```

In `parse_grant`, replace the `cap_nano_usd` lines (`content.get("cap_nano_usd").and_then(serde_json::Value::as_i64)`) with `parse_non_negative_amount(&content, "cap_nano_usd")?`.

Update the module's existing decision-log fixtures to include `"category"` so previously green tests stay green.

- [ ] **Step 4: Keep the relay integration fixtures green.** In `crates/buzz-relay/tests/ask_broker.rs`, `decision_log_content(decision, undo_path)` (~line 322) builds content without a category, so every existing kind 44303 ingest test would now be refused. Add `"category": "copy_change"` to the JSON it builds (matching `grant_content`'s category used by the same tests, which also keeps them green after Task 2 adds the equality check). Do not change any relay source in this task.

- [ ] **Step 5: Run to verify green**

Run: `. ./bin/activate-hermit && cargo test -p buzz-core --lib && cargo build -p buzz-relay --tests`
Expected: PASS / compiles. (The relay integration suite itself runs in Task 2.)

- [ ] **Step 6: Update `docs/nips/NIP-IQ.md`**: in the kind 44303 section, document `category` (required, lowercased, never hard-list, must equal the cited grant's category once Task 2 lands; write it as "the relay refuses a mismatch") and `amount_nano_usd` (optional, non-negative integer nanoUSD, required under a capped grant). In the 30189 section, note `cap_nano_usd` must be a non-negative integer. No em-dashes.

- [ ] **Step 7: Commit**

```bash
. ./bin/activate-hermit && git add crates/buzz-core/src/interrupt.rs crates/buzz-relay/tests/ask_broker.rs docs/nips/NIP-IQ.md && git commit -s -m "feat(core): decision logs declare category and amount_nano_usd"
```

---

### Task 2: Enforce grant category and cap at ingest (buzz-relay)

`enforce_decision_log_authority` (`crates/buzz-relay/src/interrupt_gate.rs:473`) checks signer tier and grant-active only. Any leader holding one active grant can log any decision citing it, and a cap is parsed but never compared. Make the grant bind.

**Files:**
- Modify: `crates/buzz-relay/src/interrupt_gate.rs:473-497` (`enforce_decision_log_authority`)
- Modify: `crates/buzz-relay/tests/ask_broker.rs` (the "Task 7: delegation grants and decision logs" section ~line 2441; extend helpers, add tests)
- Modify: `docs/nips/NIP-IQ.md` (enforcement section for 44303: state the two refusals as normative)

**Interfaces:**
- Consumes: `ParsedDecisionLog.category` / `.amount_nano_usd` and non-negative `ParsedGrant.cap_nano_usd` from Task 1; existing `active_grant(tenant, state, grant_id) -> Result<Option<ParsedGrant>, String>`.
- Produces: refusal messages beginning `restricted: decision log claims category` and `restricted: grant`, used verbatim by tests.

- [ ] **Step 1: Extend the test helpers.** In `ask_broker.rs`, `grant_content(category, scope, active)` (~line 300) has no cap parameter. Add alongside it (do not change the existing helper's signature; every current caller stays untouched):

```rust
fn grant_content_capped(category: &str, scope: &str, active: bool, cap_nano_usd: i64) -> String {
    serde_json::json!({
        "category": category,
        "scope": scope,
        "active": active,
        "cap_nano_usd": cap_nano_usd,
    })
    .to_string()
}

fn decision_log_content_with(
    decision: &str,
    undo_path: &str,
    category: &str,
    amount_nano_usd: Option<i64>,
) -> String {
    let mut content = serde_json::json!({
        "decision": decision,
        "undo_path": undo_path,
        "category": category,
    });
    if let Some(amount) = amount_nano_usd {
        content["amount_nano_usd"] = serde_json::json!(amount);
    }
    content.to_string()
}
```

- [ ] **Step 2: Write the failing integration tests** in the same section, mirroring the fixture flow of the existing `a_decision_log_citing_an_active_grant_is_accepted`-style tests (owner-authored grant via `sign_grant` ingested first, then a leader-tier signer's decision log through the same ingest path; use `set_tier` and `add_owner` exactly as the neighboring tests do):

```rust
#[tokio::test]
#[ignore]
async fn a_decision_log_with_a_mismatched_category_is_rejected() {
    // Grant: category "copy_change". Decision log: category "channel_strategy"
    // (valid, non-hard-list, just not what the grant delegates).
    // Expect refusal containing "claims category" and no stored 44303 event
    // (community-scoped get_event_by_id returns None).
}

#[tokio::test]
#[ignore]
async fn a_decision_log_under_a_capped_grant_without_an_amount_is_rejected() {
    // Grant via grant_content_capped("copy_change", "blog_post_titles", true, 10_000_000_000).
    // Decision log with matching category but amount_nano_usd absent.
    // Expect refusal containing "must declare amount_nano_usd".
}

#[tokio::test]
#[ignore]
async fn a_decision_log_over_the_cap_is_rejected() {
    // Cap 10_000_000_000; amount 10_000_000_001. Expect refusal containing "exceeds".
}

#[tokio::test]
#[ignore]
async fn a_decision_log_at_exactly_the_cap_is_accepted() {
    // Cap 10_000_000_000; amount 10_000_000_000. Expect accepted and stored.
}

#[tokio::test]
#[ignore]
async fn a_decision_log_with_an_amount_under_an_uncapped_grant_is_accepted() {
    // Grant without cap; decision declares an amount anyway. Accepted:
    // declaring more than required is never an offence.
}
```

- [ ] **Step 3: Run them to verify they fail for the right reason**

Run: `. ./bin/activate-hermit && set -a && . ./.env && set +a && cargo test -p buzz-relay --test ask_broker -- --ignored --nocapture --test-threads=1 decision_log`
Expected: the five new tests FAIL because the events are currently ACCEPTED (assert messages should show "expected refusal, got accepted"), except `at_exactly_the_cap` and `uncapped_grant`, which may already pass; note in the task report which failed red.

- [ ] **Step 4: Implement.** Replace the grant-active block at the end of `enforce_decision_log_authority` with:

```rust
    let Some(grant) = active_grant(tenant, state, &parsed.grant_id)
        .await?
        .filter(|grant| grant.active)
    else {
        return Err(format!(
            "restricted: decision log cites a grant that is not currently active: {}",
            parsed.grant_id
        ));
    };

    // Scope: a grant delegates ONE category of decision. A decision log
    // claiming any other category is citing authority it does not hold, no
    // matter how real the grant is -- without this check, one active grant
    // authorizes every decision an agent cares to record.
    if parsed.category != grant.category {
        return Err(format!(
            "restricted: decision log claims category `{}` but grant `{}` delegates only `{}`",
            parsed.category, parsed.grant_id, grant.category
        ));
    }

    // Cap: a capped grant binds every decision under it to a declared,
    // machine-readable amount at or under the cap. A missing amount fails
    // closed: no declared amount means no way to check the cap.
    if let Some(cap) = grant.cap_nano_usd {
        match parsed.amount_nano_usd {
            None => {
                return Err(format!(
                    "restricted: grant `{}` carries a spending cap; the decision log \
                     must declare amount_nano_usd",
                    parsed.grant_id
                ))
            }
            Some(amount) if amount > cap => {
                return Err(format!(
                    "restricted: decision amount {amount} nanoUSD exceeds grant `{}` \
                     cap of {cap}",
                    parsed.grant_id
                ))
            }
            Some(_) => {}
        }
    }

    Ok(())
```

Update the function's doc comment to name all three checks (tier, grant active + category equality, cap). Keep the existing tier check above untouched.

- [ ] **Step 5: Run the full file green**

Run: `. ./bin/activate-hermit && set -a && . ./.env && set +a && cargo test -p buzz-relay --test ask_broker -- --ignored --nocapture --test-threads=1`
Expected: PASS, including every pre-existing test (Task 1's helper edit keeps the old fixtures category-matched).

- [ ] **Step 6: Update `docs/nips/NIP-IQ.md`** enforcement text for 44303: the relay refuses a category mismatch and enforces `cap_nano_usd` per decision; state plainly that `scope` prose remains descriptive (surfaced for audit, not machine-enforced) and that cumulative spend across decisions is NOT enforced here (that belongs to cost imputation, a later plan).

- [ ] **Step 7: Commit**

```bash
. ./bin/activate-hermit && git add crates/buzz-relay/src/interrupt_gate.rs crates/buzz-relay/tests/ask_broker.rs docs/nips/NIP-IQ.md && git commit -s -m "feat(relay): enforce delegation grant category and cap on decision logs"
```

---

### Task 3: Stall detection keyed to the assigned agent's own activity (buzz-db + buzz-relay)

`process_stall_candidate` (`crates/buzz-relay/src/interrupt_runtime.rs:1113`) measures silence as max(task head `created_at`, last message in the task's `source_channel_id`). Any chatter in that channel by anyone suppresses detection of a dead agent. Re-key the signal to the assigned agents' own authored events, falling back to the channel signal only when no assignee resolves to a running agent.

**Files:**
- Modify: `crates/buzz-db/src/event.rs` (new query next to `get_last_message_at` ~line 1054)
- Modify: `crates/buzz-db/src/lib.rs` (Db wrapper next to `get_last_message_at` ~line 2127)
- Modify: `crates/buzz-relay/src/interrupt_runtime.rs:1137-1193` (the silence measurement in `process_stall_candidate`, and moving the roster fetch above it)
- Modify: `crates/buzz-relay/tests/interrupt_runtime.rs` (new tests; audit the two existing channel-signal tests at lines ~1527 and ~1585)
- Modify: `docs/nips/NIP-IQ.md` (stall detection section: describe the per-agent signal and the narrowed channel-fallback limitation)

**Interfaces:**
- Consumes: `persona_pubkey_in_roster(roster, persona_id) -> Result<Option<PublicKey>, String>` (interrupt_runtime.rs:1380), `CompanyTask.assignee_persona_ids: Vec<String>`, the existing per-pass `roster_cache`.
- Produces: `Db::get_last_authored_event_at(community_id, pubkey: &[u8]) -> Result<Option<DateTime<Utc>>>`.

- [ ] **Step 1: Add the query.** In `crates/buzz-db/src/event.rs`, next to `get_last_message_at` and in its exact style:

```rust
/// Returns the `created_at` of the most recent non-deleted event authored
/// by `pubkey` anywhere in the community -- any kind, channel or global.
/// The interrupt stall sweep uses this as its per-agent liveness signal;
/// see `buzz-relay`'s `interrupt_runtime::process_stall_candidate`.
pub async fn get_last_authored_event_at(
    pool: &PgPool,
    community_id: CommunityId,
    pubkey: &[u8],
) -> Result<Option<DateTime<Utc>>> {
    let row = sqlx::query(
        "SELECT created_at FROM events \
         WHERE community_id = $1 AND pubkey = $2 AND deleted_at IS NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(community_id.as_uuid())
    .bind(pubkey)
    .fetch_optional(pool)
    .await?;

    match row {
        Some(row) => Ok(Some(row.try_get("created_at")?)),
        None => Ok(None),
    }
}
```

Add the delegating `Db` method in `lib.rs` beside `get_last_message_at`, same shape. Add a `#[ignore]`d buzz-db unit test beside the existing `get_last_message_at` tests if that file has them; otherwise the relay integration tests in Step 3 are the coverage.

- [ ] **Step 2: Write the failing integration tests** in `crates/buzz-relay/tests/interrupt_runtime.rs`, using the existing stall fixtures (`store_task_head_at`, `post_message_at`, `set_persona`, `default_task`, `run_stall_tick`). Read `stall_ask_filed_for_a_silent_in_progress_task_and_deduped_on_rerun` (~line 1385) first and mirror its structure:

```rust
#[tokio::test]
#[ignore]
async fn busy_channel_does_not_mask_a_silent_assigned_agent() {
    // Task assigned to persona P; P resolves (via set_persona + the roster)
    // to agent key A. A's last authored event is older than stall_after_secs.
    // A DIFFERENT author posts a message in the task's source channel one
    // second ago. run_stall_tick must file exactly one stall ask for the task.
    // THIS IS THE REGRESSION TEST: against pre-change code it fails because
    // the recent channel message suppresses detection.
}

#[tokio::test]
#[ignore]
async fn assignee_activity_in_another_channel_prevents_a_stall() {
    // Same setup, but A authored an event in a DIFFERENT channel one second
    // ago while the source channel is silent. No stall ask filed: the signal
    // follows the agent, not the channel.
}

#[tokio::test]
#[ignore]
async fn unresolvable_assignees_fall_back_to_the_channel_signal() {
    // Task whose assignee_persona_ids resolve to NO roster agent. Recent
    // channel message by anyone. No stall ask filed (previous behavior
    // retained for tasks the sweep cannot attribute to an agent).
}
```

- [ ] **Step 3: Run to verify the regression test fails**

Run: `. ./bin/activate-hermit && set -a && . ./.env && set +a && cargo test -p buzz-relay --test interrupt_runtime -- --ignored --nocapture --test-threads=1 busy_channel_does_not_mask`
Expected: FAIL with zero stall asks filed where one is asserted.

- [ ] **Step 4: Implement in `process_stall_candidate`.** Move BOTH the `tenant` construction (`TenantContext::resolved(candidate.community_id, candidate.host.clone())`, ~line 1234) and the roster block that depends on it (`if let Entry::Vacant... fetch_owner_authored_managed_agent_roster ... roster_cache.get(...)`, ~lines 1236-1248) up to directly after the `source_channel_id` parse, so the roster is available for the silence measurement; their comments move with them. Then replace the channel-signal block (~lines 1146-1193) with:

```rust
    // Silence means the ASSIGNED AGENTS have gone event-silent, not merely
    // that the head is old: the signal is the most recent of (a) the task
    // head's own `created_at` (a status change is itself activity) and (b)
    // the newest event AUTHORED BY any of the task's resolvable assignee
    // agents, anywhere in the community. An agent that is alive keeps
    // producing events (messages, task updates, asks); a busy channel no
    // longer vouches for a dead one.
    //
    // KNOWN FALSE NEGATIVE, now confined to the fallback: a task none of
    // whose `assignee_persona_ids` resolve to a running agent in the
    // owner-authored roster cannot be measured per-agent, so it falls back
    // to the old channel-activity signal, where any chatter in
    // `source_channel_id` suppresses detection. Accepted: for an
    // unattributable task the channel is still the best signal available,
    // and filing stall asks on every quiet-headed task with an active
    // channel would be the queue-spam failure this system exists to prevent.
    let mut assignee_pubkeys: Vec<PublicKey> = Vec::new();
    for persona_id in &task.assignee_persona_ids {
        if let Some(pubkey) = persona_pubkey_in_roster(roster, persona_id)? {
            assignee_pubkeys.push(pubkey);
        }
    }

    let mut activity: Vec<i64> = Vec::new();
    if assignee_pubkeys.is_empty() {
        let channel_last_activity = state
            .db
            .get_last_message_at(candidate.community_id, source_channel_id)
            .await
            .map_err(|error| format!("database error loading channel activity: {error}"))?;
        if let Some(at) = channel_last_activity {
            activity.push(at.timestamp());
        }
    } else {
        for pubkey in &assignee_pubkeys {
            let last = state
                .db
                .get_last_authored_event_at(candidate.community_id, pubkey.as_bytes())
                .await
                .map_err(|error| format!("database error loading agent activity: {error}"))?;
            if let Some(at) = last {
                activity.push(at.timestamp());
            }
        }
    }
    let head_created_at = candidate.task_head_created_at.timestamp();
    let last_activity_secs = activity
        .into_iter()
        .chain(std::iter::once(head_created_at))
        .max()
        .unwrap_or(head_created_at);
    let silent_for_secs = now_secs.saturating_sub(last_activity_secs);
    if silent_for_secs < stall_after_secs {
        return Ok(false);
    }
```

The `find_latest_closed_ask_by_need` guard and everything after it stay as they are (they consume `last_activity_secs`, which keeps its meaning). Verify `PublicKey::as_bytes()` matches how `events.pubkey` bytes are stored; the existing code that compares `prior.audience_pubkey != successor.pubkey.to_bytes().to_vec()` in `ask_broker.rs:340` shows the byte convention.

- [ ] **Step 5: Audit the two existing channel-signal tests.** `recent_status_change_is_not_flagged_as_stalled_even_with_an_old_channel` (~1527) and `recent_channel_activity_prevents_a_stall_flag_despite_an_old_task_head` (~1585): if their fixtures resolve assignees through the roster, the second one now exercises a dead branch and will fail. Point its fixture at unresolvable assignee personas (making it the fallback-branch test) or assert the new behavior, whichever keeps its name honest; rename if the name no longer matches what it proves.

- [ ] **Step 6: Run the whole file green**

Run: `. ./bin/activate-hermit && set -a && . ./.env && set +a && cargo test -p buzz-relay --test interrupt_runtime -- --ignored --nocapture --test-threads=1`
Expected: PASS (36-ish tests).

- [ ] **Step 7: Update `docs/nips/NIP-IQ.md`** stall section: per-agent signal, channel fallback for unattributable tasks, and delete or rewrite any sentence still claiming channel activity is the primary signal.

- [ ] **Step 8: Commit**

```bash
. ./bin/activate-hermit && git add crates/buzz-db/src/event.rs crates/buzz-db/src/lib.rs crates/buzz-relay/src/interrupt_runtime.rs crates/buzz-relay/tests/interrupt_runtime.rs docs/nips/NIP-IQ.md && git commit -s -m "feat(relay): key stall detection to assignee agent activity, not channel chatter"
```

---

### Task 4: Roster window bounds agents, not head revisions (buzz-db + buzz-relay)

`fetch_owner_authored_managed_agent_roster` (`crates/buzz-relay/src/interrupt_runtime.rs:833`) fetches the 500 most recent `KIND_MANAGED_AGENT` events (`MAX_ROSTER_HEADS`, line 118) and dedupes by `d` tag in Rust, with one membership query per row. 500 bounds REVISIONS: a community whose agents' heads are re-published often pushes older agents' heads out of the window entirely, making them invisible to promotion and stall audience resolution. Push latest-head-per-agent and owner-authorship into SQL.

**Files:**
- Modify: `crates/buzz-db/src/event.rs` (new query; reuse the file's existing row-to-StoredEvent mapping helper, whatever `query_events` uses)
- Modify: `crates/buzz-db/src/lib.rs` (Db wrapper)
- Modify: `crates/buzz-relay/src/interrupt_runtime.rs:833-890` (rewrite the fetch), `:118` (`MAX_ROSTER_HEADS` doc comment: it now bounds agents)
- Modify: `crates/buzz-relay/tests/interrupt_runtime.rs` (regression test)

**Interfaces:**
- Consumes: `events.d_tag` column, `relay_members(community_id, pubkey TEXT hex, role)`.
- Produces: `Db::query_latest_owner_authored_heads(community_id, kind: i32, limit: i64) -> Result<Vec<StoredEvent>>` (also used verbatim mentally by reviewers of `interrupt_gate::active_grant`, though that function is NOT changed in this plan: its 20-head window is per-d_tag and fine).

- [ ] **Step 1: Write the failing regression test** in `interrupt_runtime.rs` tests, modeled on `leader_audience_ask_past_deadline_promotes_to_the_executive` (~line 458):

```rust
#[tokio::test]
#[ignore]
async fn executive_resolution_survives_a_flood_of_other_head_revisions() {
    // Seed the executive's owner-authored tier head ONCE (set_tier).
    // Then publish 520 owner-authored revisions of a DIFFERENT agent's
    // managed-agent head (a loop re-inserting kind KIND_MANAGED_AGENT events
    // with the same other-agent d tag, ascending created_at -- mirror how
    // set_tier stores heads).
    // File a leader-audience ask past its deadline and run the interrupt tick.
    // The ask must promote to the executive.
    // Against pre-change code this FAILS: the executive's single head fell
    // outside the 500-newest-revisions window, so the ask is re-deadlined.
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `. ./bin/activate-hermit && set -a && . ./.env && set +a && cargo test -p buzz-relay --test interrupt_runtime -- --ignored --nocapture --test-threads=1 survives_a_flood`
Expected: FAIL (ask re-deadlined instead of promoted).

- [ ] **Step 3: Add the query.** In `event.rs`:

```rust
/// One newest owner-authored NIP-33 head per `d` tag for `kind`, community
/// scoped, global events only (`channel_id IS NULL`), non-deleted.
///
/// "Owner-authored" is evaluated in SQL against `relay_members.role =
/// 'owner'`, so a non-owner's newer head at the same `d` tag can never
/// shadow the owner's: non-owner rows are excluded before `DISTINCT ON`
/// picks the newest. Ties on `created_at` break toward the lowest event id
/// (NIP-01). `limit` bounds distinct `d` tags (agents), not revisions.
pub async fn query_latest_owner_authored_heads(
    pool: &PgPool,
    community_id: CommunityId,
    kind: i32,
    limit: i64,
) -> Result<Vec<StoredEvent>> {
    // SELECT DISTINCT ON (e.d_tag) <the same column list the file's other
    // StoredEvent queries select>
    // FROM events e
    // JOIN relay_members m
    //   ON m.community_id = e.community_id
    //  AND m.pubkey = encode(e.pubkey, 'hex')
    //  AND m.role = 'owner'
    // WHERE e.community_id = $1 AND e.kind = $2
    //   AND e.channel_id IS NULL AND e.deleted_at IS NULL
    //   AND e.d_tag IS NOT NULL
    // ORDER BY e.d_tag, e.created_at DESC, e.id ASC
    // LIMIT $3
}
```

Write the real SQL string with the exact column list and row-mapping helper the file's existing `StoredEvent`-returning queries use (read `query_events`' SELECT list and copy it; do not invent column names). Add the `Db` wrapper.

- [ ] **Step 4: Rewrite `fetch_owner_authored_managed_agent_roster`** to consume it:

```rust
async fn fetch_owner_authored_managed_agent_roster(
    tenant: &TenantContext,
    state: &AppState,
    limit: i64,
) -> Result<ManagedAgentRoster, String> {
    let rows = state
        .db
        .query_latest_owner_authored_heads(tenant.community(), KIND_MANAGED_AGENT as i32, limit)
        .await
        .map_err(|error| format!("database error scanning managed-agent roster: {error}"))?;

    let mut roster = ManagedAgentRoster::new();
    for stored in rows {
        let Some(d_tag) = stored.event.tags.iter().find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() >= 2 && parts[0] == "d").then(|| parts[1].clone())
        }) else {
            continue;
        };
        // NIP-33 latest-wins among the owner's own heads: the query already
        // returned exactly one newest owner-authored head per d tag, so a
        // malformed content settles its agent (skipped, no fallback to an
        // older superseded head) -- the same semantics the Rust-side scan
        // this replaced enforced row by row.
        let Ok(content) = serde_json::from_str::<serde_json::Value>(&stored.event.content) else {
            continue;
        };
        roster.push((d_tag, content));
    }
    Ok(roster)
}
```

Update `MAX_ROSTER_HEADS`'s doc comment: it now bounds distinct agents per community, and the per-row membership N+1 is gone. Keep the value 500.

- [ ] **Step 5: Run the file green** (same command as Task 3 Step 6). The impostor-shadowing property must still hold: confirm `worker_self_published_tier_head_does_not_override_owner_authored_tier` (interrupt_gate.rs, unchanged code path) and every existing roster-consuming test passes.

- [ ] **Step 6: Commit**

```bash
. ./bin/activate-hermit && git add crates/buzz-db/src/event.rs crates/buzz-db/src/lib.rs crates/buzz-relay/src/interrupt_runtime.rs crates/buzz-relay/tests/interrupt_runtime.rs && git commit -s -m "fix(relay): bound the managed-agent roster by agents, not head revisions"
```

---

### Task 5: Resolution of a manual escalation wakes the original filer too (buzz-db + buzz-relay)

When a leader escalates a worker's ask (successor carries `prior`), the broker closes the prior as superseded (`close_superseded_prior`, `ask_broker.rs:297`). When the successor is later resolved, only the successor's filer is woken; the originally blocked worker learns nothing. Wake both: the successor's filer stays the accountable audience of the receipt flow, and the prior's filer gets an additive "resolved upstream" receipt in its own origin thread.

**Files:**
- Modify: `crates/buzz-db/src/asks.rs` (new `find_ask_by_event_id`, any status, next to `find_open_ask_by_event_id` at line 185; plus the delegating `Db` method wherever `find_open_ask_by_event_id`'s lives)
- Modify: `crates/buzz-relay/src/ask_broker.rs` (`handle_resolution` ~line 698-715; new `wake_superseded_prior_filer`)
- Modify: `crates/buzz-relay/tests/ask_broker.rs` (new tests near `resolution_by_the_audience_resolves_and_wakes_the_filer` ~line 1304)
- Modify: `docs/nips/NIP-IQ.md` (receipts section: document the upstream wake and its standing rule)

**Interfaces:**
- Consumes: `AskRow` (fields `ask_type`, `audience_pubkey`, `filer_pubkey`, `origin_thread`, `prior_ask`), `ParsedAsk.prior_ask_hex`, `emit_ask_receipt(tenant, state, origin_thread_hex, content, blocked_agent, ask_channel_id)` (~line 850), `resolve_filer(state, event, parsed) -> Result<PublicKey, String>` (~line 488).
- Produces: receipt content prefix `Ask resolved upstream:` (tests match on it).

- [ ] **Step 1: Add the row getter.** Copy `find_open_ask_by_event_id` in `asks.rs`, drop the `status = 'open'` predicate, name it `find_ask_by_event_id`, doc comment:

```rust
/// Load an ask row by its filing event id regardless of status. The
/// resolution path uses this to find a superseded (already-withdrawn)
/// prior so its filer can be woken too; see `buzz-relay`'s `ask_broker`.
```

Add the delegating `Db` method beside `find_open_ask_by_event_id`'s.

- [ ] **Step 2: Write the failing integration tests** in `ask_broker.rs`, using the existing chain helpers (`file_leader_ask_to_executive` ~1277, `file_executive_ask_to_owner` ~1987, `store_root`, `fetch_ask_row`). Read `resolution_by_the_audience_resolves_and_wakes_the_filer` first for the receipt-assertion pattern (how it finds the receipt message event and its `p` tags):

```rust
#[tokio::test]
#[ignore]
async fn resolving_an_escalated_ask_wakes_the_original_filer_in_its_own_thread() {
    // Worker files ask A1 to leader, origin thread T1 (worker is a member of
    // T1's channel). Leader files successor A2 to the executive with
    // ["prior", A1] and its own origin thread T2; the broker closes A1 as
    // superseded (existing behavior; assert A1's row status is withdrawn).
    // Executive resolves A2.
    // Assert: a receipt in T2 p-tagging the leader (existing behavior),
    // AND a receipt in T1 p-tagging the worker whose content starts with
    // "Ask resolved upstream:". Fails pre-change: no T1 receipt exists.
}

#[tokio::test]
#[ignore]
async fn a_prior_pointing_at_a_foreign_ask_never_wakes_its_filer() {
    // Agent X has an open ask AX addressed to leader L2. A different leader
    // L1 (NOT AX's audience) files an ask carrying ["prior", AX] (the broker
    // accepts the ask; the supersede close already refuses for standing).
    // Resolving L1's ask must NOT emit any receipt p-tagging X.
}

#[tokio::test]
#[ignore]
async fn a_stall_prior_is_never_woken_upstream() {
    // A relay-filed stall ask S exists addressed to executive E. E files an
    // ask carrying ["prior", S]. Resolving E's ask must not emit a receipt
    // p-tagging S's filer (the relay key).
}
```

- [ ] **Step 3: Run to verify the first fails** (command as in Task 2 Step 3 with filter `wakes_the_original_filer`). Expected: FAIL, no T1 receipt found.

- [ ] **Step 4: Implement.** In `ask_broker.rs` add:

```rust
/// After a resolution closes an ask that superseded a prior (a manual
/// escalation chain), wake the PRIOR's filer too: the answer belongs to
/// whoever was originally blocked, not only to the agent that carried the
/// ask upward. Additive and best-effort -- the audience receipt has
/// already gone out.
///
/// `prior` is an unauthenticated tag (see [`close_superseded_prior`]), so
/// the same standing rule gates this wake: the prior ask's audience must
/// BE the resolved ask's signer, and a relay-filed stall prior is never
/// woken this way. Without those checks an agent could point `prior` at
/// any ask in the community and have the relay deliver "resolved" wake-ups
/// to its filer.
async fn wake_superseded_prior_filer(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    successor_event: &Event,
    successor_ask: &ParsedAsk,
) {
    let Some(prior_hex) = &successor_ask.prior_ask_hex else {
        return;
    };
    let Ok(prior_bytes) = hex::decode(prior_hex) else {
        return;
    };
    let prior = match state
        .db
        .find_ask_by_event_id(tenant.community(), &prior_bytes)
        .await
    {
        Ok(Some(prior)) => prior,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(%error, "upstream wake: failed to load the prior ask row");
            return;
        }
    };
    if prior.ask_type == AskType::Stall.as_str() {
        return;
    }
    if prior.audience_pubkey != successor_event.pubkey.to_bytes().to_vec() {
        return;
    }
    let Some(origin_thread) = &prior.origin_thread else {
        return;
    };
    let Ok(filer) = PublicKey::from_slice(&prior.filer_pubkey) else {
        return;
    };
    // The audience receipt may already have reached this same agent (a
    // self-escalation, or resolve_filer landing on the same key); one wake
    // is enough.
    if let Ok(primary) = resolve_filer(state, successor_event, successor_ask) {
        if primary == filer {
            return;
        }
    }
    emit_ask_receipt(
        tenant,
        state,
        &hex::encode(origin_thread),
        &format!("Ask resolved upstream: {}", successor_ask.headline),
        filer,
        None,
    )
    .await;
}
```

In `handle_resolution`, after the existing `if let Some(origin_thread_hex) = &ask.origin_thread_hex { ... }` block (NOT inside it; the upstream wake must fire even when the successor itself has no origin thread), add:

```rust
    wake_superseded_prior_filer(tenant, state, &stored_ask.event, &ask).await;
```

Check `AskType` is already imported in `ask_broker.rs` (it is, for `close_superseded_prior`'s stall check).

- [ ] **Step 5: Run the whole ask_broker file green** (Task 2 Step 5 command). Expected: PASS.

- [ ] **Step 6: Update `docs/nips/NIP-IQ.md`** receipts section with the upstream wake, its `Ask resolved upstream:` content prefix, and the standing + no-stall rules.

- [ ] **Step 7: Commit**

```bash
. ./bin/activate-hermit && git add crates/buzz-db/src/asks.rs crates/buzz-db/src/lib.rs crates/buzz-relay/src/ask_broker.rs crates/buzz-relay/tests/ask_broker.rs docs/nips/NIP-IQ.md && git commit -s -m "feat(relay): wake the superseded prior's filer when an escalated ask resolves"
```

---

### Task 6: CLI surface for grants and decision logs (buzz-cli)

Grants and decision logs currently exist only as raw kinds; they must be hand-signed to use at all. Add `buzz grants create/revoke/list` and `buzz decisions log/list`, mirroring `commands/asks.rs`'s structure exactly (build event, self-validate with the buzz-core parser, submit, normalized output, standard exit codes).

**Files:**
- Create: `crates/buzz-cli/src/commands/grants.rs`
- Create: `crates/buzz-cli/src/commands/decisions.rs`
- Modify: `crates/buzz-cli/src/commands/mod.rs` (register both modules)
- Modify: `crates/buzz-cli/src/lib.rs` (top-level `Cmd` enum ~line 261 area, new `GrantsCmd`/`DecisionsCmd` enums near `AsksCmd` ~line 2470, dispatch arms near line 2619, and the examples list near line 2653)
- Modify: `docs/nips/NIP-IQ.md` (CLI section if one exists; otherwise the 30189/44303 sections gain the command lines)

**Interfaces:**
- Consumes: `parse_grant`, `parse_decision_log` (with Task 1's fields), `KIND_DELEGATION_GRANT`, `KIND_DECISION_LOG` from buzz-core; `BuzzClient` + `normalize_write_response` exactly as `commands/asks.rs` uses them; the client's query path used by `cmd_list_asks` (read it first; reuse the same call for kinds `[30189]` / `[44303]`, global scope).
- Produces: command surface used verbatim in Task 7's prompt text: `buzz grants create --id --category --scope [--cap-nano-usd]`, `buzz grants revoke --id`, `buzz grants list [--active]`, `buzz decisions log --grant --task... --category --decision --undo-path [--amount-nano-usd]`, `buzz decisions list`.

- [ ] **Step 1: Clap types in `lib.rs`.** Add to the top-level `Cmd` enum, next to `Asks`:

```rust
    /// Create, revoke, and list delegation grants (kind 30189; owner-signed)
    #[command(subcommand)]
    Grants(GrantsCmd),
    /// Record and list decision logs made under a delegation grant (kind 44303)
    #[command(subcommand)]
    Decisions(DecisionsCmd),
```

Near `AsksCmd`, add (doc comments become `--help` text; keep them exact):

```rust
/// Subcommands for `buzz grants`: delegation grants, the owner-signed heads
/// that let a leader or executive decide a bounded category autonomously.
#[derive(Subcommand)]
pub enum GrantsCmd {
    /// Publish (or update) a delegation grant head. Owner key required: the
    /// relay refuses a grant signed by anyone but a current community owner.
    Create {
        /// Stable grant id (the NIP-33 `d` tag); re-using an id updates that grant
        #[arg(long)]
        id: String,
        /// Decision category this grant delegates. Hard-list categories
        /// (spend, external_send, hiring, legal, pricing, deletion, vendor)
        /// are refused: those always go to the owner
        #[arg(long)]
        category: String,
        /// Precise scope of the delegation; wildcards ("*", "all") are refused
        #[arg(long)]
        scope: String,
        /// Optional spending cap in integer nanoUSD. Decisions under a capped
        /// grant must declare --amount-nano-usd at or under the cap
        #[arg(long)]
        cap_nano_usd: Option<i64>,
    },
    /// Revoke a grant: republish its head with active=false (the record stays)
    Revoke {
        /// The grant id to revoke
        #[arg(long)]
        id: String,
    },
    /// List delegation grant heads (kind 30189), newest first
    List {
        /// Only grants whose newest head is active
        #[arg(long)]
        active: bool,
    },
}

/// Subcommands for `buzz decisions`: the audit trail a leader or executive
/// writes when it decides something under a delegation grant.
#[derive(Subcommand)]
pub enum DecisionsCmd {
    /// Record a decision made under a grant. The relay refuses a category
    /// that does not match the grant, and enforces the grant's cap
    Log {
        /// The delegation grant id this decision was made under
        #[arg(long)]
        grant: String,
        /// Task id(s) this decision covers (repeatable, at least one)
        #[arg(long, required = true)]
        task: Vec<String>,
        /// The decision's category; must equal the cited grant's category
        #[arg(long)]
        category: String,
        /// What was decided
        #[arg(long)]
        decision: String,
        /// How to undo this decision. Required: no undo path, no autonomy
        #[arg(long)]
        undo_path: String,
        /// Money this decision moves, in integer nanoUSD. Required when the
        /// grant carries a cap
        #[arg(long)]
        amount_nano_usd: Option<i64>,
    },
    /// List decision logs (kind 44303), newest first
    List {},
}
```

Dispatch arms next to `Cmd::Asks`:

```rust
        Cmd::Grants(sub) => commands::grants::dispatch(sub, &client).await,
        Cmd::Decisions(sub) => commands::decisions::dispatch(sub, &client).await,
```

Add to the examples list (near line 2653): `vec!["buzz", "grants", "create", "--id", "grant-copy", "--category", "copy_change", "--scope", "blog post titles"]`, `vec!["buzz", "grants", "revoke", "--id", "grant-copy"]`, `vec!["buzz", "grants", "list", "--active"]`, `vec!["buzz", "decisions", "log", "--grant", "grant-copy", "--task", "task-1", "--category", "copy_change", "--decision", "shortened the title", "--undo-path", "revert commit abc"]`, `vec!["buzz", "decisions", "list"]`.

- [ ] **Step 2: Write the failing unit tests.** In each new command file's `mod tests`, mirroring `commands/asks.rs`'s test style (build the event with the module's builder, then assert the buzz-core parser's verdict; no network):

```rust
// grants.rs tests:
// - build_grant_event round-trips through parse_grant (category lowercased,
//   cap preserved).
// - a hard-list --category ("spend") returns CliError::Usage BEFORE any
//   network call (assert the parse_grant self-validation catches it).
// - a wildcard --scope ("*") returns CliError::Usage.
// - a negative --cap-nano-usd returns CliError::Usage.
//
// decisions.rs tests:
// - build_decision_log_event round-trips through parse_decision_log
//   (grant tag, every task tag, category, amount).
// - hard-list --category returns CliError::Usage.
// - negative --amount-nano-usd returns CliError::Usage.
```

Write them as real tests against the builder functions defined in Step 4.

- [ ] **Step 3: Run to verify they fail to compile** (`. ./bin/activate-hermit && cargo test -p buzz-cli` -- modules do not exist yet). This is the TDD red for new modules.

- [ ] **Step 4: Implement both modules.** Follow `commands/asks.rs` top to bottom as the template:
  - `grants.rs`: `build_grant_event(id, category, scope, cap_nano_usd, active) -> Result<EventBuilder, CliError>` producing kind `KIND_DELEGATION_GRANT` with `["d", id]` tag and content `{"category":..., "scope":..., "active":..., "cap_nano_usd":...}` (omit the cap key when `None`); `cmd_create` signs, self-validates with `parse_grant` (a parser rejection maps to `CliError::Usage` with the parser's message, exactly as `cmd_raise_ask` does with `parse_ask`), submits via the same client call `cmd_raise_ask` uses, prints the normalized write response. `cmd_revoke` first queries kind `[30189]` (global, the same client query path `cmd_list_asks` uses), filters client-side to events whose `d` tag equals `--id`, takes the newest by `created_at`; if none, `CliError::Usage("no grant head found with id ...")` (exit 1); otherwise re-parses it with `parse_grant` and republishes the same category/scope/cap with `active: false` through `build_grant_event`. `cmd_list` queries kind `[30189]`, keeps the newest head per `d` tag, optionally filters `--active` on the parsed `active` field, prints the sig-stripped JSON array exactly the way `cmd_list_asks` prints its results.
  - `decisions.rs`: `build_decision_log_event(grant, tasks, category, decision, undo_path, amount) -> Result<EventBuilder, CliError>` producing kind `KIND_DECISION_LOG` with `["grant", ...]` + one `["task", ...]` per task; content `{"decision":..., "undo_path":..., "category":..., "amount_nano_usd":...}` (omit when `None`); `cmd_log` signs, self-validates with `parse_decision_log`, submits; `cmd_list` queries kind `[44303]` and prints.
  - Both files: `pub async fn dispatch(cmd: GrantsCmd, client: &BuzzClient) -> Result<(), CliError>` matching how `commands/asks.rs::dispatch` is shaped. Register `pub mod grants; pub mod decisions;` in `commands/mod.rs`.

- [ ] **Step 5: Run green**

Run: `. ./bin/activate-hermit && cargo test -p buzz-cli`
Expected: PASS (new tests plus every existing CLI test).

- [ ] **Step 6: Update `docs/nips/NIP-IQ.md`** with the five commands under their kinds' sections.

- [ ] **Step 7: Commit**

```bash
. ./bin/activate-hermit && git add crates/buzz-cli docs/nips/NIP-IQ.md && git commit -s -m "feat(cli): buzz grants and buzz decisions command surfaces"
```

---

### Task 7: Managed agents learn the asks verbs (adoption guidance)

The owner-contact wall is enforced at ingest, but nothing tells a managed agent what to do instead: `crates/buzz-acp/src/base_prompt.md` (the system prompt every managed agent receives) does not mention `buzz asks` at all. An agent that hits the wall with no known alternative stalls silently. This must ship in the same deploy as the relay enforcement, which is why it is in this plan.

**Files:**
- Modify: `crates/buzz-acp/src/base_prompt.md` (command table ~lines 9-22, plus one new section)
- Modify: `crates/buzz-acp/src/company_onboarding_prompt.md` (only if it enumerates CLI command groups; read it first)
- Modify: `AGENTS.md` (the "Agent asks" paragraph ~line 184: add one sentence on `buzz decisions log` and grants)

**Interfaces:**
- Consumes: the exact command surfaces from Task 6 and the existing `buzz asks` verbs (raise, escalate, list, answer, withdraw).

- [ ] **Step 1: Add the table rows** to `base_prompt.md`'s command table, in alphabetical position with the existing rows:

```markdown
| `buzz asks` | `raise`, `escalate`, `list`, `answer`, `withdraw` |
| `buzz decisions` | `log`, `list` |
```

(`buzz grants` is deliberately NOT listed: grants are owner-signed; an agent cannot create one and listing it here would invite doomed attempts.)

- [ ] **Step 2: Add the blocked-agent section** to `base_prompt.md`, after the messaging guidance section (keep it this tight; it is a system prompt and every token recurs on every agent turn):

```markdown
## When you are blocked

If you need something only a human or a higher tier can give (a decision, an answer, a credential, an external unblock), do not message the owner: the relay refuses direct owner contact from worker- and leader-tier agents at ingest. Raise a typed ask one tier up (worker to leader, leader to executive; only the executive addresses the owner) and keep working on whatever is not blocked:

`buzz asks raise --type decision --to <one-tier-up-pubkey> --initiative <id> --task <id> --need <short-slug> --headline "<what you need>" --cost-of-delay "<what waiting costs>"`

Types: `decision`, `question`, `credential`, `blocker`. Check `buzz asks list --mine --open` first: one open ask per need, and a duplicate returns the original ask's id. Unanswered asks auto-promote up the ladder on a deadline, so file once and trust the climb. Never put a secret in an ask or an answer; a credential ask gets you a provisioning confirmation, not the secret itself.

If you hold a delegation grant and decide within it, record the decision: `buzz decisions log --grant <id> --task <id> --category <grant-category> --decision "<what>" --undo-path "<how to undo>"` (add `--amount-nano-usd` when money moves). The relay refuses a category outside your grant.
```

- [ ] **Step 3: Check `company_onboarding_prompt.md`.** Read it. If it enumerates CLI command groups, add the same `buzz asks` row/sentence in its own style; if it does not, change nothing and say so in the task report.

- [ ] **Step 4: Extend `AGENTS.md`'s "Agent asks" paragraph** with one sentence: delegated decisions are recorded with `buzz decisions log` under an owner-signed grant (`buzz grants create`), and the relay enforces the grant's category and cap at ingest.

- [ ] **Step 5: Verify no em-dashes and that the named flags exist**

Run: `. ./bin/activate-hermit && grep -n "—" crates/buzz-acp/src/base_prompt.md crates/buzz-acp/src/company_onboarding_prompt.md AGENTS.md; cargo run -p buzz-cli -- asks raise --help && cargo run -p buzz-cli -- decisions log --help`
Expected: grep finds nothing; both `--help`s show every flag the prompt text names (fix the prompt if a flag name differs; the CLI is the authority).

- [ ] **Step 6: Commit**

```bash
. ./bin/activate-hermit && git add crates/buzz-acp/src/base_prompt.md crates/buzz-acp/src/company_onboarding_prompt.md AGENTS.md && git commit -s -m "docs(acp): teach managed agents the asks and decisions verbs"
```

---

## Final Verification (controller, not a task)

- `. ./bin/activate-hermit && just ci` (full local gate; PRs into develop run no CI).
- All three relay integration files green with `--test-threads=1`.
- `grep -rn "—" $(git diff --name-only origin/develop...HEAD)` finds nothing.
- Every commit has `Signed-off-by`.
