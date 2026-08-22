# Paystack top-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add money to their workspace with a card, through Paystack's hosted checkout, crediting the ledger that already exists.

**Architecture:** Paystack hosts the checkout, so Colony never sees card data. An intent row written at initialize time maps a reference back to a pubkey and an expected amount. A signature-verified webhook is the only thing that credits the ledger; the browser return URL is treated as a hint and nothing more.

**Tech Stack:** Rust (axum, sqlx, hmac, sha2, reqwest), Postgres, TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-22-paystack-topups-design.md`

## Global Constraints

- **Never run `just ci`.** Verify with the narrow gates: `cargo test -p <crate>`, `pnpm check`, `pnpm typecheck`, or a single test file. Push and let GitHub CI run the matrix.
- **Never run a full desktop or Playwright suite.** Scope to the spec file you changed. This machine is shared with a person working on it.
- **Never call the live Paystack API from a test.** Fake the client at the trait boundary. A test that spends real money, or that fails when a third party is slow, is worse than no test.
- **Colony must never hold card data.** No card number, expiry or CVV field anywhere. If a task seems to need one, stop and say so.
- **Only the signature-verified webhook credits the ledger.** No client-callable route may move money.
- **`git commit -s`.** The DCO check fails commits without a `Signed-off-by` trailer.
- **Activate hermit first:** `. ./bin/activate-hermit`.
- **No `unsafe`**, no new `unwrap()`/`expect()` outside tests, doc comments on new public API.
- **No em dashes** anywhere, including comments and commit messages.
- **No developer jargon in user-visible copy.** Never transaction, gateway, webhook, reference, or authorization URL on screen. Never "your Mac"; say "your computer".
- **Before adding a migration**, run `git ls-tree -r --name-only origin/develop migrations/ | tail -3` and take the next free number. Two branches picked the same number on 2026-08-22 and Postgres refused the pair.
- **A suite that reports success while running zero tests is not evidence.** Several suites here are `#[ignore]`d by default; say so and find the command that actually runs them.

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/buzz-relay/src/paystack.rs` | Paystack HTTP client behind a trait, plus webhook signature verification |
| `migrations/00NN_payment_intents.sql` | `payment_intents` table, fenced |
| `crates/buzz-db/src/payment_intents.rs` | intent SQL: create, find, settle |
| `crates/buzz-db/src/deletion.rs` | register the new table in the deletion catalogs |
| `crates/buzz-relay/src/api/payments.rs` | initialize, verify, webhook |
| `desktop/src/features/onboarding/paymentsService.ts` | real `payments` contract |

---

### Task 1: Paystack client and signature verification

Pure logic plus one HTTP call behind a trait. Everything testable without a network.

**Files:**
- Create: `crates/buzz-relay/src/paystack.rs`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-relay/Cargo.toml` (hmac, if absent)

**Interfaces:**
- Produces:
  - `pub fn nano_usd_from_cents(cents: i64) -> Result<i64, PaystackError>`
  - `pub fn verify_signature(raw_body: &[u8], signature_header: &str, secret: &str) -> bool`
  - `pub trait PaystackApi { async fn initialize(&self, usd_cents: i64, email: &str, reference: &str) -> Result<String, PaystackError>; }`
  - `pub struct LivePaystack { secret: String, client: reqwest::Client }`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // A cent is ten million nanoUSD. The ledger stores nanoUSD, the contract
    // and Paystack both speak cents, and mixing them silently misprices
    // everything by seven orders of magnitude.
    #[test]
    fn converts_cents_to_nano_usd() {
        assert_eq!(nano_usd_from_cents(500).unwrap(), 5_000_000_000);
        assert_eq!(nano_usd_from_cents(1).unwrap(), 10_000_000);
    }

    #[test]
    fn rejects_a_negative_amount() {
        assert!(nano_usd_from_cents(-1).is_err());
    }

    #[test]
    fn rejects_an_amount_that_would_overflow() {
        assert!(nano_usd_from_cents(i64::MAX).is_err());
    }

    #[test]
    fn accepts_a_correct_signature() {
        let secret = "sk_test_example";
        let body = br#"{"event":"charge.success"}"#;
        let signature = hex_hmac_sha512(secret, body);
        assert!(verify_signature(body, &signature, secret));
    }

    #[test]
    fn rejects_a_tampered_body() {
        let secret = "sk_test_example";
        let signature = hex_hmac_sha512(secret, br#"{"event":"charge.success"}"#);
        assert!(!verify_signature(br#"{"event":"charge.failed"}"#, &signature, secret));
    }

    #[test]
    fn rejects_a_wrong_secret() {
        let body = br#"{"event":"charge.success"}"#;
        let signature = hex_hmac_sha512("sk_test_example", body);
        assert!(!verify_signature(body, &signature, "sk_test_other"));
    }

    #[test]
    fn rejects_a_malformed_signature_header() {
        assert!(!verify_signature(b"{}", "not-hex", "sk_test_example"));
        assert!(!verify_signature(b"{}", "", "sk_test_example"));
    }

    // The one that matters most. Paystack signs the bytes it sent. Parsing the
    // JSON and re-serialising it produces different bytes for the same object,
    // so a handler that verifies against re-serialised JSON rejects every real
    // webhook while passing any test that round-trips through a struct.
    #[test]
    fn verifies_raw_bytes_not_reserialised_json() {
        let secret = "sk_test_example";
        let raw = b"{ \"event\" : \"charge.success\" ,  \"data\" : { } }";
        let signature = hex_hmac_sha512(secret, raw);
        assert!(verify_signature(raw, &signature, secret));

        let reserialised = serde_json::to_vec(
            &serde_json::from_slice::<serde_json::Value>(raw).unwrap(),
        )
        .unwrap();
        assert_ne!(raw.to_vec(), reserialised, "fixture must actually differ");
        assert!(!verify_signature(&reserialised, &signature, secret));
    }

    /// Test-only helper mirroring what Paystack does when it signs a request.
    fn hex_hmac_sha512(secret: &str, body: &[u8]) -> String {
        use hmac::{Hmac, Mac};
        let mut mac = <Hmac<sha2::Sha512>>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(body);
        hex::encode(mac.finalize().into_bytes())
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay paystack
```

Expected: compile failure, the module does not exist.

- [ ] **Step 3: Implement**

Requirements the tests pin:

- `nano_usd_from_cents` uses `checked_mul(10_000_000)` and rejects negatives.
- `verify_signature` computes HMAC-SHA512 over the raw bytes and compares with a **constant-time** equality (`subtle::ConstantTimeEq`, already a workspace dependency), never `==`. A non-hex or wrong-length header returns `false` rather than erroring.
- `PaystackApi` is a trait so tests can fake it. `LivePaystack` posts to `https://api.paystack.co/transaction/initialize` with `Authorization: Bearer <secret>`, a body of `{amount, email, reference, currency: "USD"}`, and returns `data.authorization_url`.
- Module doc states plainly: the webhook signature is the only authority for crediting, and it must be checked before parsing.

- [ ] **Step 4: Run them and watch them pass**

```bash
. ./bin/activate-hermit && cargo test -p buzz-relay paystack
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-relay/src/paystack.rs crates/buzz-relay/src/lib.rs crates/buzz-relay/Cargo.toml
git commit -s -m "feat(relay): add the Paystack client and webhook signature check

Signature verification runs on raw bytes. Re-serialised JSON produces
different bytes for the same object, so verifying after parsing would
reject every real webhook while passing any struct round-trip test."
```

---

### Task 2: Intent table and store

**Files:**
- Create: `migrations/00NN_payment_intents.sql` (take the next free number, see Global Constraints)
- Create: `crates/buzz-db/src/payment_intents.rs`
- Modify: `crates/buzz-db/src/lib.rs`
- Modify: `crates/buzz-db/src/deletion.rs`
- Modify: `crates/buzz-db/src/migration.rs` (the count assertion)

**Interfaces:**
- Produces:
  - `pub struct PaymentIntent { pub reference: String, pub pubkey: Vec<u8>, pub usd_cents: i64, pub status: String, pub paid_cents: Option<i64> }`
  - `pub async fn create_intent(pool, community, reference, pubkey, usd_cents) -> Result<()>`
  - `pub async fn find_intent(pool, community, reference) -> Result<Option<PaymentIntent>>`
  - `pub async fn settle_intent(pool, community, reference, paid_cents) -> Result<bool>`

- [ ] **Step 1: Read the neighbours first**

Read `crates/buzz-db/src/email_accounts.rs` end to end. It is the most recent table in this codebase and it already solved every problem you are about to hit: tenant scoping, the write fence, deletion-catalog registration, and the migration count assertion. Match it rather than inventing a second shape. Its test module also shows the real fixture helper, `make_test_community`, and that these tests are `#[tokio::test]` plus `#[ignore = "requires Postgres"]`.

- [ ] **Step 2: Write the failing tests**

Cover: create then find; a duplicate reference is rejected; an intent in community A is invisible from community B; `settle_intent` marks paid once and returns `false` on a second call; a settled intent keeps its original `usd_cents` alongside the recorded `paid_cents`.

- [ ] **Step 3: Run them and watch them fail**

```bash
. ./bin/activate-hermit && ./scripts/start-isolated-test-relay.sh
. ./bin/activate-hermit && cargo test -p buzz-db payment_intents -- --include-ignored
```

The `--include-ignored` is required. Without it the command reports success while running nothing.

- [ ] **Step 4: Implement, then run them and watch them pass**

`settle_intent` must be a single conditional `UPDATE ... WHERE status = 'pending' ... RETURNING`, so two concurrent webhook retries cannot both see a pending row.

- [ ] **Step 5: Commit**

---

### Task 3: Initialize and verify routes

**Files:**
- Create: `crates/buzz-relay/src/api/payments.rs`
- Modify: `crates/buzz-relay/src/api/mod.rs`, `crates/buzz-relay/src/router.rs`

**Interfaces:**
- Consumes: Task 1 (`PaystackApi`, `nano_usd_from_cents`), Task 2 (the store).
- Produces: `pub async fn initialize(...)`, `pub async fn verify(...)`.

Read `crates/buzz-relay/src/api/accounts.rs` first for the house style: typed error strings, community from the request host, rate limiting.

Requirements:
- Both routes are NIP-98 signed. The pubkey comes from the signature, never the body. By screen 9 the user has a key, so unlike the account routes these can be signed.
- Minimum `500` cents, rejected as `amount_too_small`.
- `verify` reads our own intent row and **never credits**. A client-callable route that moves money is the bug this design exists to avoid.
- Rate limit both, keyed on the pubkey.

- [ ] Steps: failing tests for validation, run, implement, run, commit. Follow the shape of Task 1.

---

### Task 4: The webhook

**Files:**
- Modify: `crates/buzz-relay/src/api/payments.rs`, `crates/buzz-relay/src/router.rs`

- [ ] **Step 1: Write the failing tests**

Cover, at the handler level with a faked store:
- a correct signature on `charge.success` credits exactly once
- a replayed delivery credits zero more times
- a tampered signature returns `401` and credits nothing
- an unknown reference returns `200` and credits nothing
- an event type we do not handle returns `200` and credits nothing

- [ ] **Step 2: Implement**

Requirements:
- Take the body as `axum::body::Bytes` and verify **before** parsing. If you find yourself calling `Json<T>` in the handler signature, that is the bug from Task 1's last test.
- Credit with `credits::credit(pubkey, nano_usd_from_cents(paid_cents), reference)`.
- Credit and settle run in **one transaction**. A crash between them would leave money credited against an intent that still reads pending, and every retry would then try to credit again.
- Return `200` for everything understood, including ignored events, so Paystack stops retrying.
- Never log the secret key or the raw signature.

- [ ] Steps: run failing, implement, run passing, commit.

---

### Task 5: Desktop payments service

**Files:**
- Create: `desktop/src/features/onboarding/paymentsService.ts`, `paymentsService.test.mjs`
- Modify: `desktop/src/features/onboarding/contracts.fake.ts` if the fake needs to match a changed shape

Read `desktop/src/features/onboarding/authService.ts` first and follow it exactly: injected dependencies, a typed failure union with a `kind` field, no HTTP status ever reaching a screen.

Cover in tests: initialize returns a URL; verify maps `paid` through; a network failure becomes `unreachable`; an amount below the minimum is refused before any request; a `rate_limited` response maps to the wait state rather than a retry banner, matching what `authService` does.

- [ ] Steps: failing tests, run, implement, run, `pnpm check` and `pnpm typecheck`, commit.

---

### Task 6: Integration coverage

**Files:**
- Create: `crates/buzz-test-client/tests/e2e_payments.rs`

Read `crates/buzz-test-client/tests/e2e_accounts.rs` first and copy its harness setup.

Cover the full round trip against a live relay with a faked Paystack: initialize writes a pending intent; a signed webhook credits the balance exactly once; a replay changes nothing; a tampered signature is refused; an intent in community A is invisible from community B; the balance visible through `credits::balance` matches what was paid.

- [ ] Steps: failing tests, run with the isolated harness, fix what the round trip exposes, run passing, commit, open a PR against develop and arm auto-merge.

---

## Self-Review

**Spec coverage:** client and signature (Task 1), data model (Task 2), the three routes (Tasks 3 and 4), desktop (Task 5), testing (throughout plus Task 6). The units rule is enforced by Task 1's first two tests and used by Task 4.

**Known gaps, stated rather than hidden:**
- The migration number is deliberately `00NN`. It must be resolved against develop at implementation time, because two branches collided on this exact thing on 2026-08-22.
- Screen 9's UI work is not in this plan. The screens exist and render against fakes; Task 5 swaps the service beneath them. If a screen turns out to need new states, that is a follow-up, not a silent expansion here.
- Whether the Paystack account is in test or live mode is unresolved and is called out in the spec's open questions. Shipping against test keys takes real money nowhere, so it must be checked before the flow is enabled for anyone.
