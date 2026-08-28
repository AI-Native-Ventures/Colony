# Relay read connection intermittently delivers zero frames for a full poll window after successfully ingesting writes on the same connection

## Observed

On one WebSocket connection to the Buzz relay, a client sends several writes
in quick succession (owner-signed Company Actions, or agent-authored
events, over a NIP-42-authenticated connection). The relay accepts every
one of them (`accepted=true` in its own ingest response). The client then
opens a new subscription on that SAME connection to read something back — a
receipt, a head, an event it just wrote — and receives no frames of any
kind for the entire poll window: no matching event, no EOSE, no CLOSED. The
window times out with nothing.

A fresh attempt afterward — closing the stale subscription and opening a
new one with a new subscription id, on the same connection — succeeds,
typically on the very next try.

## Occurrence 1 (full evidence)

Test `the_activation_ladder_the_desktop_drives_is_accepted_end_to_end`
(`crates/buzz-test-client/tests/e2e_company_work.rs`), CI run `32877401780`.

Connection id `e92d4087`. Five Company Actions in sequence — create
company, create initiative, approve, activate, kick off the first task —
all ingested with `accepted=true` on that one connection between
`17:46:14.645` and `17:46:14.716`. The receipt poll following each of the
first four actions succeeded immediately.

The fifth receipt poll opened a subscription and received zero frames for
its entire 5-second window, `17:46:14.716` through `17:46:19.718`, then
failed with `collect: Timeout`.

The relay's own log has no entries for connection `e92d4087` during that
5-second window — not an error, not a delayed send, nothing at all.

## Occurrence 2 (partial)

Test `nobody_but_the_owner_can_change_company_state`, same file, a later CI
run on branch `feat/work-model`.

Failure: `collect: Timeout` at the call inside `head()` — a helper that
subscribes for one relay-authored head by coordinate and reads it back (see
the file's `head()` function). Same signature: a write had just been
accepted, then the read-back subscription got nothing for its window.

This occurrence's connection id and exact timestamps are not captured here
— they need to be pulled from that run's relay-log artifact the same way
occurrence 1's evidence was pulled, by whoever has CI log access when
filing or investigating this.

## Working theory

Every observed case follows the same shape: a write succeeds and is
visibly ingested, then the SAME already-open connection goes silent on a
subsequent read rather than erroring, closing, or delaying. This points at
something on the relay's read/subscription fan-out path failing to deliver
to one specific already-open connection shortly after a burst of writes on
it, rather than anything on the write/ingest path, which visibly worked in
both cases.

A plausible mechanism: a per-connection outbound queue or fan-out task
that stalls or silently drops under a fast write-then-subscribe pattern on
the same connection. This is a guess from the pattern, not a diagnosis —
the relay's subscription/fan-out implementation has not been inspected to
confirm it.

## What would confirm it

Relay-side logs (not client-side) for the affected connection, covering
the exact silent window, for both occurrences. Specifically:

- Did the relay's own subscription/fan-out code do ANYTHING for that
  connection during the window — queue a send, log a delivery attempt, log
  an error? That would point at something stuck or dropped on the relay
  side.
- Or is the relay log genuinely as silent as the client's observation? That
  would point away from the relay's own application logic and toward the
  network or proxy layer between client and relay instead.

Two occurrences on the same write-then-read-same-connection shape is
enough to call this recurring. It is not enough to call the cause
confirmed without that relay-side log evidence for the exact window.

## Occurrence 3: the same silence on a write acknowledgement, not a read

The two occurrences above are reads going unanswered. This one is the
acknowledgement of a write, on a desktop client rather than the Rust test
client, which widens the shape: it is not the subscription path specifically,
it is the connection.

Test `Blocks live Gate C > persists the chat-native Blocks loop with signed
relay evidence` (`desktop/tests/e2e/blocks-live.spec.ts:123`), CI run
`32952360214`, Blocks Live Gate job, on branch `feat/work-model`.

```
expect(locator).toBeHidden() failed
Locator:  getByTestId('persona-dialog')
Expected: hidden
Received: visible
Timeout:  30000ms
63 x locator resolved to <div role="dialog" ... data-state="open" ...>
blocks-live.spec.ts:698
```

The accessibility snapshot taken at failure has the answer the DOM assertion
does not:

```yaml
- dialog "Create agent":
  ...
  - paragraph: Timed out while submitting the Block action.
  - button "Decline"
```

That paragraph is reachable only through the catch branch of `submitOnce` in
`useAgentProposalReview.ts`, so the sequence is settled: the Decline click
landed, `submitBlockAction` signed and published a kind:40010, the relay never
sent `OK` for that event id within `PUBLISH_TIMEOUT_MS` (25s,
`relayClientTimings.ts`), `publishRelayEvent` rejected on its own timer, and
the dialog stayed open showing the error. `closeReview()` runs only on
success, which is correct: dismissing a dialog whose action failed would throw
the action away silently.

So the client behaved correctly throughout. **Nothing in Block proposal
dismissal is broken.** What failed is that an open, NIP-42-authenticated
socket that had just carried a long series of accepted writes (the same test
had already driven an approval to `Completed.` moments earlier) stopped
answering one more.

Same shape as occurrences 1 and 2: writes succeed on a connection, then the
relay goes silent on that connection rather than erroring, closing, or
delaying. The difference is only which frame never arrives, `EVENT`/`OK` here
against `REQ`/`EOSE` there.

### Not worked around, deliberately

`blocks-live.spec.ts` was left untouched. Its assertion is correct, and a
retry in the spec would hide a transport problem that reaches real clients:
the desktop publish path has no retry of its own, so a user in this state sees
the action fail and has to click again.

Two notes for whoever picks this up:

- The relay's own output is not captured in the Blocks Live Gate job. Only its
  startup line (`buzz-relay TCP listening`) reaches the job log, so this
  occurrence has no relay-side evidence for the silent window either, exactly
  as "What would confirm it" above asks for.
- The assertion allows 30s and the client gives up at 25s, so this spec can
  only ever observe the timed-out state and never a slow success. Widening the
  client timeout would change what the test can see; that is a reason to fix
  the stall rather than tune either number.

## Occurrence 4: thirty seconds of silence across the whole process

Test `seed_live_work_context` (same file), CI runs `33141821364` and
`33150455736` on branch `feat/community-profile-by-default`. Both times the
same line: `publish_team` at `e2e_company_work.rs:414`, failing
`relay accepts team: Timeout`.

This is the widest capture so far, and the first with the relay's own log
pulled from the job artifact rather than inferred:

```
07:46:39.898  INFO  NIP-42 auth successful
              <- 30.0 seconds, no log lines at all
07:47:09.935  INFO  WebSocket connection closed
```

Two things this adds.

**It is not one connection.** The gap is the whole relay: no line of any
level, for any connection, for thirty seconds. Occurrences 1 and 2 were
reported as silence on the affected connection, which left open the reading
that one connection's task had wedged. It had not; nothing at all was
running.

**It hits the write path with nothing pending.** The connection had just
authenticated and had made no prior request on that socket — no writes to
race a read against, no subscription open. Occurrence 3 already moved this
past reads; this moves it past read-after-write entirely. A freshly
authenticated connection whose very first frame is a write is enough.

The affected write never reached ingest: the relay logged no `Event
ingested` for kind 30178, and the client's 30-second timeout expired
before the relay resumed. Traffic on other connections resumes normally at
`07:47:10.15` and the suite's remaining tests pass.

### It reads as a regression, and is not one

This cost three wrong diagnoses on the branch above before the relay log
was pulled. Each was an attempt to explain a failure that looked
deterministic: the same test, the same line, twice in a row, while the same
job passed on `develop`.

Passing once on `develop` is consistent with an intermittent stall. It is
not evidence of a regression, and treating it as evidence is what sent
three rounds of CI after causes that were not there. **Pull
`relay-e2e-artifacts` and look for a gap in the relay's own timestamps
before concluding a branch caused a timeout in this suite.**

## Workaround in place, not a fix

As of commits `1d580e4a84` (initial fix, `broker()`'s receipt poll) and
`2d6db735c1` (remaining call sites: `head()`, `current_job_head()`,
`hire_employee()`'s poll, and the turn-metric read-back), the e2e test
suite retries a read-after-write poll on a transport error — closing the
stale subscription and reopening with a fresh subscription id — up to a
bounded number of attempts, with a strict final failure if the relay
genuinely never answers.

This makes the test suite reliable in the presence of the stall. It does
**not** address whatever is actually causing the relay to go silent on a
live connection, which may affect real desktop/mobile clients exactly the
same way in production. One call site (`inspect_live_turn_metrics`, a
human-invoked live-inspection command, not a CI-run test) was deliberately
left without the retry — see the comment at that call site for why.
