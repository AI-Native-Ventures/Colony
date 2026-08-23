# Codex Spend Coverage Design

**Date:** 2026-08-21
**Status:** Approved in the Product channel

## Goal

Make the Spend ledger capture current Codex subscription usage without claiming
that adapter-reported counters are provider-wire evidence, and without losing a
completed record when the relay is temporarily unavailable.

Historical usage from 18 to 21 August is explicitly unrecoverable and is not
part of this repair.

## Context

Desktop-managed agents inherited `BUZZ_ACP_NO_METER=true`, so Codex work stopped
reaching Spend on 18 August. Removing that switch is necessary but insufficient:
ChatGPT-authenticated Codex cannot send its subscription through the API-key
metering checkpoint.

`@agentclientprotocol/codex-acp` 1.1.7 receives both `lastTokenUsage` and
`totalTokenUsage` from Codex. It currently returns only `lastTokenUsage` in the
ACP prompt response. That value describes the last model request, not the whole
tool-loop turn. Publishing it as a complete turn would undercount. The adapter
also omits cache-write counters that Codex versions may not expose.

## Considered Approaches

### 1. Require API-key wire metering

This preserves exact provider-wire evidence and the existing ledger contract.
It does not cover ChatGPT subscriptions, which are the active production path.

### 2. Publish the final ACP prompt usage directly

This is small and produces a current Spend row. It is rejected because the
final usage object is only the last model request in a tool loop. It would be a
plausible but incomplete number.

### 3. Expose cumulative adapter counters and label the evidence

This is the selected approach. A version-guarded compatibility layer changes
the managed Codex adapter to return its existing session-cumulative counters.
Buzz computes the turn delta against the last committed cumulative snapshot,
labels the immutable usage record `adapter_estimate`, and persists the signed
event before attempting relay delivery.

This approach covers subscription Codex now while preserving the stronger wire
path for API-key and Colony Credits calls.

## Protocol Contract

`UsageSource` gains `adapter_estimate`.

- `wire` means the provider response crossed Colony's checkpoint.
- `adapter_estimate` means a first-party or third-party adapter exposed
  cumulative provider counters, but Colony did not observe the provider wire.
- `manual` retains its current owner-entered meaning.

Usage records also carry `unknownTokenFields`. An absent cache category is not
serialized as proven zero. The numeric token breakdown keeps zero placeholders
for backward-compatible pricing, while the unknown-field list preserves the
measurement limitation. The Spend activity row exposes the evidence source so
the estimate cannot be mistaken for a wire charge.

Wire records always use an empty unknown-field list.

## Codex Compatibility Layer

For managed `@agentclientprotocol/codex-acp` 1.1.7, Buzz prepares a sibling copy
of the bundled adapter and replaces the three prompt-response projections from
`lastTokenUsage` to `totalTokenUsage`. It never overwrites the installed file.

The preparation step is fail-closed for Spend:

- It validates the package version and exact source anchors.
- It writes the patched sibling atomically and stamps the source digest.
- If validation fails, Codex may still run, but Buzz publishes no
  `adapter_estimate` record and logs a launch-visible error.
- API-key and Colony Credits paths never use this layer because wire metering
  remains authoritative and a second record would double count.

The ACP client parses the cumulative prompt usage only when the compatibility
layer was activated for that child. It feeds the cumulative counters into the
existing monotonic delta tracker. Counter decreases, missing required fields,
and all-zero deltas do not produce a Spend record.

## Durable Delivery

Every kind 44210 event is signed and encrypted before persistence. The outbox
stores one JSON event per file under an identity-and-relay scoped directory.
The filename is the signed event ID, which is also the relay idempotency key.

Delivery order is:

1. Build, encrypt, and sign the event.
2. Atomically persist it with owner-only permissions.
3. Submit it to the relay with a bounded timeout.
4. Remove it only after relay acknowledgement.
5. Retry pending events on startup and on a bounded background interval.

Both provider-wire records and adapter-estimate records use the same outbox.
Replaying an event submits the same signed ID, so retry cannot create a second
ledger charge. The ledger's existing provider/request dedupe remains a second
line of defence.

## Spend UI

Ledger entries carry their usage source through the Tauri view and TypeScript
parser. Activity rows show `adapter estimate` for the subscription fallback.
The existing `subscription` label remains because payment mode and evidence
source answer different questions.

## Failure Behaviour

- Unsupported adapter version or changed source anchor: no estimate is
  published, and the runtime log names the incompatibility.
- Missing cumulative input, output, total, or cache-read counter: no estimate
  is published.
- Missing cache-write counter: the record preserves that field as unknown.
- Cumulative counter decrease: the turn delta is unreliable and is not added
  to Spend.
- Relay rejection, timeout, or process restart: the signed event remains in
  the outbox and is retried.
- Duplicate retry: the same event ID is submitted and counted once.
- Outbox corruption or unsafe permissions: startup reports the error and does
  not silently discard the affected records.

## Acceptance Gate

The repair can merge only after all of the following pass on the exact branch
head:

- Full `buzz-core`, `buzz-meter`, `buzz-acp`, Desktop Rust, and Desktop UI
  package suites.
- Adapter tests covering exact-version preparation, changed-anchor refusal,
  cumulative multi-request deltas, counter decrease, and unknown cache fields.
- Outbox tests covering persist-before-submit, relay failure, restart replay,
  acknowledgement removal, and duplicate idempotency.
- A real ChatGPT-authenticated Codex tool-loop turn produces nonzero cumulative
  counters and one decryptable `adapter_estimate` event.
- A fault-injected relay failure leaves the event on disk, and a restarted
  harness publishes that exact event ID once.
- Spend UI parsing and rendering visibly distinguish adapter estimates from
  wire records.

Production promotion remains a separate act requiring Basheer's explicit
written approval for this change.
