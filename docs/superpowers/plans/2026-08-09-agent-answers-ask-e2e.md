# Live-Harness Ask Answering E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, against a live relay, that a running `buzz-acp` harness receives
an ask addressed to its agent, renders the `<colony-ask>` block, and that the
agent answering with the command from that block closes the ask so it never
climbs to the founder.

**Architecture:** A scripted ACP agent binary stands in for a model. The harness
launches it through `BUZZ_ACP_AGENT_COMMAND`, so the whole production path runs:
global ask inbox, author gate, channel-less turn, block rendering, and the CLI
command the block prints. The stub parses the ask id **out of the block** and
executes the real `buzz` CLI, so nothing about the ask is passed to it out of
band.

**Tech Stack:** Rust, `tokio`, line-delimited JSON-RPC 2.0 over stdio,
`buzz-test-client`, an isolated relay and Postgres.

**Design:** `docs/superpowers/specs/2026-08-09-agent-answers-ask-e2e-design.md`
(revision 2, in develop). Read it before Task 1.

## Global Constraints

- Do **not** modify `crates/buzz-relay/src/ask_broker.rs`,
  `interrupt_gate.rs`, or `interrupt_runtime.rs`.
- Do **not** weaken `respond_to`. The test runs at the shipped `owner-only`
  default. Setting `anyone` would make the test pass while hiding whether the
  shipped default works.
- Do **not** pass the ask id to the stub out of band. Everything it acts on is
  parsed from the `<colony-ask>` block.
- No new `unwrap()`/`expect()` in production paths. Test and stub code may use
  them, but prefer a clear panic message over a silent `None`.
- `git commit -s` every time.
- Activate hermit first: `. ./bin/activate-hermit`.
- The host is under load. Scope every cargo command with `-p`. Do not run
  `just ci` or `just test`. Never run `caffeinate`, never force window focus.

## What already landed, and what this depends on

PR #201 (`cb06c53bf7`) added the global ask inbox to `buzz-acp`: a subscription
filtered on `{kinds:[44300], "#p":[me]}` with no `#h`, its own inbound queue, and
`PromptSource::Ask` for a channel-less turn. Before it, a real ask raised without
`--channel` could never reach the harness at all.

That is why this test could not be written before now, and why it is worth
writing: nothing yet proves the assembled path runs.

## File Structure

| File | Responsibility |
| --- | --- |
| `crates/buzz-test-client/src/bin/ask_stub_agent.rs` | The scripted ACP agent: wire protocol, then acting on the block |
| `crates/buzz-test-client/tests/e2e_agent_answers_ask.rs` | Fixture, harness spawn, and the six assertions |
| `.github/workflows/ci.yml` | A dedicated job with its own relay and database |

`crates/buzz-test-client/src/bin/` already contains `mention.rs` and
`wamp_bench.rs`, so a third binary needs no manifest change.

---

## Task 1: The stub agent speaks ACP

**Files:**
- Create: `crates/buzz-test-client/src/bin/ask_stub_agent.rs`
- Test: same file, inline `tests` module

**Interfaces:**
- Consumes: stdin/stdout, line-delimited JSON-RPC 2.0.
- Produces: `fn handle_rpc(line: &str, state: &mut StubState) -> Option<String>`,
  returning the response line to write, or `None` for a notification.

- [ ] **Step 1: Read the real contract first**

Run these and read what the harness actually sends and expects:

```bash
sed -n '630,665p' crates/buzz-acp/src/acp.rs   # initialize
sed -n '715,735p' crates/buzz-acp/src/acp.rs   # session/new, needs result.sessionId
grep -n "stopReason" crates/buzz-acp/src/acp.rs | head
grep -n "fn build_initialize_params" -A 20 crates/buzz-acp/src/acp.rs
```

The harness reads `result.sessionId` from `session/new` and will error with
`session/new response missing sessionId` without it. It reads
`_meta.steering.supported` and `agentCapabilities.providers` from `initialize`,
both optional; omit them so the stub advertises neither.

- [ ] **Step 2: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_returns_a_result_for_the_same_id() {
        let mut state = StubState::default();
        let out = handle_rpc(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            &mut state,
        )
        .expect("initialize must produce a response");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 1);
        assert!(v["result"].is_object());
    }

    #[test]
    fn session_new_returns_a_session_id() {
        let mut state = StubState::default();
        let out = handle_rpc(
            r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}"#,
            &mut state,
        )
        .expect("session/new must produce a response");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(
            v["result"]["sessionId"].as_str().is_some(),
            "the harness errors with 'session/new response missing sessionId' without this"
        );
    }

    #[test]
    fn session_prompt_returns_a_stop_reason() {
        let mut state = StubState::default();
        handle_rpc(r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}"#, &mut state);
        let out = handle_rpc(
            r#"{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"hello"}]}}"#,
            &mut state,
        )
        .expect("session/prompt must produce a response");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v["result"]["stopReason"].as_str().is_some());
    }

    #[test]
    fn an_unknown_method_does_not_kill_the_stub() {
        let mut state = StubState::default();
        assert!(handle_rpc(
            r#"{"jsonrpc":"2.0","id":9,"method":"session/cancel","params":{}}"#,
            &mut state,
        )
        .is_some());
    }

    #[test]
    fn a_notification_gets_no_response() {
        let mut state = StubState::default();
        assert!(handle_rpc(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#,
            &mut state,
        )
        .is_none());
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p buzz-test-client --bin ask_stub_agent`

Expected: FAIL, `StubState` and `handle_rpc` not found.

- [ ] **Step 4: Write the implementation**

`StubState` holds the session id and, later, the prompt log path. `handle_rpc`
parses one JSON-RPC line and dispatches:

- `initialize` returns `{"protocolVersion": <echo or 2>, "agentCapabilities": {}}`
- `session/new` returns `{"sessionId": "<uuid>"}`
- `session/prompt` returns `{"stopReason": "end_turn"}`
- any other request returns a result rather than an error, so a stray method
  never kills the run
- a message with no `id` is a notification: return `None`

`main` reads stdin line by line, calls `handle_rpc`, and writes each `Some`
response as one line to stdout, flushing after each. Never write anything other
than JSON-RPC to stdout: the harness parses that stream. Diagnostics go to
stderr.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p buzz-test-client --bin ask_stub_agent`

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add crates/buzz-test-client/src/bin/ask_stub_agent.rs
git commit -s -m "test(e2e): a scripted ACP agent that speaks the harness wire protocol"
```

---

## Task 2: The stub acts on the ask block

**Files:**
- Modify: `crates/buzz-test-client/src/bin/ask_stub_agent.rs`

**Interfaces:**
- Consumes: `handle_rpc` (Task 1).
- Produces: `fn parse_ask_block(prompt: &str) -> Option<ParsedBlock>` where
  `ParsedBlock { ask_id: String, answer_command: Vec<String> }`, and
  `fn log_line(path: &str, entry: &serde_json::Value)`.

- [ ] **Step 1: Write the failing test**

```rust
    const BLOCK: &str = "<colony-ask>\nAsk id: abc123\nType: decision\nHeadline: Which vendor?\nCost of delay: blocked\nTask id: task-7\n</colony-ask>\nSomeone below you is blocked on this and is waiting. Answer it if you can decide it, using the ask id verbatim:\n`buzz asks answer --ask abc123 --answer-json '{\"decision\":\"<what you decided>\",\"rationale\":\"<why>\"}'`\n";

    #[test]
    fn the_ask_id_comes_from_the_block_not_from_the_test() {
        let parsed = parse_ask_block(BLOCK).expect("a colony-ask block must parse");
        assert_eq!(parsed.ask_id, "abc123");
    }

    #[test]
    fn the_answer_command_is_taken_from_the_block_verbatim() {
        let parsed = parse_ask_block(BLOCK).expect("parses");
        assert_eq!(parsed.answer_command[0], "buzz");
        assert_eq!(parsed.answer_command[1], "asks");
        assert_eq!(parsed.answer_command[2], "answer");
        assert!(
            parsed.answer_command.contains(&"abc123".to_string()),
            "the command must carry the id the block gave, not one we invented"
        );
        assert!(
            !parsed.answer_command.iter().any(|a| a.contains("<what you decided>")),
            "placeholders must be substituted or the CLI receives literal angle brackets"
        );
    }

    #[test]
    fn a_prompt_with_no_block_parses_as_none() {
        assert!(parse_ask_block("just an ordinary chat message").is_none());
    }

    #[test]
    fn a_block_with_no_ask_id_parses_as_none() {
        assert!(parse_ask_block("<colony-ask>\nType: decision\n</colony-ask>").is_none());
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p buzz-test-client --bin ask_stub_agent parse_ask_block`

Expected: FAIL, `parse_ask_block` not found.

- [ ] **Step 3: Write the implementation**

`parse_ask_block` finds the `<colony-ask>` ... `</colony-ask>` span, reads the
`Ask id:` line, then finds the backticked line beginning `buzz asks answer` and
splits it into argv. Substitute `<what you decided>` and `<why>` with fixed
strings before splitting, so the JSON stays one argument. Return `None` when
either the block or the ask id is missing.

Wire it into `session/prompt`: concatenate the prompt's text parts, call
`parse_ask_block`, and when it returns `Some`, run the command with
`std::process::Command`, capturing stdout and stderr rather than inheriting them.
Append one JSON line to the path in `BUZZ_STUB_LOG` recording
`{"saw_block":true,"ask_id":...,"argv":[...],"exit_code":N,"stderr":"..."}`.
When it returns `None`, append `{"saw_block":false}`. Always return
`{"stopReason":"end_turn"}` either way.

The command inherits the stub's environment, which is the harness's environment,
which is where `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL` and `BUZZ_AUTH_TAG` live.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p buzz-test-client --bin ask_stub_agent`

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-test-client/src/bin/ask_stub_agent.rs
git commit -s -m "test(e2e): the stub answers using the id and command from the block"
```

---

## Task 3: The end-to-end test

**Files:**
- Create: `crates/buzz-test-client/tests/e2e_agent_answers_ask.rs`

**Interfaces:**
- Consumes: the stub binary (Tasks 1 and 2), and the fixtures in
  `crates/buzz-test-client/tests/e2e_ask_chain.rs`.
- Produces: `a_live_harness_reads_the_ask_block_and_answers_it`.

- [ ] **Step 1: Read the fixtures you are reusing**

`e2e_ask_chain.rs` already has `ensure_test_community`, `seed_relay_owner`,
`employ_ladder`, `publish_role_head`, `raise_with_window`, `asks_addressed_to`,
`closures_naming`, and `wait_for_successor`. Read them and reuse them; do not
write parallel versions. If they are private to that test binary, lift the ones
you need into `crates/buzz-test-client/tests/common/` rather than copying.

**A real ask needs tags `ask-type`, `p`, `initiative`, `need` and at least one
`task`, plus content `headline` and `cost_of_delay`.** Build it with the CLI's
own builder as `raise_with_window` does. Do not hand-roll a thinner ask.

- [ ] **Step 2: Write the failing test**

```rust
/// The gate this whole line of work exists for: a live ACP harness, not a
/// direct relay publish, receives an ask, renders the block, and the agent
/// answers using the id the block gave it.
#[tokio::test]
#[ignore = "requires a running relay, Postgres, and a built buzz CLI"]
async fn a_live_harness_reads_the_ask_block_and_answers_it() {
    let community_id = ensure_test_community(&relay_host()).await;
    let owner = Keys::generate();
    seed_relay_owner(community_id, &owner).await;

    let mut owner_ws = BuzzTestClient::connect(&relay_url(), &owner).await.expect("owner connect");
    let ws = workspace(&mut owner_ws, owner.clone()).await;
    let task_id = create_chat_task(&mut owner_ws, &ws).await;

    let worker = Keys::generate();
    let leader = Keys::generate();
    let executive = Keys::generate();
    let (worker_role, leader_role, executive_role) =
        employ_ladder(community_id, &owner, &worker, &leader, &executive).await;
    publish_role_head(&mut owner_ws, &owner, &worker, &worker_role).await;
    publish_role_head(&mut owner_ws, &owner, &leader, &leader_role).await;
    publish_role_head(&mut owner_ws, &owner, &executive, &executive_role).await;

    // The inbound author gate resolves a non-owner filer through its kind:0
    // NIP-OA profile. Publish it and read it back before filing, or the ask is
    // dropped for a fixture reason and looks like a product failure.
    publish_agent_auth_profile(&mut owner_ws, &owner, &worker).await;
    await_auth_profile_visible(&worker).await;

    let log_path = stub_log_path();
    let mut harness = spawn_harness_as(&leader, &log_path).await;
    await_ask_inbox_ready(&leader).await;

    let ask_id = raise_with_window(
        &mut worker_ws, &worker, &leader.public_key().to_hex(), None, &task_id,
        &format!("sms-vendor-{}", Uuid::new_v4().simple()),
        "Which vendor should we use for SMS?", None, Some(1),
    ).await;

    let entry = await_stub_entry(&log_path, Duration::from_secs(90)).await;

    assert_eq!(entry["saw_block"], serde_json::json!(true),
        "the live harness must deliver the ask and render the block");
    assert_eq!(entry["ask_id"], serde_json::json!(ask_id),
        "the block must carry the real ask id");
    assert_eq!(entry["exit_code"], serde_json::json!(0),
        "the command the block prints must actually run: got stderr {}", entry["stderr"]);

    let closures = closures_naming(&owner, std::slice::from_ref(&ask_id)).await;
    assert_eq!(closures.len(), 1, "answering must close the ask exactly once");
    assert_eq!(tag_value(&closures[0], "e"), ask_id, "the closure must name this ask");
    assert_eq!(closures[0]["pubkey"], serde_json::json!(leader.public_key().to_hex()),
        "the closure must be signed by the agent that was asked, not by anyone else");

    let before: Vec<String> = vec![];
    let after: Vec<String> = asks_addressed_to(&owner).await.iter()
        .map(|a| a["id"].as_str().unwrap_or_default().to_string()).collect();
    assert_eq!(after, before,
        "an ask the agent answered must never reach the founder; got {after:?}");

    harness.kill().await.ok();
}
```

- [ ] **Step 3: Run it and record what fails**

```bash
./scripts/start-isolated-test-relay.sh   # with BUZZ_HARNESS_* and BUZZ_RELAY_PRIVATE_KEY set
cargo build -p buzz-cli --bin buzz
cargo build -p buzz-test-client --bin ask_stub_agent
cargo build -p buzz-acp
RELAY_URL=ws://localhost:3100 DATABASE_URL=... \
  cargo test -p buzz-test-client --test e2e_agent_answers_ask -- --ignored --nocapture
```

Expected: FAIL. **Report which assertion fails.** If it fails at `saw_block`,
either the ask inbox is not delivering or the author gate dropped the filer, and
those are different findings: check the harness log before concluding.

- [ ] **Step 4: Make it pass without weakening it**

Write the helpers the test names: `publish_agent_auth_profile`,
`await_auth_profile_visible`, `stub_log_path`, `spawn_harness_as`,
`await_ask_inbox_ready`, `await_stub_entry`.

`spawn_harness_as` runs `buzz-acp` with `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL` and
`BUZZ_AUTH_TAG` for that agent, `BUZZ_ACP_AGENT_COMMAND` pointing at the built
stub, `BUZZ_STUB_LOG` set to the log path, and the directory holding the built
`buzz` binary prepended to `PATH`. Redirect its output **to a file**, never to a
pipe you do not drain: the harness does not exit, and a full pipe buffer will
stall it.

`await_ask_inbox_ready` must wait on something observable, not sleep. The first
REQ uses `since=now`, so an ask filed before the subscription lands is never
delivered and never retried. Prefer an EOSE or a relay-side signal. If no such
signal exists, say so and add one rather than sleeping.

**Do not** set `BUZZ_ACP_RESPOND_TO`. The test runs at the shipped default.

- [ ] **Step 5: Run the whole thing green, then commit**

```bash
git add crates/buzz-test-client/tests/e2e_agent_answers_ask.rs crates/buzz-test-client/tests/common/
git commit -s -m "test(e2e): prove a live harness reads an ask block and answers it"
```

---

## Task 4: A dedicated CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the test from Task 3.
- Produces: a job named `Agent Ask E2E`.

- [ ] **Step 1: Read the existing job you are modelling on**

`sed -n '972,1030p' .github/workflows/ci.yml` is the `relay-e2e` job: relay
artifact download, `./scripts/start-relay-for-tests.sh --no-build`, `RELAY_URL`
and `DATABASE_URL` env, and a relay-log upload on failure. Follow its shape.

- [ ] **Step 2: Add the job**

A separate job, not another line in `relay-e2e`. It must:

- start its own relay and database, so it inherits no other suite's owners. The
  `relay-e2e` job had to be reordered in PR #199 because
  `interrupt_runtime::find_unique_executive` refuses to promote when a community
  holds more than one executive, and every suite there shares one community.
- set a durable `BUZZ_RELAY_PRIVATE_KEY`, or resolutions and the sweep refuse
- build `buzz-cli`, `ask_stub_agent`, and `buzz-acp` before running
- run only `--test e2e_agent_answers_ask -- --ignored --nocapture`
- upload both the relay log and the stub log on failure, because "the block never
  arrived" is unreadable without them

- [ ] **Step 3: Verify the workflow parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml parses')"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -s -m "ci: a dedicated job for the live-harness ask answering E2E"
```

---

## Self-review

**Coverage.** Stub speaks ACP: Task 1. Stub acts on the block and runs the real
command: Task 2. The assembled path with a live harness: Task 3. Isolation from
suite-ordering fragility: Task 4.

**The anti-vacuity rules, and where each is enforced.** The ask id is never
passed out of band (Task 2's tests assert it comes from the block, Task 3 never
hands it over). `respond_to` stays at the shipped default (Task 3 Step 4 forbids
setting it). The closure is checked for its `e` id **and** its signer, so a
resolution from any other key cannot satisfy it.

**Deliberately not covered.** Tier 2, the real-model run, is out of scope here.
It is `#[ignore]` plus an env gate in the design and is run by hand when the
prompt wording changes. Which of answer versus escalate a model picks is model
behaviour, not our contract.

**Known risk.** `await_ask_inbox_ready` is the piece most likely to be
implemented as a sleep. If it is, the test will be flaky in CI and will fail
under load in exactly the way that looks like a product bug. Task 3 Step 4 calls
this out; hold the line on it in review.
