# Design: prove a running agent harness answers an ask

**Status:** design, revision 2 (revision 1 was rejected by review)
**Date:** 2026-08-09
**Follows:** PR #199 (`feat(asks): make the ask chain absorb`), merged as `6f5535fded`
**Blocked on:** `docs/superpowers/plans/2026-08-09-acp-global-ask-subscription.md`

## Why revision 1 was wrong

Revision 1 assumed the shipped path worked and only needed proving. It does not.
A review confirmed, with file and line evidence, that a real ask raised without
`--channel` carries no `h` tag, is stored by the relay with `channel_id = NULL`,
and can never reach `buzz-acp`, whose every REQ is `#h`-scoped and whose only
event-producing subscriptions are `ch-<uuid>`. PR #199's unit test passes solely
because its fixture adds an `h` tag at `crates/buzz-acp/src/filter.rs:509`.

So this test cannot be built yet. The ACP global ask subscription lands first;
this design is written against the world after it does.

Revision 1 also had three concrete defects, all corrected below: it created no
NIP-29 channel or membership at all, it assumed the harness injects `BUZZ_*` into
the agent subprocess, and it used a harness log line as a readiness signal when
`subscribe_channel` only queues a command and the first REQ uses `since=now`.

One revision-1 fear was **refuted**: newly created and imported managed agents do
compute NIP-OA and sync a kind:0 auth profile, so a worker does verify as a
same-owner sibling. The fixture must publish and then query that profile before
filing, but the product is not broken here.

## The gap this closes

After the prerequisite lands, every link in the chain has a test and the assembled
chain still has none:

- `e2e_ask_chain::a_leader_answers_a_workers_ask_and_the_owner_never_sees_it`
  drives the relay protocol directly and never starts the harness.
- Delivery, block rendering, and turn assembly are `buzz-acp` unit tests.

Nobody has run: ask arrives, harness wakes the addressed agent, agent reads the
block, agent runs the command the block gave it, relay closes the ask.

## Scope

| Tier | Agent | In CI | Proves |
| --- | --- | --- | --- |
| 1 | Scripted stub ACP agent | Yes | The wiring, end to end |
| 2 | Real model via `buzz-agent` | No, opt-in | A model comprehends the block |

Tier 2 is `#[ignore]` plus an env gate so no CI path can reach it. It is run by
hand when `base_prompt.md` or `ask_context_section` changes.

## Tier 1 architecture

### Component 1: the stub ACP agent

`crates/buzz-test-client/src/bin/ask_stub_agent.rs`

Minimal, but only under constraints the review made explicit. It must:

- speak JSON-RPC 2.0 on line-delimited stdio
- return an `initialize` result
- return a `sessionId` from `session/new`
- return a `stopReason` from `session/prompt`
- tolerate repeated and initial prompts
- either be launched with model, MCP and initial-message unset, or implement
  `set_config` and `set_model`

On `session/prompt` it scans for a `<colony-ask>` block, extracts the ask id and
the `buzz asks answer` command line **from the block**, substitutes the
placeholders, executes the real `buzz` CLI, and appends a JSON line recording
what it saw, the argv it ran, and the exit status. Child stdout and stderr are
captured, never inherited.

It lives in `buzz-test-client` because that crate is already test-only: no new
workspace member, no native-inventory entry, no CI allowlist edit.

### Component 2: the test

`crates/buzz-test-client/tests/e2e_agent_answers_ask.rs`

1. Isolated relay, fresh database, durable `BUZZ_RELAY_PRIVATE_KEY`.
2. Seed exactly one owner, one company, one task.
3. Employ worker, leader, executive; publish owner-signed role heads. Exactly
   one executive and one owner, or the sweep silently re-deadlines.
4. Publish the worker's kind:0 NIP-OA auth profile **and query it back** before
   filing. The inbound author gate resolves siblings from that profile, so an
   unpublished or unpropagated profile fails the run for a fixture reason.
5. Set `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL` and `BUZZ_AUTH_TAG` for the leader
   **on the `buzz-acp` process itself**. Direct `buzz-acp` does not derive these
   into the child; the child inherits the parent environment. Only the desktop
   runtime does injection.
6. Put a built `buzz` on `PATH`, or have the stub call it by absolute path.
7. Spawn `buzz-acp` as the leader with `BUZZ_ACP_AGENT_COMMAND` pointed at the
   built stub, output redirected to a file.
8. Wait for a real readiness signal, then file the ask from the worker.

No NIP-29 channel is required. That is the point of the prerequisite: the ask
inbox is global and membership-independent, so an agent in zero channels still
receives asks addressed to it. Revision 1 needed a channel and forgot to make
one; revision 2 needs none.

### Component 3: assertions

The review noted these are coupled, so each is stated with what it assumes.

| # | Assertion | Assumes | Proves |
| --- | --- | --- | --- |
| a | Stub log records a `<colony-ask>` block | none | Global inbox delivery, and the `respond_to` gate passed a worker's ask |
| b | The logged ask id equals the real event id | a | The block carries the right identifier |
| c | The `buzz asks answer` invocation exited 0 | b | The command the block prints is runnable |
| d | Exactly one resolution, `e` tag equal to the ask id, signed by the leader's pubkey, and no closure existed before | c | The leader's answer closed this ask |
| e | An unanswered sibling ask promotes; the answered one does not, under a long deadline | d | The sweep discriminates, and it is alive in this run |
| f | The owner's Needs-Me id set is exactly what it was before | d | Absorption |

Assertions (d) and (f) are provenance-hardened on the review's advice: assert the
exact `e` id and the signer, and compare the owner's **id set** rather than a
count, so an unrelated ask arriving cannot mask a regression.

## Three rules that keep this from going vacuous

The absorption gate in PR #199 was first written with an assertion that could not
fail. These exist so that does not repeat.

1. **Never pass the ask id to the stub out of band.** Everything it acts on is
   parsed from the block, or (b) proves nothing.
2. **Run with the shipped `respond_to=owner-only`.** Setting `anyone` would make
   the test pass while hiding whether the default works.
3. **Pin the relay and key the assertions read.** The review found a third
   vacuity route revision 1 missed: assertions that query a different relay, or
   accept a resolution signed by anyone, can pass without the agent having done
   anything. Hence the signer and prior-closure checks in (d).

Assertion (c) is the one that would have caught PR #199's `--task none` defect,
because it runs the command instead of inspecting the string.

## Readiness, not sleeping

`subscribe_channel` only queues a command, and the first REQ uses `since=now`, so
an ask filed before the REQ lands is never delivered and never retried. A log
line is not a server-side acknowledgement.

Use an EOSE or probe handshake: wait until the relay has acknowledged the
agent's subscription before filing the ask. If the ask inbox does not surface an
observable acknowledgement, add one as part of the prerequisite rather than
sleeping here.

## CI placement

Its own job, which must genuinely isolate:

- fresh database and relay, exactly one owner and one executive
- `BUZZ_RELAY_PRIVATE_KEY` set, or resolutions and the sweep both refuse
- a low `BUZZ_INTERRUPT_SWEEP_SECS`, which the shared `relay-e2e` job cannot set
- builds of `buzz`, `buzz-acp` and the stub before the test runs

This also retires the ordering constraint PR #199 introduced, where the gate had
to run first in `relay-e2e` because `find_unique_executive` refuses to promote
when a community holds more than one executive.

## Known traps, designed around

- Fresh DB, one owner, one executive: `find_unique_owner` and
  `find_unique_executive` re-deadline rather than guess, which is indistinguishable
  from a dead sweep.
- `BUZZ_RELAY_PRIVATE_KEY` is mandatory.
- Never pipe harness output through `tail`: it buffers until EOF and a healthy
  run reads as zero bytes.
- Build the stub before pointing at it, and pass an absolute path.

## Risks

**1. The prerequisite may change shape under implementation.** Tasks 3 to 5 of
the plan touch every `match` on `PromptSource`; if any site uses a wildcard arm,
an ask turn could be silently swallowed. This design assumes `PromptSource::Ask`
reaches `run_prompt_task`. Re-read the plan's outcome before implementing.

**2. Sibling resolution depends on profile propagation timing.** Publishing the
worker's kind:0 is not enough; the gate queries it. Query it back before filing
and fail with a clear fixture-versus-product message if it is absent.

**3. Wall-clock.** Assertion (e) waits on the sweep. A dedicated job can lower
the interval; do that rather than lengthening the test's timeout.

## Out of scope

| Deferred | Why |
| --- | --- |
| Which of answer versus escalate a real model picks | Model behaviour, not our contract |
| Rendering `options` / `default_option` in the block | Open decision from PR #199 |
| Mobile ask surface | `nostr_models.dart` still lacks the three kinds |
| Multi-hop climb through a live harness | Prove one hop first |
| Legacy managed agents whose kind:0 predates NIP-OA sync | Review flagged auth-only drift in reconciliation; separate concern |
