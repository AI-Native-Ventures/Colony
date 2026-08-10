# Real-LLM Ask Comprehension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and run a local-only ignored test proving that DeepSeek, through
the shipped `buzz-agent` and `buzz-acp` harness, understands a rendered
`<colony-ask>` block and publishes a valid answer with the real `buzz` tool.

**Architecture:** Extend the existing live-harness integration target so it
reuses the proven fresh-relay fixture and readiness handshake. A second harness
launcher points at `buzz-agent`, gives it `buzz-dev-mcp` as its MCP server, and
maps the existing `DEEPSEEK_API_KEY` into the OpenAI-compatible variables
`buzz-agent` consumes. The test is both ignored and guarded by
`RUN_REAL_LLM_ASK_E2E=1`; no workflow sets that variable and no CI file changes.

**Tech Stack:** Rust, `buzz-acp`, `buzz-agent`, `buzz-dev-mcp`, DeepSeek's
OpenAI-compatible Chat Completions endpoint, isolated Postgres/Redis/relay.

**Design:** `docs/superpowers/specs/2026-08-09-agent-answers-ask-e2e-design.md`
(Tier 2).

---

### Task 1: Local-only DeepSeek comprehension gate

**Files:**
- Modify: `crates/buzz-test-client/tests/e2e_agent_answers_ask.rs`
- Do not modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing test surface**

Add a second ignored test named
`a_real_deepseek_agent_understands_and_answers_the_ask_block`. It must return
immediately unless `RUN_REAL_LLM_ASK_E2E=1`, then call two not-yet-defined
helpers:

```rust
if std::env::var("RUN_REAL_LLM_ASK_E2E").as_deref() != Ok("1") {
    eprintln!("skipped: set RUN_REAL_LLM_ASK_E2E=1 for the local DeepSeek proof");
    return;
}

let mut harness = spawn_deepseek_harness_as(&leader, &owner).await;
let closures = await_real_model_resolution(
    &owner,
    &leader,
    &ask_id,
    &harness,
    Duration::from_secs(300),
)
.await;
```

The assertion must require exactly one closure, an `e` tag equal to the ask id,
the leader's pubkey as signer, and non-empty `answer.decision` and
`answer.rationale` strings in the closure content.

- [ ] **Step 2: Run the compile gate and observe red**

Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-test-client --test e2e_agent_answers_ask \
  a_real_deepseek_agent_understands_and_answers_the_ask_block --no-run
```

Expected: compile failure naming `spawn_deepseek_harness_as` and
`await_real_model_resolution`.

- [ ] **Step 3: Implement the DeepSeek launcher**

Add `spawn_deepseek_harness_as` beside the scripted launcher. It must:

```rust
let api_key = std::env::var("DEEPSEEK_API_KEY")
    .expect("RUN_REAL_LLM_ASK_E2E=1 requires DEEPSEEK_API_KEY");
let model = std::env::var("DEEPSEEK_MODEL")
    .unwrap_or_else(|_| "deepseek-v4-pro".to_string());
let base_url = std::env::var("DEEPSEEK_BASE_URL")
    .unwrap_or_else(|_| "https://api.deepseek.com/beta".to_string());
```

Point `BUZZ_ACP_AGENT_COMMAND` at `target/debug/buzz-agent`, clear the legacy
`BUZZ_ACP_AGENT_ARGS`, and point `BUZZ_ACP_MCP_COMMAND` at
`target/debug/buzz-dev-mcp`. Configure:

```text
BUZZ_AGENT_PROVIDER=openai
OPENAI_COMPAT_API_KEY=<DEEPSEEK_API_KEY>
OPENAI_COMPAT_MODEL=<DEEPSEEK_MODEL>
OPENAI_COMPAT_BASE_URL=<DEEPSEEK_BASE_URL>
OPENAI_COMPAT_API=chat
BUZZ_AGENT_MAX_ROUNDS=8
BUZZ_AGENT_LLM_TIMEOUT_SECS=240
```

Keep the same leader relay credentials, NIP-OA tag, target/debug `PATH`, EOSE
readiness wait, shipped `owner-only` response policy, file-backed stdout/stderr,
and no-meter/no-presence settings as the scripted launcher. Use
`RUST_LOG=warn,buzz_acp=debug,acp::tool=info`: this retains EOSE and turn
completion while keeping `acp::wire=debug` disabled, because wire frames carry
the MCP child environment. Never log the API key or relay credentials.

- [ ] **Step 4: Implement resolution polling and content validation**

Poll `closures_naming(owner, &[ask_id])` every 250ms until the deadline. If the
harness exits first, fail with its redirected output. If the agent turn reports
success without a closure, allow two seconds for query visibility and then fail
with the harness output instead of waiting out the full provider timeout. On
timeout, fail with the harness output. Parse the sole closure's `content` as JSON
and require:

```rust
let answer = &content["answer"];
assert!(answer["decision"].as_str().is_some_and(|s| !s.trim().is_empty()));
assert!(answer["rationale"].as_str().is_some_and(|s| !s.trim().is_empty()));
```

The test files a decision ask with a 600-second window and an unambiguous
headline instructing the leader to choose Alpha because it is already approved.
It does not add the scripted test's promotion control: Tier 1 already proves
wiring and absorption; Tier 2 proves model comprehension and tool use.

- [ ] **Step 5: Run focused compile and formatting gates**

Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-test-client --test e2e_agent_answers_ask \
  a_real_deepseek_agent_understands_and_answers_the_ask_block --no-run
cargo fmt --all -- --check
git diff --check
```

Expected: all pass. Do not run `just ci` or `just test`.

- [ ] **Step 6: Build only the four runtime binaries**

Run:

```bash
. ./bin/activate-hermit
cargo build -p buzz-cli --bin buzz
cargo build -p buzz-acp --bin buzz-acp
cargo build -p buzz-agent --bin buzz-agent
cargo build -p buzz-dev-mcp --bin buzz-dev-mcp
```

- [ ] **Step 7: Run against a fresh isolated relay**

Choose a free dedicated port tuple, export a durable relay private key and a
one-second sweep interval, then launch `scripts/start-isolated-test-relay.sh
--profile dev`. Run only:

```bash
RUN_REAL_LLM_ASK_E2E=1 \
RELAY_URL=ws://localhost:<relay-port> \
DATABASE_URL=postgres://buzz:buzz_dev@localhost:<pg-port>/buzz \
cargo test -p buzz-test-client --test e2e_agent_answers_ask \
  a_real_deepseek_agent_understands_and_answers_the_ask_block \
  -- --ignored --exact --nocapture --test-threads 1
```

Expected: one passed test, a leader-signed closure with non-empty decision and
rationale, and harness logs showing the ask inbox EOSE and successful agent
return. Tear down only that Compose project and its relay tmux session.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/plans/2026-08-10-real-llm-ask-comprehension.md \
  crates/buzz-test-client/tests/e2e_agent_answers_ask.rs
git commit -s -m "test(e2e): prove DeepSeek comprehends an ask block locally"
```

Do not edit CI and do not push until the local DeepSeek proof passes.
