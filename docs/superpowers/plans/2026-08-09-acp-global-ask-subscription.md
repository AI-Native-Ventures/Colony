# ACP Global Ask Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a channel-less Ask (kind 44300, p-tagged at one agent) to the
agent it is addressed to, so a leader is actually woken by an ask and PR #199's
prompt block is reached in production rather than only in unit tests.

**Architecture:** `buzz-acp` today only receives events through per-channel
subscriptions whose REQ always carries `#h`, and only a `ch-<uuid>` subscription
becomes a `BuzzEvent`. A real ask raised without `--channel` has no `h` tag and
is stored with `channel_id = NULL`, so it never arrives. This plan adds a second,
global subscription (`ask-inbox`) filtered on `{kinds:[44300], "#p":[me]}`,
delivers those events on their own inbound queue rather than forcing a fake
channel id onto `BuzzEvent`, and gives them a channel-less turn through a new
`PromptSource::Ask` variant modelled on the existing `PromptSource::Heartbeat`.

**Tech Stack:** Rust, `tokio`, `nostr`, NIP-01 REQ frames, existing `buzz-acp`
subscription and prompt-pool machinery.

## Global Constraints

- Do **not** modify `crates/buzz-relay/src/ask_broker.rs`,
  `crates/buzz-relay/src/interrupt_gate.rs`, or
  `crates/buzz-relay/src/interrupt_runtime.rs`. They are correct and green.
- Do **not** add event kinds. `KIND_ASK` (44300), `KIND_ASK_RESOLUTION` (44301)
  and `KIND_ASK_WITHDRAWAL` (44302) already exist in `crates/buzz-core/src/kind.rs`.
- Do **not** give an ask a synthetic channel id. A `NULL` channel cast to a
  sentinel `Uuid` is the defect this plan exists to remove, not a shortcut
  around it.
- Do **not** relax `author_allowed`. An ask turn goes through the same inbound
  author gate as any other event, with the shipped `respond_to` default.
- No new `unwrap()` or `expect()` in production paths. Use `?` and error types.
- New public API needs doc comments.
- `git commit -s` every time. The DCO check fails any commit without a
  `Signed-off-by` trailer.
- Activate hermit first: `. ./bin/activate-hermit`.
- The host is under load. Run `cargo test -p buzz-acp --lib` and nothing
  heavier. Do not run `just ci` or `just test`.

## The bug this fixes, with evidence

| Fact | Evidence |
| --- | --- |
| `--channel` is optional on `buzz asks raise` | `crates/buzz-cli/src/lib.rs:2573` |
| `build_ask_event` emits `h` only when a channel is given | `crates/buzz-cli/src/commands/asks.rs:116` |
| `parse_ask` never requires `h` | `crates/buzz-core/src/interrupt.rs:447` |
| `KIND_ASK` is in neither `requires_h_channel_scope` nor `is_global_only_kind`, so a no-`h` ask stores with `channel_id = NULL` | `crates/buzz-relay/src/handlers/ingest.rs:789`, `2398` |
| Every harness REQ carries `#h` | `crates/buzz-acp/src/relay.rs:3220` |
| Only a `ch-<uuid>` sub becomes a `BuzzEvent` | `crates/buzz-acp/src/relay.rs:2181` |
| The relay keeps global events out of channel subscriptions | `crates/buzz-relay/src/subscription.rs:325` |
| Task 1's unit test passes only because its fixture adds `h` | `crates/buzz-acp/src/filter.rs:509` |

## File Structure

| File | Responsibility |
| --- | --- |
| `crates/buzz-acp/src/relay.rs` | New `ask-inbox` subscription id, its REQ filter, and routing its events onto a dedicated inbound queue |
| `crates/buzz-acp/src/pool.rs` | New `PromptSource::Ask` variant and the channel-less ask turn |
| `crates/buzz-acp/src/lib.rs` | Startup subscription, author gate, and dispatch of an ask into a turn |
| `crates/buzz-acp/src/ask_context.rs` | Unchanged. Already produces the block; this plan only makes it reachable |

---

## Task 1: A global ask subscription id and its REQ filter

`send_subscribe` at `relay.rs:3202` always inserts `#h`, which is correct for a
channel subscription and fatal for an ask. Asks need their own builder.

**Files:**
- Modify: `crates/buzz-acp/src/relay.rs` (beside `MEMBERSHIP_NOTIF_SUB_ID` at
  line 539, and beside `send_subscribe` at line 3202)
- Test: `crates/buzz-acp/src/relay.rs` (inline `tests` module)

**Interfaces:**
- Consumes: `buzz_core::kind::KIND_ASK`.
- Produces: `const ASK_INBOX_SUB_ID: &str = "ask-inbox";` and
  `pub(crate) fn ask_inbox_req_filter(agent_pubkey_hex: &str, since: Option<u64>) -> serde_json::Value`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/buzz-acp/src/relay.rs`:

```rust
    #[test]
    fn the_ask_inbox_filter_is_global_and_p_tagged() {
        let agent = "a".repeat(64);
        let filter = ask_inbox_req_filter(&agent, None);

        assert_eq!(
            filter["kinds"],
            serde_json::json!([buzz_core::kind::KIND_ASK]),
            "the ask inbox subscribes to asks and nothing else"
        );
        assert_eq!(
            filter["#p"],
            serde_json::json!([agent]),
            "an agent must only be woken by asks addressed to it"
        );
        assert!(
            filter.get("#h").is_none(),
            "an ask carries no h tag when it is raised without a channel, which \
             is the common case; adding #h here reintroduces the bug that no ask \
             ever reaches the harness"
        );
    }

    #[test]
    fn the_ask_inbox_filter_replays_from_since_on_reconnect() {
        let agent = "b".repeat(64);
        let filter = ask_inbox_req_filter(&agent, Some(1_000));
        assert_eq!(
            filter["since"],
            serde_json::json!(1_000 - SINCE_SKEW_SECS),
            "a reconnect must not silently drop an ask raised while disconnected"
        );
    }
```

If `SINCE_SKEW_SECS` is private or named differently, read `send_subscribe`
(`relay.rs:3202`) and mirror exactly what it does with `since`. Do not invent a
different skew.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib relay::tests::the_ask_inbox`

Expected: FAIL, `ask_inbox_req_filter` not found.

- [ ] **Step 3: Write the implementation**

Beside `MEMBERSHIP_NOTIF_SUB_ID` at `relay.rs:539`:

```rust
/// Subscription id for the agent's global Ask inbox.
///
/// Distinct from `ch-<uuid>` channel subscriptions because an Ask is addressed
/// to an *agent*, not to a room. A real ask raised without `--channel` carries
/// no `h` tag and is stored with a NULL channel, so a channel-scoped REQ can
/// never return it.
const ASK_INBOX_SUB_ID: &str = "ask-inbox";
```

Beside `send_subscribe`:

```rust
/// The NIP-01 filter for the global Ask inbox.
///
/// Deliberately carries no `#h`: an ask is agent-addressed and usually has no
/// channel at all. `#p` is what scopes it, and it is mandatory. Without it an
/// agent would be woken by every ask in the community.
pub(crate) fn ask_inbox_req_filter(
    agent_pubkey_hex: &str,
    since: Option<u64>,
) -> serde_json::Value {
    let mut filter = serde_json::Map::new();
    filter.insert("kinds".into(), json!([buzz_core::kind::KIND_ASK]));
    filter.insert("#p".into(), json!([agent_pubkey_hex]));
    match since {
        Some(since) => {
            filter.insert("since".into(), json!(since.saturating_sub(SINCE_SKEW_SECS)));
        }
        None => {
            filter.insert("since".into(), json!(now_secs()));
        }
    }
    serde_json::Value::Object(filter)
}
```

Use whatever `send_subscribe` uses for "now"; if it inlines a
`SystemTime::now()` expression, factor that into a small helper and use it in
both places rather than duplicating it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p buzz-acp --lib relay::tests`

Expected: PASS, including both new tests and every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-acp/src/relay.rs
git commit -s -m "feat(acp): a global, p-tagged REQ filter for the ask inbox"
```

---

## Task 2: Route ask-inbox events onto their own inbound queue

`BuzzEvent.channel_id` is a `Uuid` (`relay.rs:470`). An ask has no channel, and
inventing one is explicitly out of bounds. Asks therefore get their own queue
rather than a widened `BuzzEvent`.

**Files:**
- Modify: `crates/buzz-acp/src/relay.rs` (event dispatch at line 2181, and the
  `HarnessRelay` constructor / accessors)
- Test: `crates/buzz-acp/src/relay.rs` (inline `tests` module)

**Interfaces:**
- Consumes: `ASK_INBOX_SUB_ID`, `ask_inbox_req_filter` (Task 1).
- Produces: `pub async fn subscribe_ask_inbox(&mut self) -> Result<(), RelayError>`
  on `HarnessRelay`, and an inbound receiver of `nostr::Event` reachable the same
  way the existing event receiver is. Name it `ask_events` to mirror the existing
  accessor naming; read the constructor before choosing.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn an_ask_inbox_event_is_not_treated_as_a_channel_event() {
        assert!(
            channel_id_from_sub_id(ASK_INBOX_SUB_ID).is_none(),
            "the ask inbox must never parse as a channel subscription; if it \
             did, the harness would attach a bogus channel id to every ask"
        );
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib relay::tests::an_ask_inbox_event`

Expected: FAIL, `ASK_INBOX_SUB_ID` not found (Task 1 defined it; if Task 1 is
already merged this test compiles and passes immediately, which means it is
guarding the wrong thing. In that case delete it and rely on Step 3's test
instead, and say so in your report rather than keeping a test that cannot fail).

- [ ] **Step 3: Write the implementation**

In the EVENT dispatch at `relay.rs:2181`, add a branch **before** the
`channel_id_from_sub_id` branch:

```rust
} else if subscription_id == ASK_INBOX_SUB_ID {
    // An ask has no channel, so it never becomes a `BuzzEvent`. It rides its
    // own queue and is turned into a channel-less prompt by the main loop.
    let event_id_hex = event.id.to_hex();
    if state.seen_ids.insert(event_id_hex.clone()) {
        if ask_tx.try_send(*event).is_err() {
            state.seen_ids.remove(&event_id_hex);
            state.proactive_resubscribe_needed = true;
            warn!("ask dropped (backpressure): proactive resubscribe queued");
        }
    }
}
```

Mirror the membership branch above it for dedupe and backpressure handling
exactly; read `relay.rs:2140-2180` and follow it rather than the sketch above
where they differ. Add `subscribe_ask_inbox` next to `subscribe_channel`
(`relay.rs:777`), sending the REQ built by `ask_inbox_req_filter` under
`ASK_INBOX_SUB_ID`, and re-send it from `resubscribe_after_reconnect` with the
last-seen timestamp, exactly as channel subscriptions are re-sent.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p buzz-acp --lib`

Expected: PASS, whole lib.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-acp/src/relay.rs
git commit -s -m "feat(acp): deliver ask-inbox events on their own inbound queue"
```

---

## Task 3: A channel-less ask turn

`PromptSource` (`pool.rs:266`) is already `Channel(Uuid) | Heartbeat`, so a
turn with no channel is a shape the pool already supports. An ask is a third
source.

**Files:**
- Modify: `crates/buzz-acp/src/pool.rs:266` and every `match` on `PromptSource`
- Test: `crates/buzz-acp/src/pool.rs` (inline `tests` module)

**Interfaces:**
- Consumes: `nostr::Event`.
- Produces: `PromptSource::Ask { ask_event_id: String }`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn an_ask_turn_has_no_channel_to_reply_into() {
        let source = PromptSource::Ask {
            ask_event_id: "abc123".into(),
        };
        assert_eq!(
            prompt_source_channel(&source),
            None,
            "an ask is agent-addressed and has no channel; posting a reply into \
             one would leak it to that channel's members"
        );
        assert_eq!(prompt_source_label(&source), "ask");
    }
```

Read `pool.rs:1510`, `1725`, `1735`, `1747` and `3419` first: those are the
existing sites that map a `PromptSource` to an optional channel and to a label.
If they are inline `match` arms rather than named helpers, extract
`prompt_source_channel` and `prompt_source_label` as part of this task and route
every existing site through them, so the ask arm cannot be forgotten at one of
them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib pool::tests::an_ask_turn`

Expected: FAIL, `PromptSource::Ask` not found.

- [ ] **Step 3: Write the implementation**

```rust
pub enum PromptSource {
    Channel(Uuid),
    Heartbeat,
    /// A turn woken by an Ask addressed to this agent.
    ///
    /// Carries no channel: an ask is addressed to an agent, and a real ask
    /// raised without `--channel` has no `h` tag at all. The agent answers by
    /// running `buzz asks answer` with the id from its `<colony-ask>` block,
    /// not by posting into a room.
    Ask { ask_event_id: String },
}
```

Then add the `Ask` arm at every `match` site the compiler names. For each, the
ask behaves like `Heartbeat` (no channel) except where the site is producing a
human-facing label, where it is `"ask"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p buzz-acp --lib pool`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-acp/src/pool.rs
git commit -s -m "feat(acp): a channel-less prompt source for an addressed ask"
```

---

## Task 4: Build the ask turn's prompt from the ask event

`run_prompt_task` currently derives the ask block from
`batch.events.iter().rev()` (`pool.rs:2037`). An ask turn has no `FlushBatch`,
so the block has to come from the event itself.

**Files:**
- Modify: `crates/buzz-acp/src/pool.rs:1494` (`run_prompt_task`) and `:2037`
- Test: `crates/buzz-acp/src/pool.rs` (inline `tests` module)

**Interfaces:**
- Consumes: `crate::ask_context::read_incoming_ask`,
  `crate::ask_context::ask_context_section`, `PromptSource::Ask` (Task 3).
- Produces: no new public API.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn an_ask_turn_prompt_carries_the_block_with_no_batch() {
        let filer = nostr::Keys::generate();
        let audience = nostr::Keys::generate();
        let event = nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_ASK as u16),
            r#"{"headline":"Which vendor for SMS?","cost_of_delay":"onboarding is blocked"}"#,
        )
        .tags([
            nostr::Tag::public_key(audience.public_key()),
            nostr::Tag::parse(["ask-type", "decision"]).unwrap(),
            nostr::Tag::parse(["task", "task-7"]).unwrap(),
        ])
        .sign_with_keys(&filer)
        .unwrap();

        let prompt = ask_turn_prompt(&event).expect("an ask event must build a turn prompt");

        assert!(prompt.contains("<colony-ask>"));
        assert!(
            prompt.contains(&event.id.to_hex()),
            "without the id the agent cannot answer, and the ask times out onto \
             the founder"
        );
        assert!(prompt.contains("decision"), "the type comes from the ask-type tag");
        assert!(prompt.contains("task-7"), "the task comes from the task tag");
    }

    #[test]
    fn a_malformed_ask_builds_no_turn_rather_than_an_empty_one() {
        let filer = nostr::Keys::generate();
        let event = nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_ASK as u16),
            "{not json",
        )
        .sign_with_keys(&filer)
        .unwrap();
        assert!(ask_turn_prompt(&event).is_none());
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib pool::tests::an_ask_turn_prompt`

Expected: FAIL, `ask_turn_prompt` not found.

- [ ] **Step 3: Write the implementation**

```rust
/// The prompt text for a turn woken by an Ask.
///
/// Returns `None` when the event is not a usable ask, so a malformed ask is
/// dropped rather than firing an empty turn that burns a model call and tells
/// the agent nothing.
pub(crate) fn ask_turn_prompt(event: &nostr::Event) -> Option<String> {
    let ask = crate::ask_context::read_incoming_ask(event)?;
    Some(crate::ask_context::ask_context_section(&ask))
}
```

Then, in `run_prompt_task`, take the existing `ask_section` derivation at
`pool.rs:2037` and make it handle both shapes: for a `FlushBatch` keep the
reverse scan added by PR #199; for `PromptSource::Ask` use `ask_turn_prompt` on
the ask event. Do not restructure the surrounding prompt assembly; the ask block
keeps its existing position ahead of the work-context section.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p buzz-acp --lib`

Expected: PASS, whole lib.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-acp/src/pool.rs
git commit -s -m "feat(acp): build an ask turn's prompt from the ask event"
```

---

## Task 5: Subscribe at startup and fire the turn

**Files:**
- Modify: `crates/buzz-acp/src/lib.rs:1627` (subscription setup) and the main
  event loop beside `:2399`
- Test: `crates/buzz-acp/src/lib.rs` (inline `tests` module)

**Interfaces:**
- Consumes: `subscribe_ask_inbox` (Task 2), `PromptSource::Ask` (Task 3),
  `ask_turn_prompt` (Task 4), existing `author_allowed` (`lib.rs:271`).
- Produces: no new public API.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn the_ask_inbox_is_subscribed_even_with_no_channels() {
        assert!(
            should_subscribe_ask_inbox(&[]),
            "an agent with no channel memberships must still receive asks \
             addressed to it; asks are agent-addressed, not room-addressed"
        );
    }

    #[test]
    fn the_ask_inbox_is_skipped_when_asks_are_not_subscribed() {
        let kinds = vec![buzz_core::kind::KIND_STREAM_MESSAGE];
        assert!(
            !should_subscribe_ask_inbox_for_kinds(&kinds),
            "an operator who overrode kinds to exclude asks must not be woken \
             by them through a side door"
        );
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib the_ask_inbox_is`

Expected: FAIL, helpers not found.

- [ ] **Step 3: Write the implementation**

```rust
/// Whether to open the global ask inbox.
///
/// Independent of channel membership: an ask is addressed to an agent, so an
/// agent in zero channels must still receive one. This is the whole reason the
/// inbox exists separately from channel subscriptions.
fn should_subscribe_ask_inbox(_channel_ids: &[uuid::Uuid]) -> bool {
    true
}

/// Whether the configured kind set includes asks.
fn should_subscribe_ask_inbox_for_kinds(kinds: &[u32]) -> bool {
    kinds.contains(&buzz_core::kind::KIND_ASK)
}
```

At `lib.rs:1627`, after channel discovery and subscription, call
`relay.subscribe_ask_inbox()` when `should_subscribe_ask_inbox_for_kinds` holds
for the resolved rule kinds. In the main loop, add a branch for the ask receiver
that:

1. Runs the same `author_allowed` gate the channel path runs at `lib.rs:2367`,
   with `is_dm = false` (an ask is not a DM). Do not skip it and do not weaken
   `respond_to`.
2. Drops the event when `ask_turn_prompt` returns `None`.
3. Enqueues a turn with `PromptSource::Ask { ask_event_id: event.id.to_hex() }`
   and that prompt text.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p buzz-acp`

Expected: PASS, whole crate.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-acp/src/lib.rs
git commit -s -m "feat(acp): subscribe to the ask inbox and fire a turn on an ask"
```

---

## Task 6: A regression test that a channel-less ask is deliverable

The defect this plan fixes was invisible because every existing fixture gave its
ask an `h` tag. This task makes that impossible to reintroduce.

**Files:**
- Modify: `crates/buzz-acp/src/filter.rs` (inline `tests` module)

**Interfaces:**
- Consumes: `ask_inbox_req_filter` (Task 1).
- Produces: no new API.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_real_ask_has_no_h_tag_and_so_needs_the_global_inbox() {
        let audience = nostr::Keys::generate();
        let filer = nostr::Keys::generate();

        // Exactly what `buzz asks raise` produces without `--channel`: the
        // common case, and the one no fixture covered before.
        let ask = nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_ASK as u16),
            r#"{"headline":"Which vendor?","cost_of_delay":"blocked"}"#,
        )
        .tags([
            nostr::Tag::public_key(audience.public_key()),
            nostr::Tag::parse(["ask-type", "decision"]).unwrap(),
            nostr::Tag::parse(["task", "task-7"]).unwrap(),
        ])
        .sign_with_keys(&filer)
        .unwrap();

        assert!(
            !ask.tags.iter().any(|t| t.as_slice().first().map(String::as_str) == Some("h")),
            "guard: this fixture must stay channel-less, or it stops \
             representing a real ask"
        );

        let filter = crate::relay::ask_inbox_req_filter(&audience.public_key().to_hex(), None);
        assert!(
            filter.get("#h").is_none(),
            "a channel-scoped filter can never return this ask; that was the bug"
        );
    }
```

Make `ask_inbox_req_filter` reachable from `filter.rs` (it is `pub(crate)`), or
move the test into `relay.rs` if module visibility makes that awkward. Do not
widen the function's visibility beyond the crate.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib a_real_ask_has_no_h_tag`

Expected: FAIL before Task 1 exists. If Tasks 1 to 5 are already merged, this
test passes on its first run. That is acceptable **only** for this task, because
it is an explicit regression guard rather than a driver. Say so in your report;
do not pretend it was red.

- [ ] **Step 3: Run the whole crate**

Run: `cargo test -p buzz-acp`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/buzz-acp/src/filter.rs
git commit -s -m "test(acp): guard that a real channel-less ask needs the global inbox"
```

---

## Self-review

**Coverage.** Global REQ with no `#h`: Task 1. Delivery without a fake channel
id: Task 2. A turn with no channel: Task 3. The block on that turn: Task 4.
Startup wiring plus the unchanged author gate: Task 5. A guard against the
fixture blindness that hid the bug: Task 6.

**Deliberately not covered.** Making `h` mandatory on asks. That was the other
option the review left open, and it is rejected: the relay stores asks globally,
`useOpenAsks.ts:60` queries them globally by `#p`, and `e2e_ask_chain` files them
with `channel: None` deliberately. Every consumer except the harness already
treats an ask as agent-addressed, so the harness is what changes. Forcing a
channel would also leak each ask to that channel's members and make a filer
invent a channel for task work that has none.

**Type consistency.** `PromptSource::Ask { ask_event_id: String }` is used
identically in Tasks 3, 4 and 5. `ask_inbox_req_filter` has one signature across
Tasks 1, 2 and 6. `ask_turn_prompt` returns `Option<String>` in Tasks 4 and 5.

**Known risk.** Task 3 touches every `match` on `PromptSource`, which the
compiler enumerates. If any site handles `Heartbeat` with a wildcard `_` arm
rather than an explicit match, the ask arm will be silently swallowed there.
Grep for `PromptSource` before starting Task 3 and report any wildcard arms
rather than assuming exhaustiveness protects you.
