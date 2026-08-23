# Observer frames are silently dropped by a 127-byte cap mismatch

## The bug, already diagnosed

Two constants disagree about the NIP-44 plaintext limit:

- Ours: `OBSERVER_MAX_PLAINTEXT_LEN = 65_535` in `crates/buzz-core/src/observer.rs:25`.
- nostr 0.44.7's real limit: `MAX_SUPPORTED_PLAINTEXT_SIZE = 65_536 - 128 = 65_408`,
  a private constant in `nip44/v2.rs:35`. `encrypt` returns
  `Error::MessageTooLong` above it.

Any frame whose serialized plaintext lands in `65_409..=65_535` passes our check
and is then rejected by the encryptor. `publish_relay_observer_event`
(`crates/buzz-acp/src/lib.rs:1085-1091`) logs a warning and returns, dropping the
frame.

Two code paths aim directly into that dead window:

1. `fit_observer_event_to_budget` (`lib.rs:944`) trims oversized frames until they
   are at or under 65_535, which frequently means landing just above 65_408.
2. The batcher (`lib.rs:599`) fills a frame with queued events until adding one
   more would exceed 65_535.

The batcher is what makes this visible in the product: a dropped batch takes every
event inside it, including `turn_started` and `turn_liveness`. The desktop then
prunes the turn after ~25s (`REMOVE_AFTER_MS` in
`desktop/src/features/agents/activeAgentTurnsStore.ts`) and the working badge
disappears while the agent is still working.

## Evidence

From live agent logs on this machine, at
`~/Library/Application Support/xyz.block.buzz.app/agents/logs/`:

```
296 occurrences in one session (2026-08-21 21:03 to 21:24)
283 in another session the same evening
629 across all logs on disk
"failed to encrypt relay observer event: NIP-44 error: message too long"
```

This is not theoretical and it is happening on every busy agent.

## Task 1: the failing test first

Add to `crates/buzz-core/src/observer.rs` tests:

1. A payload serializing to exactly `OBSERVER_MAX_PLAINTEXT_LEN` bytes encrypts
   successfully via `encrypt_observer_payload`. **This fails today.** It is the
   test that pins our cap to the encryptor's real limit, and it will fail again if
   a future nostr release lowers it.
2. A payload one byte over the cap is rejected by our own
   `ObserverPayloadError::PlaintextTooLarge`, not by NIP-44. Our check must be the
   one that fires.

Add to `crates/buzz-acp` tests:

3. `fit_observer_event_to_budget` applied to an oversized event always produces
   something `encrypt_observer_payload` accepts. Drive it with several input sizes
   that straddle the boundary, including one that trims into the old dead window.
4. A batch gathered by the packer always encrypts successfully. Same straddling
   sizes.

Run all four against unmodified code and confirm they fail. Paste that output into
your report. A test that passes before the fix is testing nothing.

## Task 2: the fix

Lower `OBSERVER_MAX_PLAINTEXT_LEN` to `65_408` in
`crates/buzz-core/src/observer.rs`, with a comment naming
`nostr::nips::nip44::v2::MAX_SUPPORTED_PLAINTEXT_SIZE` and the reason for the 128
bytes. Do not try to import the nostr constant; it is private. The boundary test
from Task 1 is what keeps the two in sync.

Then review the two places that are keyed to it:

- `OBSERVER_CHUNK_MAX_TEXT_BYTES = 60_000` (`crates/buzz-acp/src/lib.rs:787`). Its
  own doc comment says to review it whenever the plaintext cap changes. Work out
  whether 60_000 still leaves room under 65_408 for envelope overhead, and say so
  in your report with the arithmetic. Change it only if the arithmetic says you
  must.
- `NIP44_MAX_CONTENT_LEN = 87_472` (`observer.rs:23`). Confirm it is the base64
  content bound and not affected. State your conclusion.

## Task 3: do not paper over it

Leave the warn-and-drop in `publish_relay_observer_event` in place. It is the
correct last-resort behaviour and it is how this bug was found.

Do NOT change `REMOVE_AFTER_MS` or any desktop file. The desktop is correct here:
it stopped receiving frames, so it correctly concluded the turn ended. Another
agent is working in `desktop/src/features/agents/activeAgentTurnsStore.ts` on a
separate branch, so touching it also causes a conflict.

## Gates

```
. ./bin/activate-hermit
cargo test -p buzz-core observer
cargo test -p buzz-acp observer
cargo clippy -p buzz-core -p buzz-acp
cargo fmt
```

**Do NOT run `just ci`.** It saturates the owner's machine for about ten minutes
and he is working on it. The full matrix runs on GitHub when the orchestrator
pushes. `just test` is not required: this touches no schema and no relay path.

## Definition of done

- All four tests pass, with the earlier failing output saved.
- Targeted crate tests and clippy pass. The full matrix runs on GitHub.
- Files touched: `crates/buzz-core/src/observer.rs`, `crates/buzz-acp/src/lib.rs`
  and their tests. Nothing under `desktop/`.
- Every commit uses `git commit -s`.
- Do NOT open a PR and do NOT merge. Commit to the current branch and report back.

## Report back with

1. Failing output from before the fix, for at least tests 1 and 3.
2. Passing output after, plus the targeted test and clippy results.
3. Your arithmetic on `OBSERVER_CHUNK_MAX_TEXT_BYTES` and your conclusion on
   `NIP44_MAX_CONTENT_LEN`.
4. Whether any other call site encrypts an observer payload without going through
   `fit_observer_event_to_budget` first. If one exists, name it and do not fix it
   without saying so.
