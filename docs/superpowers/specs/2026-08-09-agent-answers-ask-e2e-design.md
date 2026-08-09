# Design: prove a running agent harness answers an ask

**Status:** design, pending review
**Date:** 2026-08-09
**Follows:** PR #199 (`feat(asks): make the ask chain absorb`), merged to develop as `6f5535fded`

## The gap this closes

PR #199 made the ask chain absorb, but nothing in it proves the claim end to end.

- `e2e_ask_chain::a_leader_answers_a_workers_ask_and_the_owner_never_sees_it`
  drives the **relay protocol directly**: publish an ask, query, publish a
  resolution. It proves an answered ask is not promoted by the deadline sweep.
  It never starts the ACP harness.
- Tasks 1 to 3 of that plan (subscribe to `KIND_ASK`, render the
  `<colony-ask>` block, attach it to the turn) are covered by `buzz-acp` unit
  tests only.

So the assembled path has never run: an ask arrives, the harness wakes the
addressed agent, the agent reads the block, the agent runs the command the block
gave it, and the relay closes the ask. Every link is tested; the chain is not.

## The reason this is not optional

`buzz-acp`'s inbound author gate (`lib.rs:271`, `author_allowed`) runs **before
a turn fires**, and `respond_to` defaults to `owner-only` (`config.rs:516`). In
that mode the gate calls `is_owner_or_sibling`, which resolves a non-owner author
by fetching the author's kind:0 profile and checking for a NIP-OA auth tag issued
by the same owner (`check_sibling_via_profile`, `lib.rs:249`).

A worker filing an ask to its leader is not the owner. The ask therefore wakes
the leader **only if** the worker verifies as a same-owner sibling. If it does
not, the harness drops the event before any prompt is assembled, and the ask dies
silently on a default-configured deployment.

No unit test can see this, because the drop happens upstream of everything the
unit tests exercise. This is the single most valuable thing the test will tell
us, and it is a pass/fail on whether the feature works in production at all.

## Scope

Two tiers. Only the first gates CI.

| Tier | Agent | Runs in CI | Proves |
| --- | --- | --- | --- |
| 1 | Scripted stub ACP agent | Yes | The wiring: delivery, gate, block rendering, command validity, closure, absorption |
| 2 | Real model via `buzz-agent` | No, opt-in local | Comprehension: a model reads the block and acts on it |

Tier 1 is the regression gate: deterministic, free, fast. Tier 2 answers a
prompt-quality question that is nondeterministic and costs money per run, so it
is gated behind `#[ignore]` **and** an env var, and is run by hand when
`base_prompt.md` or `ask_context_section` changes.

## Tier 1 architecture

### Component 1: the stub ACP agent

`crates/buzz-test-client/src/bin/ask_stub_agent.rs`

The agent side of ACP is three JSON-RPC methods over line-delimited stdio, which
`crates/buzz-acp/src/acp.rs` calls in order: `initialize` (line 642),
`session/new` (725), `session/prompt` (897). The stub implements exactly those
and nothing else.

On `session/prompt` it:

1. Scans the prompt text for a `<colony-ask>` ... `</colony-ask>` block.
2. Extracts the ask id and the `buzz asks answer` command line **from the block**.
3. Substitutes the `<what you decided>` / `<why>` placeholders with fixed text.
4. Executes the real `buzz` CLI with the credentials the harness injected into
   its environment (`BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG`).
5. Appends a JSON line to a log file naming: whether a block was seen, the ask id
   it parsed, the exact argv it ran, and the exit status.
6. Returns an ACP prompt response.

It lives in `buzz-test-client` because that crate is already test-only, so this
adds no workspace member, no native-inventory entry, and no CI allowlist edit.

### Component 2: the test

`crates/buzz-test-client/tests/e2e_agent_answers_ask.rs`

Fixture, reusing `e2e_ask_chain`'s helpers where they exist:

1. Isolated relay and a fresh database.
2. Seed one owner, one company, one task.
3. Employ worker, leader, executive; publish owner-signed role heads for each.
4. **Provision the worker the way a real managed agent is provisioned**,
   including a kind:0 profile carrying the owner-signed NIP-OA auth tag. See
   "Risks" — getting this wrong makes the test measure the fixture.
5. Mint the leader's agent credentials.
6. Spawn `buzz-acp` as the leader with `BUZZ_ACP_AGENT_COMMAND` pointed at the
   built stub, stdout and stderr redirected **to a file**.
7. The worker files an ask addressed to the leader.
8. Poll the stub's log, then the relay, with a bounded timeout.

### Component 3: assertions

Ordered by what each proves. Every one of them can fail independently.

| # | Assertion | Proves |
| --- | --- | --- |
| a | The stub log records a `<colony-ask>` block was received | Delivery works **and** the `respond_to` gate let a worker's ask through |
| b | The ask id in the log equals the real ask event id | The block carries the identifier the agent needs |
| c | The `buzz asks answer` invocation exited 0 | The command the block prints is actually valid and runnable |
| d | Exactly one `KIND_ASK_RESOLUTION` names the ask | The answer closed it |
| e | An unanswered sibling ask promotes; the answered one does not | The sweep discriminates, and the sweep is alive in this run |
| f | The owner's Needs-Me query is unchanged | Absorption |

## Two rules that keep this from going vacuous

The absorption gate in PR #199 was originally written with an assertion that
could not fail. These two rules exist so this test does not repeat that.

1. **The test never hands the stub the ask id.** Everything the stub acts on is
   parsed out of the prompt block. If the id were passed out of band, assertion
   (b) would prove nothing about the block.

2. **The test runs with the default `respond_to=owner-only`.** Setting it to
   `anyone` would make the test pass while hiding whether the shipped default
   works. That is exactly the mistake of asserting something that cannot be false.

Assertion (c) is the one that would have caught the `--task none` defect found
during PR #199, because it *runs* the command rather than inspecting the string.
Assertion (e) reuses the positive-control pattern from that PR: an absence
assertion is meaningless unless something observable proves the sweep ran.

## Tier 2

Same fixture. `BUZZ_ACP_AGENT_COMMAND` points at real `buzz-agent` with
`LLM_PROVIDER=deepseek`, so the model is chosen by config rather than hardcoded.
`#[ignore]` plus an explicit env gate, so no CI path can reach it even by
accident.

Asserts only (a) and (d): the model received the block, and the ask closed. It
deliberately does **not** assert on wording, decision content, or which of answer
versus escalate the model chose. Those are model behaviour, not our contract.

## CI placement

Its own job, with its own relay and database.

The PR #199 gate had to be moved to run first in `relay-e2e` because
`interrupt_runtime::find_unique_executive` refuses to promote when a community
holds more than one executive, and every suite in that job shares one host-bound
community and one database. That ordering constraint is fragile: any suite added
before it silently disables the sweep's promotion hop.

A dedicated job removes the constraint for this test rather than inheriting it,
and it lets the job own the environment this test needs: a durable
`BUZZ_RELAY_PRIVATE_KEY`, exactly one owner, exactly one executive.

## Known traps, designed around

Each of these has already cost real time in this repo.

- **Fresh database, one owner, one executive.** `find_unique_owner` and
  `find_unique_executive` refuse to guess and silently re-deadline instead of
  promoting. A dirty volume looks exactly like a dead sweep.
- **`BUZZ_RELAY_PRIVATE_KEY` is required.** Without a durable relay key,
  `handle_resolution` refuses and the interrupt sweep declines its whole tick.
- **Never pipe harness output through `tail`.** `tail` buffers until EOF and the
  harness does not exit, so a healthy run reads as zero bytes.
- **Build the stub before pointing at it.** `cargo build -p buzz-test-client
  --bin ask_stub_agent` in the job, then pass an absolute path.

## Risks

**1. The worker may not verify as a sibling.** If `check_sibling_via_profile`
does not resolve the worker, assertion (a) fails on the first run. Two possible
causes, and the test must distinguish them:

- *Fixture cause:* the worker was not provisioned with a kind:0 NIP-OA auth tag,
  so the test is measuring its own setup. Fix the fixture.
- *Product cause:* real managed agents do not carry that tag either, so the ask
  chain is dead on a default deployment. That is a finding and a follow-up fix,
  not a reason to weaken the test.

Before implementation, confirm how `managed_agents` provisions a real agent's
kind:0 and mirror it exactly. Do not reach for `respond_to=anyone` to get green.

**2. Harness startup is asynchronous.** The agent must be subscribed before the
ask is published or the event is missed. Wait for an observable readiness signal
from the harness log rather than sleeping.

**3. Wall-clock.** Assertion (e) depends on the deadline sweep, whose default
interval is 60s (`BUZZ_INTERRUPT_SWEEP_SECS`, `main.rs:982`). A dedicated job can
set that interval low, which the shared `relay-e2e` job could not.

## Out of scope

| Deferred | Why |
| --- | --- |
| Asserting which of answer vs escalate a real model picks | Model behaviour, not our contract |
| Rendering `options` / `default_option` in the block | Separate open decision from PR #199 |
| Mobile ask surface | `nostr_models.dart` still lacks the three kinds |
| Multi-hop climb through a live harness | Prove one hop first |
