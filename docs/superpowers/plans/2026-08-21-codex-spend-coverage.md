# Codex Spend Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture honest Codex subscription usage in Spend and deliver every signed usage record through a durable idempotent outbox.

**Architecture:** A guarded compatibility helper exposes codex-acp's existing cumulative counters. The ACP client converts those snapshots into reliable turn deltas, publishes them as `adapter_estimate`, and routes every kind 44210 event through a disk outbox before relay submission. Wire metering stays authoritative for API-key and Colony Credits traffic.

**Tech Stack:** Rust, Tokio, serde, Nostr kind 44210, React, TypeScript, Vitest

---

### Task 1: Add evidence provenance to the ledger contract

**Files:**
- Modify: `crates/buzz-core/src/usage_record.rs`
- Modify: `crates/buzz-core/src/ledger/engine.rs`
- Modify: `crates/buzz-core/src/ledger/crosscheck.rs`
- Modify: `docs/nips/NIP-CL.md`

- [ ] **Step 1: Write failing protocol round-trip tests**

Add tests that deserialize `source: "adapter_estimate"`, preserve
`unknownTokenFields: ["cacheWrite5m", "cacheWrite1h"]`, and keep old records
without the field backward compatible.

- [ ] **Step 2: Run the full core package test suite and confirm failure**

Run: `CI=true cargo test -p buzz-core`

Expected: compilation or deserialization fails because the new enum values and
payload field do not exist.

- [ ] **Step 3: Implement the protocol types**

Add `UsageSource::AdapterEstimate`, a serializable `UsageTokenField` enum, and
`unknown_token_fields: Vec<UsageTokenField>` with `#[serde(default)]`. Update
dedupe so `wire` and `adapter_estimate` both use `provider:requestId`, while
manual records continue to use event ID.

- [ ] **Step 4: Keep cross-check evidence scoped to wire records**

Add a regression proving adapter estimates never enter the wire-versus-agent
cross-check.

- [ ] **Step 5: Run the full core package suite**

Run: `CI=true cargo test -p buzz-core`

Expected: all tests pass.

- [ ] **Step 6: Commit the protocol slice**

Commit message: `feat(ledger): distinguish adapter-estimated usage`

### Task 2: Prepare cumulative Codex adapter usage safely

**Files:**
- Create: `crates/buzz-acp/src/codex_usage_adapter.rs`
- Modify: `crates/buzz-acp/src/lib.rs`
- Modify: `crates/buzz-acp/src/acp.rs`
- Modify: `crates/buzz-acp/Cargo.toml`

- [ ] **Step 1: Write failing compatibility tests**

Cover the supported 1.1.7 adapter source, an unsupported version, a missing
anchor, repeated preparation, and source-digest change. Assert that the
original adapter file is never modified.

- [ ] **Step 2: Run the full ACP package suite and confirm failure**

Run: `CI=true cargo test -p buzz-acp --lib`

Expected: compilation fails because the compatibility helper does not exist.

- [ ] **Step 3: Implement version-guarded sibling preparation**

Resolve the managed package, verify its package version and three exact
`lastTokenUsage` prompt-response anchors, replace them with `totalTokenUsage`,
append a source-digest marker, and atomically write a sibling JavaScript file.
Return a spawn command using the managed Node binary and the sibling script.

- [ ] **Step 4: Record the activated usage semantics on `AcpClient`**

Add an enum that distinguishes ordinary prompt usage from guarded cumulative
Codex usage. Only the latter may feed Spend.

- [ ] **Step 5: Run the full ACP package suite**

Run: `CI=true cargo test -p buzz-acp --lib`

Expected: all tests pass.

- [ ] **Step 6: Commit the adapter slice**

Commit message: `feat(acp): expose cumulative Codex usage safely`

### Task 3: Compute complete turn deltas without inventing cache fields

**Files:**
- Modify: `crates/buzz-acp/src/usage.rs`
- Modify: `crates/buzz-acp/src/acp.rs`
- Modify: `crates/buzz-acp/src/pool.rs`
- Modify: `crates/buzz-acp/src/meter_publish.rs`

- [ ] **Step 1: Write failing cumulative-delta tests**

Use two cumulative snapshots where the second includes multiple model calls.
Assert that the published second-turn delta equals `current - previous`, not
the final model request. Add counter-decrease, all-zero delta, missing
cache-read, and missing cache-write cases.

- [ ] **Step 2: Run the full ACP package suite and confirm failure**

Run: `CI=true cargo test -p buzz-acp --lib`

Expected: the current per-turn accumulator overcounts or invents zero cache
fields.

- [ ] **Step 3: Feed cumulative prompt snapshots into `UsageTracker`**

Replace synthetic per-turn addition with cumulative snapshots. Require input,
output, total, and cache-read fields. Keep cache-write optional and thread its
absence into `unknownTokenFields`.

- [ ] **Step 4: Build `adapter_estimate` usage records**

Use the stable request key `acp:{sessionId}:{turnId}`, imputed payment mode,
captured work context, and explicit evidence source. Do not publish an all-zero
delta. Keep wire records unchanged.

- [ ] **Step 5: Run full ACP and meter package suites**

Run: `CI=true cargo test -p buzz-acp --lib`

Run: `CI=true cargo test -p buzz-meter`

Expected: all tests pass.

- [ ] **Step 6: Commit the normalization slice**

Commit message: `feat(acp): publish cumulative Codex spend estimates`

### Task 4: Add the durable usage outbox

**Files:**
- Create: `crates/buzz-acp/src/usage_outbox.rs`
- Modify: `crates/buzz-acp/src/config.rs`
- Modify: `crates/buzz-acp/src/lib.rs`
- Modify: `crates/buzz-acp/src/pool.rs`
- Modify: `crates/buzz-acp/src/meter_publish.rs`

- [ ] **Step 1: Write failing persistence and replay tests**

Cover atomic persist-before-submit, owner-only file permissions, relay failure,
restart replay, acknowledgement removal, malformed files, capacity bounds, and
same-event retry.

- [ ] **Step 2: Run the full ACP package suite and confirm failure**

Run: `CI=true cargo test -p buzz-acp --lib`

Expected: compilation fails because `UsageOutbox` does not exist.

- [ ] **Step 3: Implement the identity-and-relay scoped outbox**

Derive the directory from a SHA-256 digest of canonical relay URL plus agent
pubkey. Persist one serialized signed event per `{eventId}.json` file with a
bounded file count and size. Use atomic temp-file rename and `0600` files.

- [ ] **Step 4: Route both usage producers through one submit helper**

Persist the event before the first network attempt. Remove only after relay
acknowledgement. Start a bounded retry loop before agents begin work and drain
again during graceful shutdown.

- [ ] **Step 5: Run the full ACP package suite**

Run: `CI=true cargo test -p buzz-acp --lib`

Expected: all tests pass, including restart replay with the exact event ID.

- [ ] **Step 6: Commit the delivery slice**

Commit message: `feat(acp): persist usage records before relay delivery`

### Task 5: Show evidence provenance in Spend

**Files:**
- Modify: `desktop/src-tauri/src/commands/ledger.rs`
- Modify: `desktop/src/features/ledger/report.ts`
- Modify: `desktop/src/features/ledger/ui/LedgerActivity.tsx`
- Modify: `desktop/src/features/ledger/lib/summarize.test.mjs`
- Modify: `desktop/src/features/ledger/ui/LedgerActivity.test.tsx`

- [ ] **Step 1: Write failing parser and rendering tests**

Assert that `adapter_estimate` parses, unknown values fail closed, and the
activity row renders `adapter estimate` independently from `subscription`.

- [ ] **Step 2: Run the full Desktop UI package suite and confirm failure**

Run: `CI=true pnpm --dir desktop test`

Expected: parser or rendering assertions fail because ledger entries do not
carry source.

- [ ] **Step 3: Thread source through Rust and TypeScript views**

Serialize `LedgerEntry.source`, parse the three allowed values, and render the
evidence badge in the activity row.

- [ ] **Step 4: Run full Desktop UI and Rust package suites**

Run: `CI=true pnpm --dir desktop test`

Run: `CI=true cargo test -p buzz-desktop`

Expected: all tests pass.

- [ ] **Step 5: Commit the UI slice**

Commit message: `feat(desktop): label estimated Spend evidence`

### Task 6: Prove the launch path and open the PR

**Files:**
- Modify: `TESTING.md`
- Modify: `crates/buzz-acp/README.md`

- [ ] **Step 1: Run all package gates at the exact branch head**

Run the full `buzz-core`, `buzz-meter`, `buzz-acp`, Desktop Rust, and Desktop UI
package suites. Record `git rev-parse HEAD` with each result.

- [ ] **Step 2: Run a real cumulative Codex tool-loop proof**

Use the managed ChatGPT-authenticated adapter, force at least one tool call,
decrypt the resulting kind 44210 event, and verify nonzero cumulative-derived
input and output with `source: adapter_estimate`.

- [ ] **Step 3: Run the restart fault injection**

Block the relay submit endpoint, complete a Codex turn, verify the signed event
exists in the outbox, restart the harness against a working relay, and verify
the exact event ID is accepted once and removed locally.

- [ ] **Step 4: Perform a clean-context self-review**

Check for false wire labels, duplicate paths, silent zero defaults, unbounded
disk growth, unsafe permissions, debug code, and changes outside the Spend
slice.

- [ ] **Step 5: Commit documentation and final corrections**

Commit message: `docs(spend): document Codex coverage proof`

- [ ] **Step 6: Push and open a PR into `develop`**

Use the nocodeafrica token for the push and GitHub write. Open the PR with
`buzz pr open --channel 0b41ede9-9fb3-4a4d-9566-60c70a0403d2` so the Product
thread remains linked.

- [ ] **Step 7: Watch CI, rebase, and merge only when current**

Wait for every check to pass. Rebase on current `origin/develop`, rerun CI if
the head changes, then merge to `develop`. Do not promote to `main` without a
new explicit written approval from Basheer.
