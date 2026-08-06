# Write-response contract

What the relay tells a client about an event it submitted, on both transports.

Read this before writing a client that decides whether a write succeeded.
Getting it wrong is not theoretical: the relay once reported a discarded
NIP-33 write as `accepted: true`, and `buzz grants revoke` printed success and
exited 0 while the grant stayed active.

## The two rules

**1. The response always identifies the event the client SUBMITTED.**

Never a winning event's id. A client correlating a NIP-01 `OK` frame by the id
it sent always matches. When a different event won, that event is named
separately, never in the id slot.

**2. `accepted` means the submitted event is durably stored.**

True when the client's write is present at the end of the call. False when it
was discarded. It is not "the relay processed your request".

## Outcomes

| `outcome` | `accepted` | Meaning |
|---|---|---|
| `stored` | true | Newly stored by this call. |
| `already_stored` | true | The identical event was already stored. The write landed on an earlier call. |
| `superseded` | false | A different event won; the submitted event is not stored and never will be. `winner_event_id` names it. |
| `refused` | false | Declined on a durable rule, with no other event to name. |

`already_stored` and `superseded` are deliberately separate. Collapsing them is
what caused the bug above, and clients need both: a client that retries a
request after a lost response re-submits identical bytes, which is
`already_stored`, a success. Treating that as a conflict makes an agent re-file
work it had already filed.

## HTTP `POST /events`

```json
{
  "event_id": "<the id you submitted>",
  "accepted": true,
  "outcome": "already_stored",
  "message": "duplicate: identical event already stored"
}
```

`winner_event_id` is present only when `outcome` is `superseded`.

**Branch on `outcome`.** Do not parse `message`, which is human-readable detail
and may change.

## WebSocket `OK` -- a stated asymmetry

NIP-01 fixes the `OK` frame at exactly four elements:

```
["OK", "<the id you submitted>", <accepted>, "<message>"]
```

**There is no `outcome` field on this transport, and cannot be one** without
either breaking NIP-01 or emitting a fifth element a strict client ignores. The
relay does not do either.

So a WebSocket client branches on `accepted` plus the message prefix, which is
how NIP-01 itself carries machine-readable state. The prefixes are a closed set
mapping one-to-one onto `accepted`:

| Prefix | `accepted` | Outcome it corresponds to |
|---|---|---|
| neither prefix below | true | `stored` |
| `duplicate:` | true | `already_stored` |
| `conflict:` | false | `superseded` or `refused` |

Read the first row as the absence of the other two, not as a list of shapes. A
`stored` message is whatever the path has to say: usually empty, often a
`response:{…}` body or a broker's receipt JSON, and sometimes ordinary prose
(`info: you have left this relay`). Enumerating those was wrong; the operative
rule is that a stored write never carries `duplicate:` or `conflict:`.

The two discard prefixes are closed and exhaustive. Every message that is not
`stored` carries one of them, including the broker paths whose detail is a JSON
object: those put the JSON inside the prefix (`conflict: {"duplicate":true,…}`),
so reading the prefix alone is never wrong.

A `superseded` message names the winning event id in its text.

`duplicate:` therefore carries NIP-01's actual meaning, "I already have this
event", and never appears on a write that was thrown away. That was the old
bug: a discarded write answered `accepted: true` with a bare `duplicate:`.

The prefix is not hand-written per call site. Every `IngestResult` is built by
a constructor that takes a bare reason and prepends
`WriteOutcome::message_prefix` (`crates/buzz-relay/src/handlers/ingest.rs`), so
a relay path cannot pair `already_stored` with a `conflict:` message: there is
no argument through which to say it. `duplicate_write_contract.rs` pins both
the HTTP tokens and the prefix-to-outcome mapping, so changing either reads as
a wire break rather than a refactor.

## Relays that predate this contract

An older relay omits `outcome` entirely and answers a dominated write with
`accepted: true` and a bare `duplicate:`. Against one of those the two cases
genuinely cannot be told apart, so the only safe reading is to treat any
`duplicate:`-prefixed message as a discard regardless of `accepted`, and fail
loudly. `write_conflict_reason` in `crates/buzz-cli/src/client.rs` keeps that
fallback for exactly this reason.
