# Gateway Missing Provider ID Idempotency Implementation Plan

> **For agentic workers:** Execute inline in this session. No delegation is authorized for this recovery lane.

**Goal:** Prevent restart reconciliation from debiting a completed gateway call twice when the provider supplied no request ID.

**Architecture:** Preserve the durable settlement intent reference as the correlation key for normal debits that lack a provider request ID. The resolver first proves whether a matching debit already exists; only an unmatched intent receives the deterministic recovery debit. Existing ledger transactions and the `(pubkey, ref)` uniqueness constraint remain the exactly-once boundary.

**Tech Stack:** Rust, Tokio, SQLx, PostgreSQL, Colony gateway integration tests.

---

### Task 1: Prove the defect before editing production code

**Files:**
- Test: `crates/buzz-relay/src/gateway/tests.rs`

- [x] Add a regression that creates an intent, commits the normal debit under `intent.reference` with no request ID, leaves the intent unresolved to simulate the lost acknowledgement, reconnects through a fresh database pool, and runs resolver replay.
- [x] Run the single regression and require failure with two ledger rows rather than one.

### Task 2: Correlate the stable intent-reference debit

**Files:**
- Modify: `crates/buzz-db/src/credits.rs`

- [x] When provider request ID is absent, always reuse the durable `intent.reference` used by normal settlement.
- [x] Send the recovery through the existing transactional debit path so `(pubkey, ref)` uniqueness makes an already-committed debit a no-op and inserts a genuinely missing debit exactly once.
- [x] Keep the resolver replay idempotent if the process fails after the recovery debit but before the intent-state acknowledgement.

### Task 3: Verify and publish

**Files:**
- Test: `crates/buzz-relay/src/gateway/tests.rs`
- Modify: `crates/buzz-db/src/credits.rs`

- [x] Run the regression green and assert exactly one ledger debit and one balance change.
- [x] Run the focused gateway test target, formatting, lint, and the relevant broader local gate.
- [ ] Commit with DCO signoff, push a `codex/` branch, open a PR to `develop`, and arm auto-merge.
- [ ] Report implementation, local proof, PR, CI, merge, deployment, and live proof as distinct states.
