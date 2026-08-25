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
