# Ask Chain Absorption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ask chain absorb. A worker's ask reaches its leader, the
leader answers it, and the owner never sees it. Then give the owner one place to
see and answer what still climbs.

**Architecture:** The relay half is already built and green in CI: altitude
ladder, ingest refusal, dedupe, deadline sweep, receipts. The missing half is
delivery. `crates/buzz-acp`, `crates/buzz-agent`, and `crates/sprig` contain
**zero** references to `KIND_ASK` or `44300`, so an agent is never told an ask is
waiting for it, never answers one, and every ask times out and climbs to the
owner. The fix reuses machinery that already exists: `SubscriptionRule` already
supports `require_mention`, documented as "the event must contain a `p` tag
referencing the agent pubkey", and an ask p-tags its audience. So delivery is
adding `KIND_ASK` to the subscribed kinds plus a prompt block that names the ask.
The owner surface reuses the existing Home inbox, which already has a
`needs_action` filter and an `isActionRequired` flag on `InboxItem`.

**Tech Stack:** Rust (buzz-acp, buzz-core, buzz-test-client), React 19 +
TypeScript (desktop), `node --test`, Playwright.

## Global Constraints

- Relay-side ask protocol is **not** in scope. `ask_broker.rs`,
  `interrupt_gate.rs`, and `interrupt_runtime.rs` are working and proven. Do not
  modify them unless a task says to.
- Event kinds live in `crates/buzz-core/src/kind.rs`. `KIND_ASK` (44300),
  `KIND_ASK_RESOLUTION` (44301), and `KIND_ASK_WITHDRAWAL` (44302) already exist
  there. Do not add new kinds.
- Desktop kind constants live in `desktop/src/shared/constants/kinds.ts` and must
  stay in sync with `mobile/lib/shared/relay/nostr_models.dart`.
- No new `unwrap()` or `expect()` in production paths. Use `?` and error types.
- New public API needs doc comments.
- Rem-based Tailwind tokens only. `pnpm check:px-text` fails on px or arbitrary
  rem text literals.
- Any new desktop module-level store goes into `resetCommunityState()` in
  `desktop/src/features/communities/useCommunityInit.ts`.
- `git commit -s` every time. DCO fails otherwise.
- Integration tests need Postgres and Redis: `just test`.
- Activate hermit first: `. ./bin/activate-hermit`.

## The acceptance gate

Task 4 is the gate this whole plan exists for:

> A worker files an ask. The leader answers it. The owner's Needs-Me query
> returns empty.

Today three E2E tests exist and all three are named `..._reaches_the_owner`.
There is no test where the chain absorbs. Until Task 4 passes, nobody can claim
the chain works, including this plan.

## Out of scope

| Deferred | Why |
| --- | --- |
| Changing the thread-scoped exemption in `interrupt_gate.rs` | Separate decision. An agent replying inside an owner-started thread is intended behaviour; whether *questions* should be excluded from that exemption is a product call, not an implementation detail. Raise it after this lands. |
| Mobile ask UI | Desktop first; mobile mirrors it once the shape is settled |
| Auto-answering asks with an LLM without agent involvement | The point is that a superior agent answers, not that the relay guesses |
| Grants and decision logging | Already built (`buzz grants`, `buzz decisions`) |

---

## Task 1: Deliver asks to the agent they are addressed to

**Files:**
- Modify: `crates/buzz-acp/src/config.rs:580` (`default_channel_kinds`)
- Test: `crates/buzz-acp/src/filter.rs` (inline tests)

**Interfaces:**
- Consumes: `buzz_core::kind::KIND_ASK`, existing `SubscriptionRule::match_event`.
- Produces: no new API. `default_channel_kinds()` gains `KIND_ASK`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/buzz-acp/src/filter.rs`:

```rust
    #[test]
    fn an_ask_addressed_to_this_agent_matches_the_mentions_rule() {
        let agent = nostr::Keys::generate();
        let filer = nostr::Keys::generate();
        let channel = uuid::Uuid::new_v4();
        let rule = SubscriptionRule {
            name: "mentions".into(),
            channels: ChannelScope::All("all".into()),
            kinds: crate::config::default_channel_kinds(),
            require_mention: true,
            ..SubscriptionRule::default()
        };

        let ask = nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_ASK as u16),
            "{\"headline\":\"which vendor?\"}",
        )
        .tags([
            nostr::Tag::public_key(agent.public_key()),
            nostr::Tag::parse(["h", &channel.to_string()]).unwrap(),
        ])
        .sign_with_keys(&filer)
        .unwrap();

        assert!(
            rule.match_event(&ask, &agent.public_key(), channel).is_some(),
            "an ask p-tagging this agent must wake it; without this no leader \
             ever answers and every ask climbs to the owner on a timer"
        );
    }

    #[test]
    fn an_ask_addressed_to_someone_else_does_not_match() {
        let agent = nostr::Keys::generate();
        let other = nostr::Keys::generate();
        let filer = nostr::Keys::generate();
        let channel = uuid::Uuid::new_v4();
        let rule = SubscriptionRule {
            name: "mentions".into(),
            channels: ChannelScope::All("all".into()),
            kinds: crate::config::default_channel_kinds(),
            require_mention: true,
            ..SubscriptionRule::default()
        };

        let ask = nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_ASK as u16),
            "{\"headline\":\"which vendor?\"}",
        )
        .tags([
            nostr::Tag::public_key(other.public_key()),
            nostr::Tag::parse(["h", &channel.to_string()]).unwrap(),
        ])
        .sign_with_keys(&filer)
        .unwrap();

        assert!(
            rule.match_event(&ask, &agent.public_key(), channel).is_none(),
            "an agent must never see an ask addressed to a different agent"
        );
    }

    #[test]
    fn ask_kinds_are_in_the_default_channel_kinds() {
        let kinds = crate::config::default_channel_kinds();
        assert!(
            kinds.contains(&buzz_core::kind::KIND_ASK),
            "KIND_ASK missing: the harness cannot deliver what it never subscribes to"
        );
    }
```

If `SubscriptionRule::match_event` has a different signature than
`(&event, &agent_pubkey, channel_id)`, read it first and adapt the call. Do not
change the function's signature.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib filter::tests::ask`

Expected: FAIL on `ask_kinds_are_in_the_default_channel_kinds` and on the
addressed-ask match, because `KIND_ASK` is not in the kind list.

- [ ] **Step 3: Add the kind**

In `crates/buzz-acp/src/config.rs`:

```rust
/// Kinds a channel subscription carries when the agent config does not
/// override them.
///
/// `KIND_ASK` is here because an ask p-tags the agent it is addressed to, and
/// `SubscriptionRule::require_mention` already means "this event p-tags me".
/// Without it a leader is never told an ask is waiting, so no ask is ever
/// answered below the owner and the deadline sweep promotes every one of them
/// to the founder. That is the whole failure this kind fixes.
pub fn default_channel_kinds() -> Vec<u32> {
    vec![
        buzz_core::kind::KIND_STREAM_MESSAGE,
        buzz_core::kind::KIND_BLOCK_ACTION,
        buzz_core::kind::KIND_WORKFLOW_APPROVAL_REQUESTED,
        buzz_core::kind::KIND_STREAM_REMINDER,
        buzz_core::kind::KIND_ASK,
    ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p buzz-acp --lib filter::tests`

Expected: PASS, including the three new tests and every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-acp/src/config.rs crates/buzz-acp/src/filter.rs
git commit -s -m "feat(acp): deliver asks to the agent they are addressed to"
```

---

## Task 2: Render the ask in the agent's prompt

An ask arriving as a raw JSON event body is not actionable. The agent needs the
ask id (to answer it), the type, the headline, and the cost of delay. Mirrors
`work_context_section` in `crates/buzz-acp/src/work_context.rs:409`.

**Files:**
- Create: `crates/buzz-acp/src/ask_context.rs`
- Modify: `crates/buzz-acp/src/lib.rs` (module declaration)

**Interfaces:**
- Consumes: `nostr::Event`, `buzz_core::interrupt::parse_ask`.
- Produces: `pub struct IncomingAsk { pub id: String, pub ask_type: String, pub headline: String, pub cost_of_delay: Option<String>, pub task_id: Option<String> }`,
  `pub fn read_incoming_ask(event: &Event) -> Option<IncomingAsk>`,
  `pub fn ask_context_section(ask: &IncomingAsk) -> String`.

- [ ] **Step 1: Write the failing test**

Create `crates/buzz-acp/src/ask_context.rs` containing only:

```rust
//! Render an incoming Ask into the block an agent acts on.

#[cfg(test)]
mod tests {
    use super::*;

    fn ask_event(content: &str) -> nostr::Event {
        let filer = nostr::Keys::generate();
        nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_ASK as u16),
            content,
        )
        .sign_with_keys(&filer)
        .unwrap()
    }

    #[test]
    fn a_well_formed_ask_reads_its_fields() {
        let event = ask_event(
            r#"{"type":"decision","headline":"Which vendor for SMS?","cost_of_delay":"onboarding is blocked","task":"task-7"}"#,
        );
        let ask = read_incoming_ask(&event).expect("should parse");
        assert_eq!(ask.id, event.id.to_hex());
        assert_eq!(ask.ask_type, "decision");
        assert_eq!(ask.headline, "Which vendor for SMS?");
        assert_eq!(ask.cost_of_delay.as_deref(), Some("onboarding is blocked"));
        assert_eq!(ask.task_id.as_deref(), Some("task-7"));
    }

    #[test]
    fn an_ask_missing_optional_fields_still_reads() {
        let ask = read_incoming_ask(&ask_event(
            r#"{"type":"question","headline":"Is staging expected to be down?"}"#,
        ))
        .expect("should parse");
        assert_eq!(ask.cost_of_delay, None);
        assert_eq!(ask.task_id, None);
    }

    #[test]
    fn a_non_ask_event_reads_as_none() {
        let filer = nostr::Keys::generate();
        let message = nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_STREAM_MESSAGE as u16),
            "hello",
        )
        .sign_with_keys(&filer)
        .unwrap();
        assert!(read_incoming_ask(&message).is_none());
    }

    #[test]
    fn malformed_ask_content_reads_as_none_rather_than_panicking() {
        assert!(read_incoming_ask(&ask_event("{not json")).is_none());
        assert!(read_incoming_ask(&ask_event("{}")).is_none());
    }

    #[test]
    fn the_section_names_the_id_and_the_answer_command() {
        let ask = IncomingAsk {
            id: "abc123".into(),
            ask_type: "decision".into(),
            headline: "Which vendor for SMS?".into(),
            cost_of_delay: Some("onboarding is blocked".into()),
            task_id: Some("task-7".into()),
        };
        let section = ask_context_section(&ask);
        assert!(section.contains("<colony-ask>"));
        assert!(section.contains("</colony-ask>"));
        assert!(section.contains("abc123"), "the agent cannot answer without the id");
        assert!(section.contains("Which vendor for SMS?"));
        assert!(section.contains("onboarding is blocked"));
        assert!(
            section.contains("buzz asks answer"),
            "the block must name the command that closes the ask"
        );
        assert!(
            section.contains("buzz asks escalate"),
            "an agent that cannot answer must be told the escalation path, \
             otherwise it stalls and the deadline sweep sends it to the owner"
        );
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib ask_context`

Expected: FAIL, `IncomingAsk` / `read_incoming_ask` / `ask_context_section` not
found. Add `pub mod ask_context;` to `crates/buzz-acp/src/lib.rs` first if the
module is not compiled at all.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/buzz-acp/src/ask_context.rs`:

```rust
use nostr::Event;

/// An Ask (kind 44300) addressed to this agent, reduced to what the agent
/// needs in order to act.
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingAsk {
    /// Event id, hex. This is what `buzz asks answer --ask` takes.
    pub id: String,
    /// `decision`, `question`, `credential`, or `blocker`.
    pub ask_type: String,
    /// One-line statement of what is needed.
    pub headline: String,
    /// What waiting costs, when the filer stated it.
    pub cost_of_delay: Option<String>,
    /// The task the filer is blocked on, when the ask names one.
    pub task_id: Option<String>,
}

/// Read an incoming Ask off an event, or `None` when the event is not an ask
/// or its content is unusable.
///
/// Never returns an error: an agent handed a malformed ask should carry on
/// with the rest of its turn rather than fail it.
pub fn read_incoming_ask(event: &Event) -> Option<IncomingAsk> {
    if event.kind.as_u16() as u32 != buzz_core::kind::KIND_ASK {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&event.content).ok()?;
    let headline = value
        .get("headline")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())?;
    let ask_type = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("question");
    Some(IncomingAsk {
        id: event.id.to_hex(),
        ask_type: ask_type.to_string(),
        headline: headline.to_string(),
        cost_of_delay: value
            .get("cost_of_delay")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        task_id: value
            .get("task")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// The prompt block for an ask this agent must answer.
///
/// Shaped like [`crate::work_context::work_context_section`]: identifiers the
/// agent has to pass verbatim to a CLI command, and an instruction that names
/// both the answer path and the escalation path. Naming only the answer path
/// leaves an agent that genuinely cannot decide with no move except silence,
/// and silence is what the deadline sweep turns into a founder interrupt.
pub fn ask_context_section(ask: &IncomingAsk) -> String {
    let cost = ask.cost_of_delay.as_deref().unwrap_or("not stated");
    let task = ask.task_id.as_deref().unwrap_or("none");
    format!(
        "<colony-ask>\n\
         Ask id: {id}\n\
         Type: {ask_type}\n\
         Headline: {headline}\n\
         Cost of delay: {cost}\n\
         Task id: {task}\n\
         </colony-ask>\n\
         Someone below you is blocked on this and is waiting. Answer it if you \
         can decide it, using the ask id verbatim:\n\
         `buzz asks answer --ask {id} --answer-json '{{\"decision\":\"<what you \
         decided>\",\"rationale\":\"<why>\"}}'`\n\
         If it genuinely needs a tier above you, escalate instead of going \
         silent:\n\
         `buzz asks escalate --prior {id} --type {ask_type} --to \
         <one-tier-up-pubkey> --task {task} --need <short-slug> --headline \
         \"<what you need>\" --cost-of-delay \"{cost}\"`\n\
         Doing neither is the worst option: an unanswered ask times out and \
         lands on the founder, which is exactly what this chain exists to \
         prevent. Never put a secret in an answer.",
        id = ask.id,
        ask_type = ask.ask_type,
        headline = ask.headline,
        cost = cost,
        task = task,
    )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p buzz-acp --lib ask_context`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-acp/src/ask_context.rs crates/buzz-acp/src/lib.rs
git commit -s -m "feat(acp): render an incoming ask into an actionable prompt block"
```

---

## Task 3: Attach the ask block to the turn

**Files:**
- Modify: `crates/buzz-acp/src/lib.rs` around line 2387, where `prompt_tag` is
  resolved from the matched rule.
- Modify: `crates/buzz-acp/src/base_prompt.md`

**Interfaces:**
- Consumes: `read_incoming_ask`, `ask_context_section` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Read the prompt assembly**

Run: `sed -n '2370,2430p' crates/buzz-acp/src/lib.rs`

Find where the matched event's prompt text is built and where
`work_context_section` is appended for ordinary work. The ask block goes in the
same place, on the same event.

- [ ] **Step 2: Write the failing test**

Add to the `tests` module in `crates/buzz-acp/src/lib.rs`:

```rust
    #[test]
    fn an_ask_event_carries_its_ask_block_into_the_turn() {
        let filer = nostr::Keys::generate();
        let event = nostr::EventBuilder::new(
            nostr::Kind::from(buzz_core::kind::KIND_ASK as u16),
            r#"{"type":"decision","headline":"Which vendor for SMS?","cost_of_delay":"onboarding is blocked"}"#,
        )
        .sign_with_keys(&filer)
        .unwrap();

        let ask = crate::ask_context::read_incoming_ask(&event)
            .expect("an ask event must read as an ask");
        let section = crate::ask_context::ask_context_section(&ask);

        assert!(
            section.contains(&event.id.to_hex()),
            "the turn must carry the ask id or the agent cannot answer it"
        );
    }

    #[test]
    fn base_prompt_tells_an_agent_what_to_do_with_a_received_ask() {
        assert!(
            BASE_PROMPT.contains("<colony-ask>"),
            "the prompt must explain the block the agent will receive"
        );
        assert!(
            BASE_PROMPT.contains("buzz asks answer"),
            "an agent told only how to raise asks will never answer one"
        );
    }
```

If `BASE_PROMPT` is not in scope in `lib.rs`, import it the same way
`work_context.rs:1203` does.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p buzz-acp --lib base_prompt_tells_an_agent`

Expected: FAIL, `BASE_PROMPT` does not contain `<colony-ask>`.

- [ ] **Step 4: Add the base prompt section**

In `crates/buzz-acp/src/base_prompt.md`, immediately after the paragraph that
begins "If you need something only a human or a higher tier can give", add:

```markdown
### When an ask is addressed to you

If your turn opens with a `<colony-ask>` block, someone below you is blocked and
is waiting on you. This is the most time-sensitive work you will get: they
cannot proceed until you answer.

Answer it if it is yours to decide:

`buzz asks answer --ask <ask-id> --answer-json '{"decision":"<what you decided>","rationale":"<why>"}'`

Escalate it if it genuinely needs a tier above you:

`buzz asks escalate --prior <ask-id> --type <type> --to <one-tier-up-pubkey> --task <task-id> --need <short-slug> --headline "<what you need>" --cost-of-delay "<what waiting costs>"`

Do one or the other in the same turn. Doing neither is the worst outcome: an
unanswered ask times out and lands on the founder, which is the exact thing this
ladder exists to prevent. Answering something you were not asked, or inventing an
authority you do not hold, is worse than escalating. Never put a secret in an
answer; a credential ask gets a provisioning confirmation, not the secret.
```

- [ ] **Step 5: Wire the block into the turn**

At the site found in Step 1, when the matched event is an ask, prepend the ask
section to the prompt text:

```rust
let ask_section = crate::ask_context::read_incoming_ask(&event)
    .map(|ask| crate::ask_context::ask_context_section(&ask));
```

and include `ask_section` ahead of the work-context section in the assembled
prompt. Follow whatever string assembly the surrounding code already uses; do
not restructure it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p buzz-acp`

Expected: PASS, whole crate.

- [ ] **Step 7: Commit**

```bash
git add crates/buzz-acp/src/lib.rs crates/buzz-acp/src/base_prompt.md
git commit -s -m "feat(acp): tell an agent how to answer an ask addressed to it"
```

---

## Task 4: The absorption gate

The test this plan exists for. Model it on the three existing cases in
`crates/buzz-test-client/tests/e2e_ask_chain.rs`, reusing `employ_ladder`,
`publish_role_head`, `asks_addressed_to`, and `closures_naming` verbatim.

**Files:**
- Modify: `crates/buzz-test-client/tests/e2e_ask_chain.rs`
- Modify: `.github/workflows/ci.yml` if the new test needs naming explicitly
  (the existing line runs the whole `e2e_ask_chain` target, so most likely not)

**Interfaces:**
- Consumes: the existing fixtures in that file.
- Produces: `a_leader_answers_a_workers_ask_and_the_owner_never_sees_it`.

- [ ] **Step 1: Write the failing test**

Append to `crates/buzz-test-client/tests/e2e_ask_chain.rs`:

```rust
/// The gate the whole ask chain exists to pass: a worker files, the leader
/// answers, and the owner's Needs-Me query stays empty.
///
/// Every other test in this file asserts an ask *reaches* the owner. That is
/// the failure mode, not the feature. Before this test existed, no CI run had
/// ever proven that an ask can be absorbed below the founder, and in fact none
/// could be: the ACP harness never subscribed to kind 44300, so no leader was
/// ever told an ask was waiting and the deadline sweep promoted all of them.
#[tokio::test]
#[ignore = "requires a running relay and Postgres"]
async fn a_leader_answers_a_workers_ask_and_the_owner_never_sees_it() {
    let community_id = ensure_test_community(&relay_host()).await;

    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    employ_ladder(community_id, &owner, &worker, &leader, &executive).await;

    let before = asks_addressed_to(&owner).await.len();

    // The worker files one tier up, to its leader. Not to the owner.
    let ask_id = raise_ask(&worker, &leader, "sms-vendor").await;

    let addressed_to_leader = asks_addressed_to(&leader).await;
    assert!(
        addressed_to_leader
            .iter()
            .any(|ask| ask["id"] == serde_json::json!(ask_id)),
        "the leader must be able to see the ask addressed to it"
    );

    // The leader answers. This is the step that did not exist before.
    answer_ask(&leader, &ask_id, "Use Twilio; we already hold the account").await;

    let closures = closures_naming(&owner, &[ask_id.clone()]).await;
    assert_eq!(
        closures.len(),
        1,
        "answering must produce exactly one closure event for the ask"
    );

    let after = asks_addressed_to(&owner).await;
    assert_eq!(
        after.len(),
        before,
        "the owner's Needs-Me surface must be unchanged: an ask a leader \
         answered must never appear in front of the founder. Got {} asks, \
         expected {before}",
        after.len()
    );
}
```

Add the two helpers this needs, beside the existing fixtures:

```rust
/// File an ask from `filer`, addressed to `audience`, for `need`.
async fn raise_ask(filer: &Keys, audience: &Keys, need: &str) -> String {
    let content = serde_json::json!({
        "type": "decision",
        "headline": format!("decide {need}"),
        "cost_of_delay": "the filer is blocked",
        "need": need,
    })
    .to_string();
    let ask = EventBuilder::new(Kind::from(KIND_ASK as u16), content)
        .tags([Tag::public_key(audience.public_key())])
        .sign_with_keys(filer)
        .expect("sign ask");
    let ok = publish(&ask).await;
    assert!(ok.accepted, "ask rejected: {}", ok.message);
    ask.id.to_hex()
}

/// Answer an open ask as `answerer`.
async fn answer_ask(answerer: &Keys, ask_id: &str, decision: &str) {
    let content = serde_json::json!({
        "decision": decision,
        "rationale": "within this tier's authority",
    })
    .to_string();
    let resolution = EventBuilder::new(Kind::from(KIND_ASK_RESOLUTION as u16), content)
        .tags([Tag::parse(["e", ask_id]).expect("e tag")])
        .sign_with_keys(answerer)
        .expect("sign resolution");
    let ok = publish(&resolution).await;
    assert!(ok.accepted, "resolution rejected: {}", ok.message);
}
```

Read the existing tests before writing these: if `raise_ask` needs `--task` and
`--initiative` tags to satisfy `parse_ask`, copy exactly how the existing tests
build them. Do not weaken the ask shape to make the test pass.

- [ ] **Step 2: Run the test to verify it fails**

```bash
just relay &   # or the CI's relay provisioning steps
cargo test -p buzz-test-client --test e2e_ask_chain -- --ignored --nocapture \
  --test-threads 1 a_leader_answers
```

Expected: FAIL. Record which assertion fails and why, because that failure is
the evidence the chain was broken. If it fails at "the leader must be able to
see the ask", Task 1 is not deployed to the relay under test. If it fails at the
final assertion, the answer path is not closing the ask.

- [ ] **Step 3: Make it pass**

Fix whatever the failure names. Do not change the final assertion: an answered
ask reaching the owner is the bug, not the test.

- [ ] **Step 4: Run the whole suite**

```bash
cargo test -p buzz-test-client --test e2e_ask_chain -- --ignored --nocapture --test-threads 1
```

Expected: PASS, 4 tests. `--test-threads 1` is required: these cases share the
relay's own community and seed employees in it.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-test-client/tests/e2e_ask_chain.rs
git commit -s -m "test(interrupts): prove a leader absorbs an ask before the owner sees it"
```

---

## Task 5: Desktop ask kinds and query hook

**Files:**
- Modify: `desktop/src/shared/constants/kinds.ts`
- Create: `desktop/src/features/asks/lib/askEvent.ts`
- Test: `desktop/src/features/asks/lib/askEvent.test.mjs`
- Create: `desktop/src/features/asks/useOpenAsks.ts`

**Interfaces:**
- Consumes: the relay query path used elsewhere in desktop (find with
  `grep -rn "kinds:" desktop/src/shared/api/`).
- Produces: `KIND_ASK`, `KIND_ASK_RESOLUTION`, `KIND_ASK_WITHDRAWAL`,
  `type OpenAsk = { id: string; askType: string; headline: string; costOfDelay: string | null; filerPubkey: string; createdAt: number }`,
  `readAsk(event: NostrEvent): OpenAsk | null`,
  `selectOpenAsks(asks: OpenAsk[], closureEventIds: string[]): OpenAsk[]`,
  `useOpenAsks(): { asks: OpenAsk[]; isLoading: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/asks/lib/askEvent.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

const { readAsk, selectOpenAsks } = await import("./askEvent.ts");

const askEvent = (id, content) => ({
  id,
  kind: 44300,
  pubkey: "filer-pubkey",
  created_at: 1000,
  content: JSON.stringify(content),
  tags: [],
});

test("a well-formed ask reads its fields", () => {
  const ask = readAsk(
    askEvent("ask-1", {
      type: "decision",
      headline: "Which vendor for SMS?",
      cost_of_delay: "onboarding is blocked",
    }),
  );
  assert.equal(ask.id, "ask-1");
  assert.equal(ask.askType, "decision");
  assert.equal(ask.headline, "Which vendor for SMS?");
  assert.equal(ask.costOfDelay, "onboarding is blocked");
  assert.equal(ask.filerPubkey, "filer-pubkey");
});

test("an ask with no headline is not renderable and reads as null", () => {
  assert.equal(readAsk(askEvent("ask-2", { type: "decision" })), null);
  assert.equal(readAsk(askEvent("ask-3", {})), null);
});

test("a non-ask kind reads as null", () => {
  assert.equal(readAsk({ ...askEvent("m", {}), kind: 9 }), null);
});

test("malformed content reads as null rather than throwing", () => {
  assert.equal(
    readAsk({ ...askEvent("ask-4", {}), content: "{not json" }),
    null,
  );
});

test("an answered ask drops out of the open list", () => {
  const asks = [
    readAsk(askEvent("ask-1", { type: "decision", headline: "A" })),
    readAsk(askEvent("ask-2", { type: "question", headline: "B" })),
  ];
  const open = selectOpenAsks(asks, ["ask-1"]);
  assert.deepEqual(
    open.map((ask) => ask.id),
    ["ask-2"],
    "an ask a superior already answered must never show on the owner's surface",
  );
});

test("the open list is newest first", () => {
  const older = { ...readAsk(askEvent("old", { headline: "A" })), createdAt: 1 };
  const newer = { ...readAsk(askEvent("new", { headline: "B" })), createdAt: 9 };
  assert.deepEqual(
    selectOpenAsks([older, newer], []).map((ask) => ask.id),
    ["new", "old"],
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && pnpm test -- src/features/asks/lib/askEvent.test.mjs`

Expected: FAIL with `Cannot find module './askEvent.ts'`.

- [ ] **Step 3: Add the kinds**

In `desktop/src/shared/constants/kinds.ts`, beside `KIND_TASK`:

```typescript
/** Colony interrupt Ask (NIP-IQ). Filed by an agent, addressed to one tier up. */
export const KIND_ASK = 44300;
/** Resolution of an open ask: the answer that closes it. */
export const KIND_ASK_RESOLUTION = 44301;
/** Withdrawal of an open ask by its filer. */
export const KIND_ASK_WITHDRAWAL = 44302;
```

Keep `mobile/lib/shared/relay/nostr_models.dart` in sync in a later phase; note
it in the PR body rather than editing mobile here.

- [ ] **Step 4: Write the reader**

Create `desktop/src/features/asks/lib/askEvent.ts`:

```typescript
import { KIND_ASK } from "@/shared/constants/kinds";

/** An open ask addressed to the signed-in owner. */
export type OpenAsk = {
  id: string;
  askType: string;
  headline: string;
  costOfDelay: string | null;
  filerPubkey: string;
  createdAt: number;
};

type AskEventShape = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
};

/**
 * Read an ask off a relay event, or null when it is not an ask or cannot be
 * rendered. Never throws: one malformed ask must not blank the whole surface.
 */
export function readAsk(event: AskEventShape): OpenAsk | null {
  if (event.kind !== KIND_ASK) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const fields = parsed as Record<string, unknown>;
  const headline =
    typeof fields.headline === "string" ? fields.headline.trim() : "";
  if (!headline) return null;
  return {
    id: event.id,
    askType: typeof fields.type === "string" ? fields.type : "question",
    headline,
    costOfDelay:
      typeof fields.cost_of_delay === "string" ? fields.cost_of_delay : null,
    filerPubkey: event.pubkey,
    createdAt: event.created_at,
  };
}

/**
 * The asks still waiting on the owner: everything with no closure event
 * naming it, newest first.
 *
 * An ask a leader or executive already answered must never appear here. That
 * absorption is the entire point of the ladder, and showing an answered ask
 * would put the founder back in a loop the chain just took them out of.
 */
export function selectOpenAsks(
  asks: OpenAsk[],
  closureEventIds: string[],
): OpenAsk[] {
  const closed = new Set(closureEventIds);
  return asks
    .filter((ask) => !closed.has(ask.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd desktop && pnpm test -- src/features/asks/lib/askEvent.test.mjs`

Expected: PASS (6 tests).

- [ ] **Step 6: Write the query hook**

Create `desktop/src/features/asks/useOpenAsks.ts`. Run
`grep -rn "useQuery" desktop/src/features/home/hooks.ts` first and copy that
file's query shape exactly: same client, same key convention, same error
handling. The two queries are the ones the E2E already names verbatim:

```
{ kinds: [KIND_ASK], "#p": [ownerPubkey] }
{ kinds: [KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL], "#e": askIds }
```

Feed both through `readAsk` and `selectOpenAsks`.

- [ ] **Step 7: Verify and commit**

Run: `cd desktop && pnpm check && pnpm test`

```bash
git add desktop/src/shared/constants/kinds.ts desktop/src/features/asks/
git commit -s -m "feat(asks): read open asks addressed to the owner"
```

---

## Task 6: Asks in the Home inbox

The inbox already has a `needs_action` filter and an `isActionRequired` flag on
`InboxItem` (`desktop/src/features/home/lib/inbox.ts:23`). Asks become inbox
items rather than a new screen.

**Files:**
- Create: `desktop/src/features/asks/lib/askInboxItem.ts`
- Test: `desktop/src/features/asks/lib/askInboxItem.test.mjs`
- Modify: `desktop/src/features/home/useHomePersonalInbox.ts`

**Interfaces:**
- Consumes: `OpenAsk` (Task 5), `InboxItem` from
  `@/features/home/lib/inbox`.
- Produces: `askToInboxItem(ask: OpenAsk, senderLabel: string): InboxItem`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/asks/lib/askInboxItem.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

const { askToInboxItem } = await import("./askInboxItem.ts");

const ask = {
  id: "ask-1",
  askType: "decision",
  headline: "Which vendor for SMS?",
  costOfDelay: "onboarding is blocked",
  filerPubkey: "agent-pubkey",
  createdAt: 1_760_000_000,
};

test("an ask becomes an action-required inbox item", () => {
  const item = askToInboxItem(ask, "Ops Lead");
  assert.equal(item.id, "ask-1");
  assert.equal(item.isActionRequired, true);
  assert.equal(item.subject, "Which vendor for SMS?");
  assert.equal(item.senderLabel, "Ops Lead");
  assert.equal(item.unreadCount, 1);
});

test("the preview states the cost of delay, because that is what ranks it", () => {
  assert.match(askToInboxItem(ask, "Ops Lead").preview, /onboarding is blocked/);
});

test("an ask with no stated cost of delay still previews", () => {
  const item = askToInboxItem({ ...ask, costOfDelay: null }, "Ops Lead");
  assert.ok(item.preview.length > 0);
  assert.doesNotMatch(item.preview, /null|undefined/);
});

test("the category label names the ask type", () => {
  assert.match(askToInboxItem(ask, "Ops Lead").categoryLabel, /decision/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && pnpm test -- src/features/asks/lib/askInboxItem.test.mjs`

Expected: FAIL with `Cannot find module './askInboxItem.ts'`.

- [ ] **Step 3: Write the adapter**

Create `desktop/src/features/asks/lib/askInboxItem.ts`. Read
`desktop/src/features/home/lib/inbox.ts:33` first and fill **every** field of
`InboxItem`; the type has no optional fields except `mentionPubkeysByName`.

```typescript
import type { InboxItem } from "@/features/home/lib/inbox";
import type { OpenAsk } from "@/features/asks/lib/askEvent";

/**
 * Present an open ask as an inbox item.
 *
 * Asks go through the existing inbox rather than a new screen: the inbox
 * already models "this needs you" through `isActionRequired` and the
 * `needs_action` filter, and a founder with two inboxes checks neither.
 */
export function askToInboxItem(ask: OpenAsk, senderLabel: string): InboxItem {
  const timestamp = new Date(ask.createdAt * 1000);
  const cost = ask.costOfDelay
    ? `Waiting costs: ${ask.costOfDelay}`
    : "No cost of delay stated.";
  return {
    avatarUrl: null,
    conversationId: ask.id,
    id: ask.id,
    item: { kind: "ask", ask } as unknown as InboxItem["item"],
    categories: [],
    categoryLabel: `Ask · ${ask.askType}`,
    channelLabel: null,
    fullTimestampLabel: timestamp.toLocaleString(),
    groupItems: [],
    isActionRequired: true,
    latestActivityAt: ask.createdAt,
    mentionNames: [],
    preview: cost,
    senderLabel,
    subject: ask.headline,
    timestampLabel: timestamp.toLocaleTimeString(),
    unreadCount: 1,
  };
}
```

If `InboxItem["item"]` is a discriminated union that cannot accept an ask, add an
`ask` variant to `FeedItem` in `@/shared/api/types` rather than casting. The cast
above is a placeholder the implementer must resolve properly, and leaving it is a
review failure.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && pnpm test -- src/features/asks/lib/askInboxItem.test.mjs`

Expected: PASS (4 tests).

- [ ] **Step 5: Merge asks into the inbox list**

In `desktop/src/features/home/useHomePersonalInbox.ts`, call `useOpenAsks()`,
map through `askToInboxItem`, and merge into the existing item list sorted by
`latestActivityAt`. Asks must appear under both `all` and `needs_action`.

- [ ] **Step 6: Verify and commit**

Run: `cd desktop && pnpm check && pnpm test`

```bash
git add desktop/src/features/asks/ desktop/src/features/home/
git commit -s -m "feat(asks): surface open asks in the home inbox"
```

---

## Task 7: The Ask card

**Files:**
- Create: `desktop/src/features/asks/ui/AskDetailCard.tsx`
- Modify: `desktop/src/features/home/ui/InboxDetailPane.tsx`

**Interfaces:**
- Consumes: `OpenAsk` (Task 5).
- Produces: `AskDetailCard: React.ComponentType<{ ask: OpenAsk; onAnswer: (decision: string, rationale: string) => Promise<void>; isSubmitting: boolean }>`.

- [ ] **Step 1: Write the card**

Create `desktop/src/features/asks/ui/AskDetailCard.tsx`:

```tsx
import * as React from "react";

import type { OpenAsk } from "@/features/asks/lib/askEvent";

type AskDetailCardProps = {
  ask: OpenAsk;
  onAnswer: (decision: string, rationale: string) => Promise<void>;
  isSubmitting: boolean;
};

/**
 * The card the founder answers an ask from.
 *
 * `ask_broker` already accepts an owner answering by replying in the thread;
 * this is the other half it was written against, so a founder does not have to
 * find the thread to unblock somebody.
 */
export function AskDetailCard({
  ask,
  onAnswer,
  isSubmitting,
}: AskDetailCardProps): React.JSX.Element {
  const [decision, setDecision] = React.useState("");
  const [rationale, setRationale] = React.useState("");
  const canSubmit = decision.trim().length > 0 && !isSubmitting;

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="ask-detail-card">
      <div className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">
          Ask · {ask.askType}
        </span>
        <h2 className="text-base font-medium text-foreground">
          {ask.headline}
        </h2>
        {ask.costOfDelay ? (
          <p className="text-sm text-muted-foreground">
            Waiting costs: {ask.costOfDelay}
          </p>
        ) : null}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Your answer</span>
        <textarea
          className="min-h-24 rounded-md border border-border bg-background p-2 text-sm outline-none"
          data-testid="ask-answer-decision"
          onChange={(event) => setDecision(event.target.value)}
          placeholder="What you decided."
          value={decision}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Why (optional)</span>
        <textarea
          className="min-h-16 rounded-md border border-border bg-background p-2 text-sm outline-none"
          data-testid="ask-answer-rationale"
          onChange={(event) => setRationale(event.target.value)}
          placeholder="Reasoning the agent should carry forward."
          value={rationale}
        />
      </label>

      <button
        className="self-start rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        data-testid="ask-answer-submit"
        disabled={!canSubmit}
        onClick={() => void onAnswer(decision.trim(), rationale.trim())}
        type="button"
      >
        {isSubmitting ? "Sending…" : "Answer and unblock"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the detail pane**

In `InboxDetailPane.tsx`, render `AskDetailCard` when the selected item is an
ask. `onAnswer` publishes a `KIND_ASK_RESOLUTION` event with an `e` tag naming
the ask id and content `{"decision": "...", "rationale": "..."}`, using the
existing publish path (`grep -rn "publishEvent\|signAndPublish" desktop/src/shared/api/`).

- [ ] **Step 3: Verify the card renders**

```bash
cd desktop && pnpm check && pnpm build:e2e
just desktop-screenshot --name ask-card --route /
```

Expected: a PNG path on stdout.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/features/asks/ui/ desktop/src/features/home/ui/InboxDetailPane.tsx
git commit -s -m "feat(asks): ask card the owner answers from"
```

---

## Task 8: Full gate and PR

- [ ] **Step 1: Run everything**

```bash
just ci
just test          # needs Postgres + Redis
cd desktop && pnpm test:e2e:smoke
```

- [ ] **Step 2: Run the absorption gate one more time and paste the output**

```bash
cargo test -p buzz-test-client --test e2e_ask_chain -- --ignored --nocapture --test-threads 1
```

The PR body must contain this output verbatim, with
`a_leader_answers_a_workers_ask_and_the_owner_never_sees_it ... ok` visible. That
line is the deliverable; everything else in this plan is what makes it true.

- [ ] **Step 3: Screenshots**

```bash
shasum -a 256 test-results/screenshots/*.png   # every hash unique
./scripts/post-screenshots.sh <PR> test-results/screenshots
```

- [ ] **Step 4: PR and auto-merge**

```bash
gh pr create --repo AI-Native-Ventures/Colony --base develop \
  --title "feat(asks): make the ask chain absorb" --body-file <body>
gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto
```

Note in the PR body that `mobile/lib/shared/relay/nostr_models.dart` still lacks
the three ask kinds and must be synced before mobile ships an ask surface.

---

## Self-review

**Coverage of the diagnosis.** Harness never subscribed to 44300: Task 1. Agent
never knew what to do with a received ask: Tasks 2 and 3. No proof of
absorption: Task 4. No owner surface at all: Tasks 5, 6, 7.

**Deliberately not covered.** The thread-scoped exemption in `interrupt_gate.rs`
still lets an agent talk to the owner freely inside any thread the owner
started, asks included. That is listed in "Out of scope" because narrowing it is
a product decision about what an owner-started thread means, not a bug fix. It
should be the next conversation after this lands, because it is the remaining
path by which task-assignment threads stay a direct line to the founder.

**Type consistency.** `OpenAsk` fields are identical across Tasks 5, 6, and 7.
`IncomingAsk` (Rust, Task 2) and `OpenAsk` (TypeScript, Task 5) deliberately
differ: the agent side needs `task_id` to escalate, the owner side does not.
`readAsk` and `read_incoming_ask` both treat a missing headline as unrenderable,
so the two sides agree on what a usable ask is.

**Known placeholder, and it is flagged in the task.** Task 6 Step 3 casts to
`InboxItem["item"]`. The step tells the implementer to resolve it by adding an
`ask` variant to `FeedItem` instead, and says leaving the cast is a review
failure. It is written that way because `FeedItem`'s shape has to be read before
the correct variant can be written, and inventing one here would be worse than
naming the decision.
