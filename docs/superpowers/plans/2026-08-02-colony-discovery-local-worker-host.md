# Colony Discovery Local Worker Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that Colony Desktop can safely store an Outscraper credential and, only under an explicit proof flag, execute an eligible Discovery run through the existing signed lease/checkpoint protocol without external provider traffic or secret exposure.

**Architecture:** Extend the existing desktop `SecretStore` with one Discovery namespace and expose status-only Tauri commands. Add a native `discovery_worker` module whose host owns a stable local UUID, snapshots the current workspace identity, drives the existing `buzz-sdk` worker envelopes, verifies relay-authored receipts, and runs a network-incapable fake adapter under a default-off environment gate. Keep the fixture-backed React Discovery surface unchanged.

**Tech Stack:** Rust, Tauri 2, Tokio, Nostr events, `buzz-core`, `buzz-sdk`, OS keychain, React/TypeScript invoke wrappers, existing Postgres/Redis relay proof harness.

---

## Task 1: Lock the credential and startup contracts with failing tests

**Files:**
- Create: `desktop/src-tauri/src/discovery_credentials.rs`
- Create: `desktop/src-tauri/src/discovery_credentials/tests.rs`
- Create: `desktop/src/shared/api/discoveryCredentials.ts`
- Create: `desktop/src/shared/api/discoveryCredentials.test.mjs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/package.json`

- [x] Add Rust tests for the public safe enum `DiscoveryCredentialStatus::{Configured, Missing, Unavailable}`, trimmed-empty rejection, idempotent deletion, and status-only serialized results. Use an injected test store so unit tests never touch a developer keychain.
- [x] Add a test proving `fake_local_worker_enabled` defaults false and accepts only case-insensitive `1` or `true`; values such as `yes`, an empty string, and malformed Unicode remain disabled.
- [x] Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_credentials --no-default-features`; expect compilation or assertions to fail because the module is not implemented.
- [x] Add a Node contract test asserting the TypeScript wrapper invokes exactly `save_discovery_outscraper_credential`, `get_discovery_outscraper_credential_status`, and `delete_discovery_outscraper_credential`, and does not model or return a secret value.
- [x] Run `cd desktop && node --test src/shared/api/discoveryCredentials.test.mjs`; expect failure because the wrapper does not exist.

## Task 2: Implement the existing-keychain credential boundary

**Files:**
- Modify: `desktop/src-tauri/src/discovery_credentials.rs`
- Modify: `desktop/src-tauri/src/discovery_credentials/tests.rs`
- Modify: `desktop/src-tauri/src/secret_store.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src/shared/api/discoveryCredentials.ts`
- Modify: `desktop/src/shared/api/discoveryCredentials.test.mjs`
- Modify: `desktop/package.json`

- [x] Define the fixed key `discovery.outscraper.api_key` inside the existing shared keychain blob. Do not add a file or environment fallback.
- [x] Implement internal `CredentialStore` operations over `SecretStore::shared(keyring_service())`: probe, load into `zeroize::Zeroizing<String>`, store, raw read-back verification, and delete. Map keychain failures to `Unavailable` without returning backend text through Tauri.
- [x] Implement Tauri save/status/delete commands. Save trims and rejects empty input, performs blocking keychain I/O through `spawn_blocking`, verifies the durable value, and returns only `Configured`. Status and delete return only safe enum values.
- [x] Add `SecretStore` test support only where required for dependency injection; do not broaden its production API to expose the whole secret blob.
- [x] Implement the focused TypeScript invoke wrapper and export only the three safe statuses.
- [x] Register the commands in `commands/mod.rs` and `lib.rs`; add the Node contract test to the existing desktop unit-test script rather than creating a separate CI path.
- [x] Run the Rust and Node commands from Task 1; expect all tests to pass.
- [x] Commit with `git commit -s -m "feat(discovery): secure Outscraper credentials"`.

## Task 3: Prove the real OS-keychain lifecycle

**Files:**
- Modify: `desktop/src-tauri/src/discovery_credentials/tests.rs`
- Modify: `desktop/src-tauri/src/secret_store.rs`

- [x] Add one ignored, feature-gated test using a unique temporary key name in the real `SecretStore`. It must save a fixture value, raw-verify it, probe `Present`, load internally, delete it, and probe `ReachableButEmpty`.
- [x] Ensure cleanup runs even after an assertion failure and the fixture value is never printed in assertion messages.
- [x] Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_credentials::tests::real_os_keychain -- --ignored --nocapture`; expect one pass on the macOS keychain.
- [x] Search captured output with `rg -F 'colony-discovery-keychain-fixture-9e3c2a61'`; expect zero matches.
- [x] Commit with `git commit -s -m "test(discovery): prove Outscraper keychain boundary"`.

## Task 4: Add a stable local worker identity and default-off startup gate

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/mod.rs`
- Create: `desktop/src-tauri/src/discovery_worker/installation.rs`
- Create: `desktop/src-tauri/src/discovery_worker/tests.rs`
- Modify: `desktop/src-tauri/src/lib.rs`

- [x] Add failing tests that load the same UUID across two host constructions, replace malformed/zero UUID files safely, and verify owner-only permissions on Unix.
- [x] Implement `app_data_dir/discovery/worker-id` with a `0700` parent and an atomic `0600` write using the repository's `atomic-write-file` pattern. Validate with `Uuid::parse_str` and reject the nil UUID.
- [x] Add a failing startup test proving the host is not spawned when the fake-worker flag is absent, false, or malformed, and is eligible to spawn only for `1` or `true` outside recovery mode.
- [x] Wire one Tauri-owned background task into `setup()` behind that exact gate. The loop must observe `shutdown_started` and must not start in identity-lost, keyring-locked, or reset-failed recovery modes.
- [x] Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_worker::tests`; expect all focused tests to pass.
- [x] Commit with `git commit -s -m "feat(discovery): add gated local worker identity"`.

## Task 5: Implement and test strict relay receipt verification

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/protocol.rs`
- Create: `desktop/src-tauri/src/discovery_worker/protocol_tests.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/mod.rs`

- [x] Add tests that build signed claim, heartbeat, checkpoint, and complete actions with the existing `buzz-sdk` builders.
- [x] Add adversarial receipt tests for wrong author, wrong `p` recipient, wrong action event ID, wrong worker/request/idempotency IDs, invalid signature, wrong kind, and missing receipt timeout. Every case must fail closed.
- [x] Implement `RelayWorkerProtocol`: snapshot current signing keys and relay base URL, fetch and validate the relay's NIP-11 `self` pubkey, submit an action, parse the returned `receipt_event_id`, query kind `40020` by exact ID/author/recipient, verify the Nostr signature, and parse with `parse_discovery_worker_receipt`.
- [x] Match the receipt to the submitted action before returning its `DiscoveryWorkerReceiptOutcome`; never trust the submit response's embedded outcome as the authority.
- [x] Keep logs metadata-only: operation, run ID, worker ID, and safe correlation IDs. Do not log event content, provider responses, command bodies, or keychain errors.
- [x] Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_worker::protocol`; expect all focused tests to pass.
- [x] Commit with `git commit -s -m "feat(discovery): verify local worker receipts"`.

## Task 6: Implement the network-incapable fake adapter and lease supervisor

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/adapter.rs`
- Create: `desktop/src-tauri/src/discovery_worker/host.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/tests.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/mod.rs`
- Modify: `desktop/src-tauri/src/app_state.rs`
- Modify: `desktop/src-tauri/src/commands/workspace.rs`

- [x] Add deterministic host tests using injected protocol and credential doubles. Prove missing/unavailable credentials send zero claims; idle leases poll without adapter work; one host owns one lease at a time; and no adapter type can access an HTTP client or URL.
- [x] Add fresh-run tests for `provider_submitted` sequence 1, `provider_results_ready` sequence 2, heartbeat renewal, and complete.
- [x] Add resume tests showing a reclaimed lease after sequence 1 begins at sequence 2 and never repeats sequence 1.
- [x] Add cancellation and revocation tests where a heartbeat yields `LostLease`: cancel the adapter token immediately, send no later checkpoint or completion, and ignore any delayed adapter result.
- [x] Add a workspace-generation counter to `AppState`; increment it after a successful `apply_workspace`. The host snapshots the generation/relay/identity and abandons the attempt if any changes, without holding `community_operation_lock` during network I/O.
- [x] Implement the fake adapter with only a borrowed `Zeroizing<String>`, a cancellation token, the prior checkpoint, and deterministic fixture constants. It must not contain `reqwest`, URLs, sockets, or provider SDK types.
- [x] Implement bounded heartbeat scheduling from `lease_until`, clamped to renew before expiry. Shutdown or generation changes cancel current work and leave recovery to lease expiry.
- [x] Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_worker`; expect all unit and adversarial tests to pass.
- [x] Commit with `git commit -s -m "feat(discovery): run fenced fake worker locally"`.

## Task 7: Prove the native host against the real relay

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/live_proof_tests.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/mod.rs`
- Create: `scripts/discovery-worker-live-proof.sh`
- Modify: `docs/superpowers/specs/2026-08-02-colony-discovery-outscraper-businesses-design.md`

- [x] Extend the existing isolated Postgres/Redis/relay proof script to launch the native host test with explicit relay URL, human key, group, and fake-worker flag. Use fresh ports and databases rather than a developer relay.
- [x] Prove eligible claim, at least one heartbeat, checkpoint sequences 1 and 2, and completion through relay-authored signed receipts.
- [x] Pause after sequence 1, terminate the first host, wait for lease expiry, start a second host with the same installation UUID, and prove attempt 2 resumes at sequence 2 without another sequence 1.
- [x] In separate runs, cancel and revoke entitlement while paused; prove `LostLease`, zero later checkpoints, and stale completion rejection.
- [x] Run the live harness without a credential and expect zero worker actions; separately prove with the startup-gate tests that a missing or disabled fake flag cannot start the host.
- [x] Search captured process output, Nostr events, and Discovery database rows for the fixture secret; expect zero matches.
- [x] Record exact commands, commit hashes, counts, and failure corrections in the evidence document.
- [x] Run `scripts/discovery-worker-live-proof.sh`; expect a final explicit PASS summary for every scenario.
- [x] Commit with `git commit -s -m "test(discovery): prove native worker host end to end"`.

## Task 8: Run the full acceptance gate

**Files:**
- Modify only files required to correct failures attributable to this branch.

- [x] Run `cargo fmt --all -- --check` and `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check`; expect no diff.
- [x] Run `cd desktop && pnpm lint && pnpm test`; expect all desktop checks to pass.
- [x] Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_`; expect focused Rust tests to pass.
- [x] Run `just ci`; expect the repository's complete local gate to pass. If a failure also reproduces on clean `origin/develop`, record it as baseline rather than claiming to fix it.
- [x] Run `rg -n "TODO|TBD|placeholder|example\.com|sk-[A-Za-z0-9]" desktop/src-tauri/src/discovery_credentials.rs desktop/src-tauri/src/discovery_worker desktop/src/shared/api/discoveryCredentials.ts`; expect zero incomplete markers or secret-like fixtures in production files.
- [x] Verify `git diff --check`, `git status --short`, and `git log --show-signature -8 --oneline`; expect no whitespace errors, only intentional changes, and signed commits.
- [x] Update the proof document with what is implemented, locally tested, and committed, while keeping merged, deployed, and customer-proven explicitly unclaimed.
- [x] Commit documentation corrections with `git commit -s -m "docs(discovery): record local worker host gate"`.

## Acceptance gate result

The phase passes only when all thirteen requirements in `docs/superpowers/specs/2026-08-02-colony-discovery-local-worker-host-design.md` have command-backed evidence. A unit-test-only result, a fake in-memory relay, a credential returned through IPC, a worker that starts without the explicit flag, or a proof that contacts an external provider is a failed gate.
