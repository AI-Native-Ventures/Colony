# Colony Phase 3: Deterministic Cost Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic cost ledger: wire-level metering of every model call an agent makes, effective-dated pricing, COGS/OPEX/Needs Review attribution, corrections that never rewrite raw usage, and reconciliation against provider-reported spend.

**Architecture:** A localhost metering checkpoint (`buzz-meter`) sits between agent subprocesses and model providers via base-URL env injection; it records provider-itemized token counts off the wire (the agent never self-reports the source of record) and the harness publishes one immutable encrypted `kind:44210` usage record per provider request. Owner-signed ledger actions (`kind:40017`) go through a relay broker (same pattern as the Phase 2 party broker) that maintains four NIP-33 heads: price book, attribution rulebook, correction book, and budgets. A pure deterministic engine in `buzz-core::ledger` folds usage records + books into the ledger report; it runs identically from the CLI (`buzz ledger`) and the desktop Tauri backend.

**Tech Stack:** Rust (buzz-core, buzz-relay, buzz-meter [new crate], buzz-acp, buzz-cli), axum/hyper for the meter proxy, NIP-44 v2 encryption (existing `observer.rs` helpers), NIP-33 parameterized-replaceable heads, React/TS for the minimal desktop slice.

## Status: complete, 2026-08-02

All thirteen tasks are done and merged to `develop`, shipping in relay
`v0.3.0`.

**The proof that mattered.** A real DeepSeek call was captured at the wire with
the provider's own itemization (10 uncached input tokens, 2 output), recorded
under `provider: "deepseek"`, while the caller held only a `colony-vk-` virtual
key and the real credential never left the checkpoint. That closes the gap this
phase existed to close: neither `opencode acp` nor `goose acp` reports usage
over ACP on this machine, and the ledger no longer needs them to.

**Seven defects found by running things rather than reasoning about them.**
None were visible to unit tests that already passed:

1. *Kind classification.* Every ledger action was refused `restricted: unknown
   event kind`, the same defect the party phase shipped and only found at a
   live gate. Caught here by a classification test written before the code,
   along with a ban-gate bypass on the ledger action.
2. *Credential leak across headers.* Swapping the expected credential header
   was not enough: a credential placed in the other provider's header was
   forwarded upstream intact. Found by mutation, since nothing pinned it.
3. *Compression hid spend.* Most provider SDKs request gzip by default and a
   compressed body could not be parsed, so real agents would have been largely
   unmetered while every test kept passing. The checkpoint now requests
   identity encoding.
4. *Wrong vendor on the record.* A live DeepSeek call was recorded as
   `provider: "openai"` because DeepSeek uses the OpenAI-compatible route.
   Reconciliation compares per provider, so that spend would have been checked
   against an invoice that never contained it.
5. *Nonsense vendor from an address.* The fix for (4) then derived vendor `"0"`
   from a `127.0.0.1` upstream. An address is not a vendor.
6. *A published price could silently fail to take effect.* Two appends inside
   the same second collided under NIP-33 replacement ordering, so the second
   was discarded.
7. *The broker did not honour its own contract.* Its doc comment said "not the
   owner" means refuse without storing; only the transaction-internal check
   enforced that, and it ran last. Visible only on a **second** run against the
   same database.

**Deviations from the plan, all deliberate.**

- The action and receipt envelope went in `buzz-sdk`, not `buzz-core`, mirroring
  `party.rs`.
- Ledger kinds are 40023/40024, not 40017/40018: Discovery merged first and
  claimed those. Migrations renumbered to 0037/0038 past Discovery's.
- `canonical_json` is `buzz_core::block::canonical_json`.
- Adding a kind to `P_GATED_KINDS` carries a storage obligation: it must also be
  excluded from the FTS generated column, and new FTS migrations must be
  appended to the `fts_integration` chain.
- Task 11 shipped a data layer with no UI component. Parties and company both
  shipped that way; chat is the surface, and a view with no mount point is dead
  code.
- The live E2E suite cannot isolate itself, because the books are singleton
  coordinates and append-only. It must run against a disposable relay and
  database, never a shared or deployed one.

**Follow-ups not done here.** ~~Codex base-URL injection, since codex reads
providers from `CODEX_CONFIG` rather than env and its agents are therefore
currently unmetered~~ (closed 2026-08-03: codex agents are metered via the
codex-acp ACP `providers/set` custom gateway, not `CODEX_CONFIG` — the
adapter forces the gateway provider onto every session and skips the ChatGPT
login gate; see the live proof in TESTING.md); automated fetch of provider
cost exports for reconciliation; a desktop corrections UI; and a cross-check
report comparing NIP-AM self-reports against wire records.

## Owner decisions locked (2026-08-02)

These were decided explicitly by the owner in review; do not re-litigate:

1. **Wire checkpoint is the source of record, not agent self-report.** The owner rejected trusting agents to report their own cost. The existing NIP-AM `kind:44200` self-report stays untouched but is demoted to a cross-check signal.
2. **Accuracy comes from provider-itemized counts.** Every response from Anthropic/OpenAI itemizes uncached input, cache read, cache write (5m/1h), and output. We record their numbers, never estimates. Reasoning tokens are billed inside output; images inside input; output has no cache tier.
3. **Record per request, not per session.** One usage record per provider API call, published immediately (crash-safe). Roll-ups happen in the engine.
4. **Re-billing context every turn is real cost, correctly recorded.** Double counting means recording one request twice; the guard is dedupe on the provider request id plus reconciliation.
5. **Subscription usage is recorded at API-equivalent prices.** Every record is tagged `metered` (real money) or `imputed` (subscription seat, shadow cost). Unit economics uses both; cash view uses metered only.
6. **Prices are data on the relay, never an app update.** Effective-dated append-only entries; promo stacking (e.g. 80% cut then 50% promo on top, promo later removed) is three entries. Unknown model = recorded but unpriced + Needs Review, never zero or wrong.
7. **Reconciliation catches everything else.** Ledger daily sums are compared against the provider's own cost report; drift is an exception, flagged, then repriced from stored raw tokens.
8. **Only Colony-launched agents are counted, and agents never hold a real provider key.** The owner rejected key discipline as a guardrail ("agents will find a key; the user might use the same key"). So key custody is structural: the real provider key is entered once into Colony config and lives only with the meter. Each spawned agent receives a per-agent VIRTUAL key (an opaque token the meter issued) plus the meter's address; the meter authenticates the virtual key, swaps in the real key when forwarding, and rejects anything else. An agent that goes hunting finds only virtual keys, which route through the meter anyway (found = still counted); a direct call to the provider fails because the agent possesses nothing real. The owner's personal tools never touch the meter and never appear in the ledger. Per-virtual-key identity also gives wire-level per-agent attribution without trusting the agent. Residual risk, detection not prevention: an agent could find the owner's PERSONAL key on disk; that spend hits the personal key, not Colony's, and sustained provider-above-ledger reconciliation drift is diagnosed in the exception message as "key used outside Colony".

## Global Constraints

- **Money is integer nanodollars (nanoUSD).** Rates are `u64` nanoUSD per token ($3.00/MTok = 3000 nanoUSD/token; granularity floor $0.001/MTok). Totals are `u128` nanoUSD. Never `f64` for money in the ledger.
- **Raw usage records are immutable.** Corrections reference them and override classification; they never modify or replace the original event.
- **Every new event kind must be classified in every routing site** (`is_command_kind`, `is_relay_only_kind`, `RESULT_GATED_KINDS` and sibling lists in `kind.rs`; `required_scope_for_kind`, `takes_generic_command_branch`, `is_global_only_kind` in `ingest.rs`). Phase 2 shipped kinds without this and every event bounced with "restricted: unknown event kind". Write the classification assertion tests FIRST and watch them fail.
- **Refusal tests must assert the refusal message text**, not just the outcome (any-refusal satisfies an outcome-only test).
- **Mutation-check every new guard:** apply the mutation with `assert s.count(old) == 1` discipline, watch the intended test fail, restore.
- No `unsafe`; no new `unwrap()`/`expect()` in production paths (`?` + error types). Test code may use `expect`.
- New public API gets doc comments.
- Commit with `git commit -s` (DCO). PRs target `develop`. Branch: `colony/cost-ledger`.
- Run `just ci` before the PR. Desktop crate is excluded from the root workspace: `cargo test --manifest-path desktop/src-tauri/Cargo.toml` explicitly.
- Desktop text sizes: stock rem tokens only (`text-sm`, `text-xs`, `text-2xs`), never px or arbitrary literals.
- No em-dashes in any user-facing string, doc, or chat copy. Use a regular dash, comma, or colon.
- Relay queries must always specify `kinds` (p-gate returns 403 otherwise).

## New event kinds (reserve these exact integers)

| Constant | Kind | Type | Signer | Content |
|---|---|---|---|---|
| `KIND_USAGE_RECORD` | 44210 | regular, immutable | agent or owner | NIP-44 ciphertext to owner |
| `KIND_LEDGER_ACTION` | 40017 | command (brokered) | owner only | plaintext JSON action |
| `KIND_LEDGER_RECEIPT` | 40018 | relay-only | relay | plaintext JSON receipt |
| `KIND_PRICE_BOOK` | 30184 | NIP-33 head, relay-only | relay | plaintext JSON, `d=pricebook` |
| `KIND_ATTRIBUTION_RULEBOOK` | 30185 | NIP-33 head, relay-only | relay | plaintext JSON, `d=rulebook` |
| `KIND_CORRECTION_BOOK` | 30186 | NIP-33 head, relay-only | relay | plaintext JSON, `d=corrections` |
| `KIND_LEDGER_BUDGET` | 30187 | NIP-33 head, relay-only | relay | plaintext JSON, `d={cost_centre_id}:{period}` |

Privacy note (accepted for v1, matches the owner's "plaintext for now" posture): the four books are relay-authored and therefore plaintext to the self-hosted relay. Usage records (the volume data) are encrypted to the owner.

---

### Task 1: Core usage-record payload (`buzz-core`)

**Files:**
- Create: `crates/buzz-core/src/usage_record.rs`
- Modify: `crates/buzz-core/src/lib.rs` (add `pub mod usage_record;`)

**Interfaces:**
- Produces: `UsageBreakdown`, `PaymentMode`, `UsageSource`, `UsageRecordPayload`, `encrypt_usage_record(agent_keys: &Keys, owner_pubkey: &PublicKey, payload: &UsageRecordPayload) -> Result<String, ObserverPayloadError>`, `decrypt_usage_record(recipient_keys: &Keys, event: &Event) -> Result<UsageRecordPayload, ObserverPayloadError>`. Later tasks (engine, meter, ACP, CLI, E2E) all consume these exact names.
- Consumes: `crate::observer::{encrypt_observer_payload, decrypt_observer_payload, ObserverPayloadError}`, `crate::company::AgentWorkContext` (existing).

- [ ] **Step 1: Write the failing tests** (bottom of the new `usage_record.rs`, module skeleton with types stubbed enough to compile is NOT allowed; write the whole test module first referencing the not-yet-written types, expect a compile failure):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn sample_payload() -> UsageRecordPayload {
        UsageRecordPayload {
            source: UsageSource::Wire,
            provider: "anthropic".to_string(),
            request_id: "req_011CSHoEeqs5DKb1PKBoC1fH".to_string(),
            model: Some("claude-sonnet-4-5".to_string()),
            timestamp: "2026-08-02T10:00:00.000Z".to_string(),
            payment_mode: PaymentMode::Metered,
            tokens: Some(UsageBreakdown {
                input_uncached_tokens: 1200,
                cache_read_tokens: 38000,
                cache_write_5m_tokens: 0,
                cache_write_1h_tokens: 2100,
                output_tokens: 750,
            }),
            amount_nanousd: None,
            harness: Some("buzz-acp".to_string()),
            session_id: Some("sess-1".to_string()),
            turn_id: Some("turn-3".to_string()),
            http_status: Some(200),
            description: None,
            agent_pubkey: None,
            channel_id: None,
            work_context: None,
        }
    }

    #[test]
    fn round_trip_encrypt_decrypt() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let payload = sample_payload();
        let ciphertext =
            encrypt_usage_record(&agent, &owner.public_key(), &payload).expect("encrypt");
        let event = EventBuilder::new(Kind::Custom(44210), ciphertext)
            .tags([
                Tag::parse(["p", &owner.public_key().to_hex()]).expect("p"),
                Tag::parse(["agent", &agent.public_key().to_hex()]).expect("agent"),
            ])
            .sign_with_keys(&agent)
            .expect("sign");
        let decoded = decrypt_usage_record(&owner, &event).expect("decrypt");
        assert_eq!(decoded, payload);
    }

    #[test]
    fn wrong_key_decrypt_fails() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let wrong = Keys::generate();
        let ciphertext =
            encrypt_usage_record(&agent, &owner.public_key(), &sample_payload()).expect("encrypt");
        let event = EventBuilder::new(Kind::Custom(44210), ciphertext)
            .tags([Tag::parse(["p", &owner.public_key().to_hex()]).expect("p")])
            .sign_with_keys(&agent)
            .expect("sign");
        assert!(decrypt_usage_record(&wrong, &event).is_err());
    }

    #[test]
    fn validate_requires_tokens_xor_amount() {
        let mut both = sample_payload();
        both.amount_nanousd = Some(1_000_000);
        assert!(both.validate().is_err(), "tokens AND amount must be rejected");

        let mut neither = sample_payload();
        neither.tokens = None;
        assert!(neither.validate().is_err(), "tokens NOR amount must be rejected");

        let mut amount_only = sample_payload();
        amount_only.tokens = None;
        amount_only.amount_nanousd = Some(5_000_000_000); // $5.00 manual cost
        amount_only.source = UsageSource::Manual;
        amount_only.description = Some("figma seat august".to_string());
        assert!(amount_only.validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_provider_or_request_id() {
        let mut p = sample_payload();
        p.provider = "  ".to_string();
        assert!(p.validate().is_err());
        let mut r = sample_payload();
        r.request_id = String::new();
        assert!(r.validate().is_err());
    }

    #[test]
    fn encrypt_validates_first() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let mut bad = sample_payload();
        bad.tokens = None; // neither tokens nor amount
        assert!(encrypt_usage_record(&agent, &owner.public_key(), &bad).is_err());
    }

    #[test]
    fn unknown_top_level_fields_are_ignored_forward_compat() {
        let json = r#"{
            "source": "wire", "provider": "anthropic", "requestId": "req_x",
            "model": null, "timestamp": "2026-08-02T10:00:00Z",
            "paymentMode": "metered",
            "tokens": {"inputUncachedTokens":1,"cacheReadTokens":0,"cacheWrite5mTokens":0,"cacheWrite1hTokens":0,"outputTokens":2},
            "amountNanousd": null, "futureField": true
        }"#;
        let payload: UsageRecordPayload = serde_json::from_str(json).expect("must parse");
        assert_eq!(payload.request_id, "req_x");
    }
}
```

- [ ] **Step 2: Run tests, verify compile failure**

Run: `cargo test -p buzz-core usage_record 2>&1 | head -20`
Expected: FAIL, unresolved types (`UsageRecordPayload` etc. not defined).

- [ ] **Step 3: Implement the types and helpers** (above the test module):

```rust
//! Colony cost ledger: immutable usage record (kind 44210) payload.
//!
//! One record per provider API call, captured at the wire by `buzz-meter`
//! (source `wire`) or entered by the owner (source `manual`). Content is a
//! NIP-44 v2 ciphertext (publisher key -> owner pubkey). See docs/nips/NIP-CL.md.

use nostr::{Event, Keys, PublicKey};
use serde::{Deserialize, Serialize};

use crate::company::AgentWorkContext;
use crate::observer::{decrypt_observer_payload, encrypt_observer_payload, ObserverPayloadError};

/// Provider-itemized token counts for one API call. All counts come from the
/// provider's own response; zero means the provider reported zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    /// Input tokens billed at full price (no cache involvement).
    pub input_uncached_tokens: u64,
    /// Input tokens read from prompt cache (discounted).
    pub cache_read_tokens: u64,
    /// Input tokens written to the 5-minute prompt cache.
    pub cache_write_5m_tokens: u64,
    /// Input tokens written to the 1-hour prompt cache.
    pub cache_write_1h_tokens: u64,
    /// Output tokens. Reasoning/thinking tokens are billed inside this number.
    pub output_tokens: u64,
}

/// How this usage was paid for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMode {
    /// Metered API billing: real money left per token.
    Metered,
    /// Subscription seat: no per-token bill; cost is API-equivalent shadow cost.
    Imputed,
}

/// Where the record came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    /// Captured off the provider wire by the metering checkpoint.
    Wire,
    /// Entered by the owner (subscriptions, infrastructure, non-token costs).
    Manual,
}

/// Decrypted payload of a `kind:44210` usage record event.
///
/// Exactly one of `tokens` (token usage, priced by the price book) or
/// `amount_nanousd` (a direct money amount, e.g. an infra invoice line) must
/// be present. Consumers MUST ignore unknown top-level fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordPayload {
    pub source: UsageSource,
    /// Provider slug: "anthropic", "openai", or a manual-cost vendor slug.
    pub provider: String,
    /// Provider request id for wire records (dedupe key). For manual records
    /// the owner supplies a unique reference (e.g. invoice number).
    pub request_id: String,
    pub model: Option<String>,
    /// RFC 3339 end-of-call timestamp. Engine buckets days on this (UTC).
    pub timestamp: String,
    pub payment_mode: PaymentMode,
    pub tokens: Option<UsageBreakdown>,
    /// Direct cost in nanoUSD for non-token records.
    pub amount_nanousd: Option<u64>,
    pub harness: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub http_status: Option<u16>,
    pub description: Option<String>,
    /// Hex pubkey of the agent whose call this was (rule matching input).
    #[serde(default)]
    pub agent_pubkey: Option<String>,
    /// Channel UUID the turn served, when known (rule matching input).
    #[serde(default)]
    pub channel_id: Option<String>,
    /// Attribution snapshot at capture time; absent means the attribution
    /// rule engine decides (or Needs Review).
    #[serde(default)]
    pub work_context: Option<AgentWorkContext>,
}

impl UsageRecordPayload {
    /// Structural validity: tokens XOR amount, non-blank provider/request_id.
    pub fn validate(&self) -> Result<(), ObserverPayloadError> {
        if self.provider.trim().is_empty() {
            return Err(ObserverPayloadError::InvalidPayload(
                "provider must be non-empty".to_string(),
            ));
        }
        if self.request_id.trim().is_empty() {
            return Err(ObserverPayloadError::InvalidPayload(
                "requestId must be non-empty".to_string(),
            ));
        }
        match (self.tokens.as_ref(), self.amount_nanousd) {
            (Some(_), None) | (None, Some(_)) => {}
            (Some(_), Some(_)) => {
                return Err(ObserverPayloadError::InvalidPayload(
                    "exactly one of tokens or amountNanousd must be set (got both)".to_string(),
                ))
            }
            (None, None) => {
                return Err(ObserverPayloadError::InvalidPayload(
                    "exactly one of tokens or amountNanousd must be set (got neither)".to_string(),
                ))
            }
        }
        if let Some(work_context) = &self.work_context {
            work_context
                .validate()
                .map_err(|error| ObserverPayloadError::InvalidPayload(error.to_string()))?;
        }
        Ok(())
    }
}

/// Encrypt a usage record payload (validates first). Content of `kind:44210`.
pub fn encrypt_usage_record(
    publisher_keys: &Keys,
    owner_pubkey: &PublicKey,
    payload: &UsageRecordPayload,
) -> Result<String, ObserverPayloadError> {
    payload.validate()?;
    encrypt_observer_payload(publisher_keys, owner_pubkey, payload)
}

/// Decrypt and validate a usage record from a `kind:44210` event.
pub fn decrypt_usage_record(
    recipient_keys: &Keys,
    event: &Event,
) -> Result<UsageRecordPayload, ObserverPayloadError> {
    let payload: UsageRecordPayload = decrypt_observer_payload(recipient_keys, event)?;
    payload.validate()?;
    Ok(payload)
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test -p buzz-core usage_record`
Expected: all PASS. Also run `cargo clippy -p buzz-core -- -D warnings`.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/usage_record.rs crates/buzz-core/src/lib.rs
git commit -s -m "feat(core): add kind 44210 usage record payload"
```

---

### Task 2: Kind registration and full routing classification

**Files:**
- Modify: `crates/buzz-core/src/kind.rs`
- Modify: `crates/buzz-relay/src/handlers/ingest.rs`

**Interfaces:**
- Produces: the seven constants from the kind table above, exactly as named. All later tasks reference them.
- Consumes: existing classification fns/lists. `KIND_AGENT_TURN_METRIC` (44200) is the membership template for 44210; `KIND_PARTY_ACTION`/`KIND_PARTY_RECEIPT`/`KIND_PARTY` (40015/40016/30182) are the templates for the action/receipt/head kinds.

The Phase 2 failure mode this task exists to prevent: kinds were defined but unclassified, and every event of those kinds was refused "restricted: unknown event kind" while two E2E tests passed anyway because any refusal satisfied them. Tests first.

- [ ] **Step 1: Write the failing classification tests.** In `kind.rs`, extend the existing test `party_authority_kinds_have_exact_classifications` (or add a sibling `ledger_kinds_have_exact_classifications` next to it) asserting for each new kind exactly what is true:

```rust
#[test]
fn ledger_kinds_have_exact_classifications() {
    // Command kind: only the action.
    assert!(is_command_kind(KIND_LEDGER_ACTION));
    assert!(!is_command_kind(KIND_LEDGER_RECEIPT));
    assert!(!is_command_kind(KIND_USAGE_RECORD));

    // Relay-only: receipt and the four relay-authored heads.
    for k in [
        KIND_LEDGER_RECEIPT,
        KIND_PRICE_BOOK,
        KIND_ATTRIBUTION_RULEBOOK,
        KIND_CORRECTION_BOOK,
        KIND_LEDGER_BUDGET,
    ] {
        assert!(is_relay_only_kind(k), "kind {k} must be relay-only");
    }
    assert!(!is_relay_only_kind(KIND_LEDGER_ACTION));
    assert!(!is_relay_only_kind(KIND_USAGE_RECORD));

    // Usage records are result-gated exactly like turn metrics (owner-addressed
    // encrypted content must not fan out to other members).
    assert!(RESULT_GATED_KINDS.contains(&KIND_USAGE_RECORD));
}
```

Additionally: `grep -n "KIND_AGENT_TURN_METRIC" crates/buzz-core/src/kind.rs` and for EVERY list it appears in (there are more than `RESULT_GATED_KINDS`, e.g. p-gating lists around lines 129/155/717), add an assertion that `KIND_USAGE_RECORD` is in the same list. Do the same for `KIND_PARTY_ACTION` (line ~646 list) mirrored by `KIND_LEDGER_ACTION`, and `KIND_PARTY`/`KIND_PARTY_RELATIONSHIP` memberships mirrored by the four head kinds. The greps are the specification; the turn-metric and party kinds went through live-gate hardening and their membership set is exactly right for their shape.

- [ ] **Step 2: Run, watch them fail to compile** (constants missing): `cargo test -p buzz-core ledger_kinds`

- [ ] **Step 3: Add constants + memberships in `kind.rs`:**

```rust
/// Colony ledger: immutable usage record captured at the model-provider wire
/// (or entered manually by the owner). NIP-44 encrypted to the owner.
pub const KIND_USAGE_RECORD: u32 = 44210;
/// Colony ledger: owner-signed command (price entry, rule, correction, budget).
pub const KIND_LEDGER_ACTION: u32 = 40017;
/// Colony ledger: relay-signed receipt for a ledger action.
pub const KIND_LEDGER_RECEIPT: u32 = 40018;
/// Colony ledger: relay-authored NIP-33 head, d="pricebook".
pub const KIND_PRICE_BOOK: u32 = 30184;
/// Colony ledger: relay-authored NIP-33 head, d="rulebook".
pub const KIND_ATTRIBUTION_RULEBOOK: u32 = 30185;
/// Colony ledger: relay-authored NIP-33 head, d="corrections".
pub const KIND_CORRECTION_BOOK: u32 = 30186;
/// Colony ledger: relay-authored NIP-33 head, d="{cost_centre_id}:{period}".
pub const KIND_LEDGER_BUDGET: u32 = 30187;
```

Then add each to the lists/matches the Step 1 assertions demand (`is_command_kind`, `is_relay_only_kind`, `RESULT_GATED_KINDS`, and the mirrored membership lists found by grep).

- [ ] **Step 4: Write the failing ingest tests.** In `ingest.rs` tests, next to `party_kinds_have_pinned_scope_and_channel_classification`, add:

```rust
#[test]
fn ledger_kinds_have_pinned_scope_and_channel_classification() {
    let dummy = dummy_event(); // reuse the existing helper in this test module
    assert_eq!(
        required_scope_for_kind(KIND_LEDGER_ACTION, &dummy).unwrap(),
        Scope::UsersWrite
    );
    assert_eq!(
        required_scope_for_kind(KIND_USAGE_RECORD, &dummy).unwrap(),
        Scope::MessagesWrite
    );
    assert!(!takes_generic_command_branch(KIND_LEDGER_ACTION));
    assert!(is_global_only_kind(KIND_LEDGER_ACTION));
    assert!(is_global_only_kind(KIND_USAGE_RECORD));
    assert!(!requires_h_channel_scope(KIND_LEDGER_ACTION));
    assert!(!requires_h_channel_scope(KIND_USAGE_RECORD));
}
```

Also extend `brokered_actions_are_excluded_from_the_generic_command_branch` (`ingest.rs:3196` area, `let brokered = [KIND_COMPANY_ACTION, KIND_PARTY_ACTION];`) to include `KIND_LEDGER_ACTION`.

- [ ] **Step 5: Run, watch fail**: `cargo test -p buzz-relay ledger_kinds` (compile failure on missing match arms is the expected first failure).

- [ ] **Step 6: Implement ingest classification.** In `required_scope_for_kind` (~line 213): add `KIND_LEDGER_ACTION` to the arm containing `KIND_PARTY_ACTION` (~line 229, `Scope::UsersWrite`); add `KIND_USAGE_RECORD` beside `KIND_AGENT_TURN_METRIC => Ok(Scope::MessagesWrite)` (~line 234). In `takes_generic_command_branch` (~line 402): add `&& kind != KIND_LEDGER_ACTION`. In `is_global_only_kind` (~line 419): add `KIND_LEDGER_ACTION` beside `KIND_PARTY_ACTION` (~line 458) and `KIND_USAGE_RECORD` beside `KIND_AGENT_TURN_METRIC` (~line 494). Check the special-case at `ingest.rs:2187` (`if kind_u32 == KIND_AGENT_TURN_METRIC`): read what it does; if it enforces the owner `p`-tag/result-gating for 44200, extend it to 44210 identically.

- [ ] **Step 7: Run full crate tests**: `cargo test -p buzz-core && cargo test -p buzz-relay --lib` Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/buzz-core/src/kind.rs crates/buzz-relay/src/handlers/ingest.rs
git commit -s -m "feat(core,relay): register and classify cost-ledger event kinds"
```

---

### Task 3: Price book (`buzz-core::ledger::prices`)

**Files:**
- Create: `crates/buzz-core/src/ledger/mod.rs` (starts as `pub mod prices;` plus re-exports)
- Create: `crates/buzz-core/src/ledger/prices.rs`
- Modify: `crates/buzz-core/src/lib.rs` (add `pub mod ledger;`)

**Interfaces:**
- Produces: `PriceRates`, `PriceEntry`, `PriceBook`, `PriceBook::rates_for(&self, model: &str, at_unix: u64) -> Option<&PriceRates>`, `PriceBook::price_tokens(&self, model: &str, tokens: &UsageBreakdown, at_unix: u64) -> Option<u128>`, `PriceBook::extends(old: &PriceBook, new: &PriceBook) -> bool`, `LedgerContractError` (this error enum lives in `ledger/mod.rs` and grows in Tasks 4 and 7).
- Consumes: `crate::usage_record::UsageBreakdown` (Task 1).

- [ ] **Step 1: Write the failing tests** in `prices.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_record::UsageBreakdown;

    fn rates(input: u64, read: u64, w5: u64, w1h: u64, output: u64) -> PriceRates {
        PriceRates {
            input_nanousd_per_token: input,
            cache_read_nanousd_per_token: read,
            cache_write_5m_nanousd_per_token: w5,
            cache_write_1h_nanousd_per_token: w1h,
            output_nanousd_per_token: output,
        }
    }

    fn entry(model: &str, effective_from: u64, r: PriceRates) -> PriceEntry {
        PriceEntry {
            model: model.to_string(),
            effective_from,
            rates: r,
            note: None,
        }
    }

    // The owner's promo scenario: base price, then 80% cut, then a 50% promo
    // on top of that, then the promo is removed (back to the 80%-cut price).
    // Three appended entries after the base; selection is by timestamp.
    #[test]
    fn effective_dating_selects_price_at_call_time() {
        let book = PriceBook {
            entries: vec![
                entry("gpt-5.6", 1_000, rates(5000, 500, 0, 0, 15000)),
                entry("gpt-5.6", 2_000, rates(1000, 100, 0, 0, 3000)), // 80% cut
                entry("gpt-5.6", 3_000, rates(500, 50, 0, 0, 1500)),   // 50% promo on top
                entry("gpt-5.6", 4_000, rates(1000, 100, 0, 0, 3000)), // promo removed
            ],
        };
        assert_eq!(book.rates_for("gpt-5.6", 1_500).unwrap().input_nanousd_per_token, 5000);
        assert_eq!(book.rates_for("gpt-5.6", 2_000).unwrap().input_nanousd_per_token, 1000); // boundary: effective AT the timestamp
        assert_eq!(book.rates_for("gpt-5.6", 3_500).unwrap().input_nanousd_per_token, 500);
        assert_eq!(book.rates_for("gpt-5.6", 9_999).unwrap().input_nanousd_per_token, 1000);
        assert!(book.rates_for("gpt-5.6", 999).is_none(), "before first entry: unpriced");
        assert!(book.rates_for("unknown-model", 5_000).is_none());
    }

    #[test]
    fn same_timestamp_latest_appended_entry_wins() {
        let book = PriceBook {
            entries: vec![
                entry("m", 1_000, rates(100, 0, 0, 0, 0)),
                entry("m", 1_000, rates(200, 0, 0, 0, 0)),
            ],
        };
        assert_eq!(book.rates_for("m", 1_000).unwrap().input_nanousd_per_token, 200);
    }

    #[test]
    fn price_tokens_multiplies_every_category_exactly() {
        // Sonnet-style: $3/MTok in = 3000, cache read $0.30 = 300,
        // 5m write $3.75 = 3750, 1h write $6 = 6000, out $15 = 15000.
        let book = PriceBook {
            entries: vec![entry("claude-sonnet-4-5", 0, rates(3000, 300, 3750, 6000, 15000))],
        };
        let tokens = UsageBreakdown {
            input_uncached_tokens: 1_000,
            cache_read_tokens: 40_000,
            cache_write_5m_tokens: 2_000,
            cache_write_1h_tokens: 500,
            output_tokens: 3_000,
        };
        // 1000*3000 + 40000*300 + 2000*3750 + 500*6000 + 3000*15000
        // = 3_000_000 + 12_000_000 + 7_500_000 + 3_000_000 + 45_000_000
        let expected: u128 = 70_500_000; // $0.0705
        assert_eq!(book.price_tokens("claude-sonnet-4-5", &tokens, 10).unwrap(), expected);
        assert!(book.price_tokens("nope", &tokens, 10).is_none());
    }

    #[test]
    fn extends_accepts_appends_and_rejects_mutation() {
        let old = PriceBook { entries: vec![entry("m", 1, rates(1, 0, 0, 0, 0))] };
        let mut appended = old.clone();
        appended.entries.push(entry("m", 2, rates(2, 0, 0, 0, 0)));
        assert!(PriceBook::extends(&old, &appended));
        assert!(PriceBook::extends(&old, &old), "identical book is a valid (no-op) extension");

        let mutated = PriceBook { entries: vec![entry("m", 1, rates(9, 0, 0, 0, 0))] };
        assert!(!PriceBook::extends(&old, &mutated), "rewriting history must be rejected");
        let truncated = PriceBook { entries: vec![] };
        assert!(!PriceBook::extends(&old, &truncated), "dropping entries must be rejected");
    }
}
```

- [ ] **Step 2: Run, verify compile failure**: `cargo test -p buzz-core ledger::prices`

- [ ] **Step 3: Implement:**

```rust
//! Effective-dated model price book. Money is integer nanoUSD per token.
//! $3.00 per million tokens = 3000 nanoUSD per token.

use serde::{Deserialize, Serialize};

use crate::usage_record::UsageBreakdown;

/// Per-token rates in nanoUSD for one model, one effective period.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRates {
    pub input_nanousd_per_token: u64,
    pub cache_read_nanousd_per_token: u64,
    pub cache_write_5m_nanousd_per_token: u64,
    pub cache_write_1h_nanousd_per_token: u64,
    pub output_nanousd_per_token: u64,
}

/// One append-only price row. History is never rewritten: price changes and
/// promos are new entries with a later `effective_from`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceEntry {
    pub model: String,
    /// Unix seconds (UTC) this entry takes effect, inclusive.
    pub effective_from: u64,
    pub rates: PriceRates,
    pub note: Option<String>,
}

/// The full append-only price table (content of the `d=pricebook` head).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceBook {
    pub entries: Vec<PriceEntry>,
}

impl PriceBook {
    /// Rates in effect for `model` at `at_unix`: the entry with the greatest
    /// `effective_from <= at_unix`; among equals, the latest appended wins.
    pub fn rates_for(&self, model: &str, at_unix: u64) -> Option<&PriceRates> {
        self.entries
            .iter()
            .filter(|e| e.model == model && e.effective_from <= at_unix)
            .max_by(|a, b| a.effective_from.cmp(&b.effective_from))
            // max_by returns the LAST maximal element, which is exactly
            // "latest appended wins" for equal timestamps.
            .map(|e| &e.rates)
    }

    /// Exact cost of a token breakdown, or `None` when the model is unpriced
    /// at that time (caller flags Needs Review; never zero, never a guess).
    pub fn price_tokens(&self, model: &str, tokens: &UsageBreakdown, at_unix: u64) -> Option<u128> {
        let r = self.rates_for(model, at_unix)?;
        Some(
            u128::from(tokens.input_uncached_tokens) * u128::from(r.input_nanousd_per_token)
                + u128::from(tokens.cache_read_tokens) * u128::from(r.cache_read_nanousd_per_token)
                + u128::from(tokens.cache_write_5m_tokens)
                    * u128::from(r.cache_write_5m_nanousd_per_token)
                + u128::from(tokens.cache_write_1h_tokens)
                    * u128::from(r.cache_write_1h_nanousd_per_token)
                + u128::from(tokens.output_tokens) * u128::from(r.output_nanousd_per_token),
        )
    }

    /// Append-only check: `new` must start with exactly `old`'s entries.
    pub fn extends(old: &PriceBook, new: &PriceBook) -> bool {
        new.entries.len() >= old.entries.len() && new.entries[..old.entries.len()] == old.entries[..]
    }
}
```

Verify the `max_by` tie-break claim against the std docs ("returns the last element" for equal maxima); if wrong, use an explicit index-carrying fold. Prove it with the `same_timestamp_latest_appended_entry_wins` test by mutating `max_by` to `min_by` (`assert count==1` discipline) and watching the effective-dating test fail, then restore.

- [ ] **Step 4: Run tests + clippy**: `cargo test -p buzz-core ledger && cargo clippy -p buzz-core -- -D warnings`

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/ledger crates/buzz-core/src/lib.rs
git commit -s -m "feat(core): add effective-dated ledger price book"
```

---

### Task 4: Rules, corrections, budgets (`buzz-core::ledger`)

**Files:**
- Create: `crates/buzz-core/src/ledger/attribution.rs`
- Modify: `crates/buzz-core/src/ledger/mod.rs`

**Interfaces:**
- Produces: `AttributionRule`, `RuleAssignment`, `Rulebook` (+ `extends`), `Correction`, `CorrectionBook` (+ `extends`), `Budget`, `Rulebook::best_match(&self, record: &UsageRecordPayload) -> Option<&AttributionRule>`.
- Consumes: `UsageRecordPayload` (Task 1), `CommercialPurpose`/`classify_cost` from `crate::company`.

- [ ] **Step 1: Write the failing tests:**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::company::CommercialPurpose;
    use crate::usage_record::{PaymentMode, UsageBreakdown, UsageRecordPayload, UsageSource};

    fn record(model: &str, harness: Option<&str>) -> UsageRecordPayload {
        UsageRecordPayload {
            source: UsageSource::Wire,
            provider: "anthropic".to_string(),
            request_id: "req_1".to_string(),
            model: Some(model.to_string()),
            timestamp: "2026-08-02T10:00:00Z".to_string(),
            payment_mode: PaymentMode::Metered,
            tokens: Some(UsageBreakdown {
                input_uncached_tokens: 1, cache_read_tokens: 0,
                cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 1,
            }),
            amount_nanousd: None,
            harness: harness.map(str::to_string),
            session_id: None, turn_id: None, http_status: Some(200),
            description: None, agent_pubkey: None, channel_id: None,
            work_context: None,
        }
    }

    fn assignment(centre: &str, purpose: CommercialPurpose) -> RuleAssignment {
        RuleAssignment {
            company_id: "horizon-labs".to_string(),
            cost_centre_id: centre.to_string(),
            owning_team_id: "web-team".to_string(),
            commercial_purpose: purpose,
            client_organization_id: None,
            task_id: None,
        }
    }

    #[test]
    fn best_match_requires_all_set_matchers_and_prefers_priority() {
        let rules = Rulebook {
            rules: vec![
                AttributionRule {
                    id: "any-anthropic".to_string(), priority: 1,
                    match_provider: Some("anthropic".to_string()),
                    match_harness: None, match_agent_pubkey: None,
                    match_channel_id: None, match_model: None,
                    assign: assignment("internal-ops", CommercialPurpose::Administration),
                },
                AttributionRule {
                    id: "goose-sonnet".to_string(), priority: 10,
                    match_provider: Some("anthropic".to_string()),
                    match_harness: Some("goose".to_string()),
                    match_agent_pubkey: None, match_channel_id: None,
                    match_model: Some("claude-sonnet-4-5".to_string()),
                    assign: assignment("web-delivery", CommercialPurpose::Sales),
                },
            ],
        };
        let hit = rules.best_match(&record("claude-sonnet-4-5", Some("goose"))).unwrap();
        assert_eq!(hit.id, "goose-sonnet", "higher priority wins when both match");

        let fallback = rules.best_match(&record("claude-haiku-4-5", Some("goose"))).unwrap();
        assert_eq!(fallback.id, "any-anthropic", "model mismatch drops the specific rule");

        let mut other_provider = record("gpt-5.6", None);
        other_provider.provider = "openai".to_string();
        assert!(rules.best_match(&other_provider).is_none());
    }

    #[test]
    fn equal_priority_earliest_rule_wins() {
        let mk = |id: &str| AttributionRule {
            id: id.to_string(), priority: 5,
            match_provider: None, match_harness: None, match_agent_pubkey: None,
            match_channel_id: None, match_model: None,
            assign: assignment("internal-ops", CommercialPurpose::Administration),
        };
        let rules = Rulebook { rules: vec![mk("first"), mk("second")] };
        assert_eq!(rules.best_match(&record("m", None)).unwrap().id, "first");
    }

    #[test]
    fn books_are_append_only() {
        let old = Rulebook { rules: vec![] };
        let one = Rulebook { rules: vec![AttributionRule {
            id: "r".to_string(), priority: 1,
            match_provider: None, match_harness: None, match_agent_pubkey: None,
            match_channel_id: None, match_model: None,
            assign: assignment("x", CommercialPurpose::Administration),
        }]};
        assert!(Rulebook::extends(&old, &one));
        assert!(!Rulebook::extends(&one, &old));

        let empty = CorrectionBook { corrections: vec![] };
        let with_one = CorrectionBook { corrections: vec![Correction {
            id: "c1".to_string(),
            usage_record_event_id: "e".repeat(64),
            assign: assignment("web-delivery", CommercialPurpose::ClientDelivery),
            reason: "was client work for tennant".to_string(),
            corrected_at: 1_700_000_000,
        }]};
        assert!(CorrectionBook::extends(&empty, &with_one));
        assert!(!CorrectionBook::extends(&with_one, &empty));
    }
}
```

- [ ] **Step 2: Run, verify compile failure**: `cargo test -p buzz-core ledger::attribution`

- [ ] **Step 3: Implement** in `attribution.rs`:

```rust
//! Attribution rules, CFO corrections, and budgets for the cost ledger.

use serde::{Deserialize, Serialize};

use crate::company::CommercialPurpose;
use crate::usage_record::UsageRecordPayload;

/// What an attribution rule (or correction) assigns to a usage record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleAssignment {
    pub company_id: String,
    pub cost_centre_id: String,
    pub owning_team_id: String,
    pub commercial_purpose: CommercialPurpose,
    pub client_organization_id: Option<String>,
    pub task_id: Option<String>,
}

/// A rule matches when EVERY set matcher equals the record's field.
/// Higher `priority` wins; equal priority, earliest appended wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionRule {
    pub id: String,
    pub priority: u32,
    pub match_provider: Option<String>,
    pub match_harness: Option<String>,
    pub match_agent_pubkey: Option<String>,
    pub match_channel_id: Option<String>,
    pub match_model: Option<String>,
    pub assign: RuleAssignment,
}

impl AttributionRule {
    fn matches(&self, record: &UsageRecordPayload) -> bool {
        fn ok(matcher: &Option<String>, value: Option<&str>) -> bool {
            match matcher {
                None => true,
                Some(m) => value == Some(m.as_str()),
            }
        }
        ok(&self.match_provider, Some(record.provider.as_str()))
            && ok(&self.match_harness, record.harness.as_deref())
            && ok(&self.match_model, record.model.as_deref())
            && ok(&self.match_agent_pubkey, record.agent_pubkey.as_deref())
            && ok(&self.match_channel_id, record.channel_id.as_deref())
    }
}
```

Add one test beyond Step 1's set: a rule with `match_channel_id` set matches only a record whose `channel_id` equals it (proves the two Task 1 fields participate in matching).

```rust
/// Ordered rule set (content of the `d=rulebook` head). Append-only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rulebook {
    pub rules: Vec<AttributionRule>,
}

impl Rulebook {
    /// Highest-priority matching rule; ties resolve to the earliest appended.
    /// Implemented as an explicit loop on purpose: iterator max_by tie-break
    /// direction is easy to get backwards here.
    pub fn best_match(&self, record: &UsageRecordPayload) -> Option<&AttributionRule> {
        let mut best: Option<&AttributionRule> = None;
        for rule in self.rules.iter().filter(|r| r.matches(record)) {
            match best {
                None => best = Some(rule),
                Some(b) if rule.priority > b.priority => best = Some(rule),
                Some(_) => {} // equal or lower: earliest appended stays
            }
        }
        best
    }

    /// Append-only check, same contract as `PriceBook::extends`.
    pub fn extends(old: &Rulebook, new: &Rulebook) -> bool {
        new.rules.len() >= old.rules.len() && new.rules[..old.rules.len()] == old.rules[..]
    }
}

/// One CFO correction: re-attributes a single usage record. The raw record
/// is never modified; the engine applies corrections last and keeps both the
/// original and corrected classification in the ledger entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Correction {
    pub id: String,
    /// Hex event id of the kind 44210 record being corrected.
    pub usage_record_event_id: String,
    pub assign: RuleAssignment,
    pub reason: String,
    pub corrected_at: u64,
}

/// Append-only correction log (content of the `d=corrections` head).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionBook {
    pub corrections: Vec<Correction>,
}

impl CorrectionBook {
    pub fn extends(old: &CorrectionBook, new: &CorrectionBook) -> bool {
        new.corrections.len() >= old.corrections.len()
            && new.corrections[..old.corrections.len()] == old.corrections[..]
    }
}

/// Monthly budget for one cost centre (content of a
/// `d={cost_centre_id}:{period}` head; `period` is `YYYY-MM`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub cost_centre_id: String,
    pub period: String,
    pub amount_nanousd: u64,
}
```

- [ ] **Step 4: Run tests + clippy, verify pass**: `cargo test -p buzz-core ledger && cargo clippy -p buzz-core -- -D warnings`

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/ledger crates/buzz-core/src/usage_record.rs
git commit -s -m "feat(core): add attribution rules, corrections, budgets"
```

---

### Task 5: Deterministic ledger engine (`buzz-core::ledger::engine`)

**Files:**
- Create: `crates/buzz-core/src/ledger/engine.rs`
- Modify: `crates/buzz-core/src/ledger/mod.rs`

**Interfaces:**
- Produces:

```rust
pub struct StoredUsageRecord { pub event_id: String, pub created_at: u64, pub payload: UsageRecordPayload }
pub enum LedgerException {
    DuplicateConflict { key: String, kept_event_id: String, dropped_event_id: String },
    UnpricedModel { event_id: String, model: String },
    BadTimestamp { event_id: String },
    // Task 6 adds: ReconcileDrift { provider, day, ledger_nanousd, provider_nanousd },
    //              ReconcileMissingDay { provider, day, side }
}
pub enum AttributionMethod { Explicit, Rule(String), Correction(String), NeedsReview }
pub struct LedgerEntry {
    pub event_id: String, pub day: String /* YYYY-MM-DD UTC */,
    pub provider: String, pub model: Option<String>,
    pub payment_mode: PaymentMode,
    pub cost_nanousd: Option<u128>, // None = unpriced
    pub original_classification: CostClassification,
    pub effective_classification: CostClassification,
    pub effective_assignment: Option<RuleAssignment>,
    pub attributed_by: AttributionMethod, // Explicit | Rule(id) | Correction(id) | NeedsReview
}
pub struct LedgerReport {
    pub entries: Vec<LedgerEntry>,
    pub totals: ClassTotals, // { cogs, opex, needs_review: u128 }
    pub metered_nanousd: u128, pub imputed_nanousd: u128,
    pub by_cost_centre: Vec<(String, u128)>,
    pub by_day: Vec<DailySum>, // { provider, day, metered_nanousd }  (reconcile input)
    pub budget_status: Vec<BudgetStatus>, // { cost_centre_id, period, budget, actual }
    pub exceptions: Vec<LedgerException>,
}
pub fn compute_ledger(records: Vec<StoredUsageRecord>, prices: &PriceBook, rules: &Rulebook, corrections: &CorrectionBook, budgets: &[Budget]) -> LedgerReport
```

- Consumes: everything from Tasks 1, 3, 4 plus `classify_cost(purpose: CommercialPurpose, client_organization_id: Option<&str>) -> CostClassification` from `crate::company` (exists at `company.rs`, signature verified).

Engine rules, in order (this ordering IS the spec, encode it as a comment atop `compute_ledger`):

1. **Sort** records by `(created_at, event_id)` ascending. Determinism does not depend on caller order.
2. **Dedupe**: key = `"{provider}:{request_id}"` for `Wire` records, `event_id` for `Manual`. First occurrence wins. A later record with the same key and IDENTICAL payload is dropped silently (idempotent republish). Same key, different payload: dropped AND `DuplicateConflict` exception (goes to Needs Review totals? No: the kept entry keeps its own classification; the conflict is exception-only).
3. **Price**: token records via `PriceBook::price_tokens` at the record's timestamp (parse RFC 3339 to unix; unparseable timestamp = fall back to event `created_at` and add an exception variant `BadTimestamp { event_id }`); amount records use `amount_nanousd`. Unpriced model: `cost_nanousd = None`, `UnpricedModel` exception, and the entry's effective classification is forced to `NeedsReview` (money cannot be attributed if it cannot be counted).
4. **Attribute**: if `work_context` present, use its `commercial_purpose` + `client_organization_id` through `classify_cost`, `attributed_by = Explicit`. Else `rules.best_match`: classification from the rule's assignment through `classify_cost`, `attributed_by = Rule(id)`. Else `NeedsReview`.
5. **Correct**: corrections matched by `usage_record_event_id`; last correction for an id wins; sets `effective_classification` (through `classify_cost` on the correction's assignment) and `effective_assignment`, `attributed_by = Correction(id)`. `original_classification` NEVER changes.
6. **Aggregate**: totals by effective classification; metered/imputed split; by cost centre (from effective assignment, unattributed money under `"needs-review"`); `by_day` metered wire records only (that is what provider invoices contain); budget actuals match entries to `(cost_centre_id, period = day[..7])`.

- [ ] **Step 1: Write the failing tests.** Cover, at minimum, each numbered rule:

```rust
// Test list (write all of these; helper builders keep them short):
// determinism_shuffled_input_produces_identical_report
// idempotent_republish_counts_once_silently
// conflicting_duplicate_keeps_first_and_flags_exception
// unpriced_model_flags_exception_and_forces_needs_review
// explicit_context_classifies_cogs_with_client_and_opex_for_internal
// rule_attribution_applies_when_no_explicit_context
// unmatched_record_lands_in_needs_review
// correction_overrides_classification_and_preserves_original
// manual_amount_record_flows_straight_to_totals
// imputed_records_split_from_metered_in_totals_and_absent_from_by_day
// budget_status_compares_actual_to_budget_for_the_period
```

Two of them in full (pattern for the rest):

```rust
#[test]
fn determinism_shuffled_input_produces_identical_report() {
    let (records, prices, rules, corrections) = fixture_set(); // 6 mixed records
    let a = compute_ledger(records.clone(), &prices, &rules, &corrections, &[]);
    let mut shuffled = records;
    shuffled.reverse();
    let b = compute_ledger(shuffled, &prices, &rules, &corrections, &[]);
    assert_eq!(a, b);
}

#[test]
fn correction_overrides_classification_and_preserves_original() {
    let (mut records, prices, _rules, _c) = fixture_set();
    records.truncate(1); // one explicit Administration (Opex) record, event_id "aa..aa"
    let corrections = CorrectionBook { corrections: vec![Correction {
        id: "c1".to_string(),
        usage_record_event_id: records[0].event_id.clone(),
        assign: RuleAssignment {
            company_id: "horizon-labs".to_string(),
            cost_centre_id: "web-delivery".to_string(),
            owning_team_id: "web-team".to_string(),
            commercial_purpose: CommercialPurpose::ClientDelivery,
            client_organization_id: Some("tennant-group".to_string()),
            task_id: None,
        },
        reason: "was billable client work".to_string(),
        corrected_at: 1_700_000_100,
    }]};
    let report = compute_ledger(records, &prices, &Rulebook::default(), &corrections, &[]);
    let entry = &report.entries[0];
    assert_eq!(entry.original_classification, CostClassification::Opex);
    assert_eq!(entry.effective_classification, CostClassification::Cogs);
    assert!(matches!(entry.attributed_by, AttributionMethod::Correction(ref id) if id == "c1"));
    assert_eq!(report.totals.opex, 0);
    assert!(report.totals.cogs > 0);
}
```

- [ ] **Step 2: Run, verify compile failure**: `cargo test -p buzz-core ledger::engine`

- [ ] **Step 3: Implement `compute_ledger`** exactly per the six numbered rules. Day bucketing: parse the RFC 3339 timestamp with `chrono` if `buzz-core` already depends on it (`grep chrono crates/buzz-core/Cargo.toml`); if it does not, add `chrono` with default features off (`features = ["std"]`) or hand-derive the UTC date from unix seconds with the standard civil-from-days algorithm in a private helper with its own unit test (either is acceptable; do not pull a new heavyweight dependency). Keep `compute_ledger` a pure function: no I/O, no clock reads (timestamps come from inputs only), no randomness.

- [ ] **Step 4: Run all engine tests, verify pass**: `cargo test -p buzz-core ledger`

- [ ] **Step 5: Mutation-check the dedupe guard**: change the dedupe key to drop `provider` (`assert count==1` first), confirm `idempotent_republish_counts_once_silently` still passes but a cross-provider-collision test fails... there is no such test yet: ADD one (`same_request_id_different_provider_counts_twice`), watch it fail under the mutation, restore, watch it pass.

- [ ] **Step 6: Run clippy + full crate**: `cargo clippy -p buzz-core -- -D warnings && cargo test -p buzz-core`

- [ ] **Step 7: Commit**

```bash
git add crates/buzz-core/src/ledger
git commit -s -m "feat(core): add deterministic cost ledger engine"
```

---

### Task 6: Reconciliation (`buzz-core::ledger::reconcile`)

**Files:**
- Create: `crates/buzz-core/src/ledger/reconcile.rs`
- Modify: `crates/buzz-core/src/ledger/mod.rs`, `engine.rs` (add exception variants)

**Interfaces:**
- Produces: `ProviderDailyCost { provider: String, day: String, amount_nanousd: u128 }`, `reconcile(ledger_by_day: &[DailySum], provider_rows: &[ProviderDailyCost], tolerance_nanousd: u128) -> Vec<LedgerException>` with new exception variants `ReconcileDrift { provider, day, ledger_nanousd, provider_nanousd }`, `ReconcileMissingDay { provider, day, side }`.
- Consumes: `DailySum` from Task 5.

- [ ] **Step 1: Failing tests**: exact match within tolerance yields no exceptions; ledger-above-provider drifts (the double-count smell); ledger-below-provider drifts (the stale-price smell, the owner's missed-promo-end case, and the shared-API-key smell: personal usage on the company key inflates the provider side); a day present on one side only yields `ReconcileMissingDay`; tolerance boundary is inclusive (`|diff| <= tolerance` passes).

- [ ] **Step 2: Run, verify failure.**

- [ ] **Step 3: Implement** as a pure comparison keyed on `(provider, day)`:

```rust
use std::collections::BTreeMap;

/// Compare ledger metered daily sums against provider-exported daily cost.
/// Any absolute difference beyond `tolerance_nanousd` is an exception; a day
/// present on only one side is always an exception. Output order is
/// deterministic (BTreeMap iteration order on `(provider, day)`).
pub fn reconcile(
    ledger_by_day: &[DailySum],
    provider_rows: &[ProviderDailyCost],
    tolerance_nanousd: u128,
) -> Vec<LedgerException> {
    let mut ledger: BTreeMap<(String, String), u128> = BTreeMap::new();
    for sum in ledger_by_day {
        *ledger
            .entry((sum.provider.clone(), sum.day.clone()))
            .or_default() += sum.metered_nanousd;
    }
    let mut provider: BTreeMap<(String, String), u128> = BTreeMap::new();
    for row in provider_rows {
        *provider
            .entry((row.provider.clone(), row.day.clone()))
            .or_default() += row.amount_nanousd;
    }

    let mut exceptions = Vec::new();
    for (key, ledger_amount) in &ledger {
        match provider.get(key) {
            None => exceptions.push(LedgerException::ReconcileMissingDay {
                provider: key.0.clone(),
                day: key.1.clone(),
                side: MissingSide::ProviderReport,
            }),
            Some(provider_amount) => {
                let diff = ledger_amount.abs_diff(*provider_amount);
                if diff > tolerance_nanousd {
                    exceptions.push(LedgerException::ReconcileDrift {
                        provider: key.0.clone(),
                        day: key.1.clone(),
                        ledger_nanousd: *ledger_amount,
                        provider_nanousd: *provider_amount,
                    });
                }
            }
        }
    }
    for key in provider.keys() {
        if !ledger.contains_key(key) {
            exceptions.push(LedgerException::ReconcileMissingDay {
                provider: key.0.clone(),
                day: key.1.clone(),
                side: MissingSide::Ledger,
            });
        }
    }
    exceptions
}
```

(`MissingSide { Ledger, ProviderReport }` is a small enum beside the exception variants.)

- [ ] **Step 4: Run tests, clippy, verify pass.**

Display-layer note (Tasks 10 and 11 consume this): when rendering a `ReconcileDrift` where `provider_nanousd > ledger_nanousd`, append the diagnosis hint `provider reports more than the ledger: the provider key is being used outside Colony, or wire records are missing`. The engine stays numeric; the hint lives in CLI/desktop formatting.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-core/src/ledger
git commit -s -m "feat(core): add ledger-vs-provider reconciliation"
```

---

### Task 7: Relay ledger broker

**Files:**
- Create: `crates/buzz-core/src/ledger/action.rs` (`LedgerAction` enum + serde + validation)
- Create: `crates/buzz-relay/src/ledger_broker.rs`
- Modify: `crates/buzz-relay/src/lib.rs` (module), `crates/buzz-relay/src/handlers/ingest.rs` (route `KIND_LEDGER_ACTION` to the broker exactly where `KIND_PARTY_ACTION` routes to `handle_party_action`, `party_broker.rs:386`)
- Modify: `crates/buzz-db/src/lib.rs` if the party path used an apply-once helper the heads need (read `apply_party_action_once` first; ledger heads have no cross-record transaction requirements beyond single-head CAS, so `replace_parameterized_event_tx` per head is expected to suffice)

**Interfaces:**
- Produces: `LedgerAction` (serde-tagged enum): `AddPriceEntry { entry: PriceEntry }`, `AddRule { rule: AttributionRule }`, `AddCorrection { correction: Correction }`, `SetBudget { budget: Budget }`. Receipt kind 40018 with the same outcome vocabulary as party receipts (`Applied` / `Conflict`; every validation refusal is `Conflict` with a `conflict:`-prefixed message, matching the Phase 2 convention and CLI exit code 5).
- Consumes: books + `extends` checks (Tasks 3, 4), kind constants (Task 2).

**`party_broker.rs` is the template.** Read it end to end before writing a line. The deltas, exhaustively:

1. Owner gate identical: non-owner refusal message is exactly `ledger actions require the community owner`.
2. Head loading: fetch current NIP-33 head by `(kind, d)`; missing head = empty book.
3. Validation per action: `AddPriceEntry` refuses a blank model (`conflict: price entry model must be non-empty`); `AddRule` refuses a duplicate rule id (`conflict: rule id already exists`) and blank assignment ids; `AddCorrection` refuses a malformed (non-64-hex) `usage_record_event_id` (`conflict: correction must reference a usage record event id`) and duplicate correction id; `SetBudget` refuses a period not matching `^\d{4}-\d{2}$` (`conflict: budget period must be YYYY-MM`).
4. Head write: append to the loaded book, serialize, write via the same replace-parameterized path party heads use, in one transaction with the receipt. `SetBudget` is a plain LWW head replace (budgets are not append-only; the head IS the current budget; history lives in the relay event store).
5. Append-only enforcement is structural: the broker always builds `new = old + appended`, and a concurrent-writer race is handled exactly the way the party broker handles NIP-33 ordering loss (read how `apply_party_action_once` rolls back; mirror it).

- [ ] **Step 1: Write failing broker unit tests** (same test harness style as `party_broker` tests): non-owner action refused with the exact message; `AddPriceEntry` appends to an empty then non-empty book; duplicate rule id refused with exact message; receipt outcome is `Conflict` for every refusal and `Applied` with the head event id for success.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement `LedgerAction`** in core with a `validate()` unit-tested for each refusal above (core-level validation; broker calls it, then does state-dependent checks).
- [ ] **Step 4: Implement the broker + ingest routing.** Watch Step 1 tests pass.
- [ ] **Step 5: Run** `cargo test -p buzz-relay --lib && cargo clippy -p buzz-relay -- -D warnings`.
- [ ] **Step 6: Commit**

```bash
git add crates/buzz-core/src/ledger/action.rs crates/buzz-relay/src/ledger_broker.rs crates/buzz-relay/src/lib.rs crates/buzz-relay/src/handlers/ingest.rs
git commit -s -m "feat(relay): broker owner-signed ledger actions into NIP-33 books"
```

---

### Task 8: `buzz-meter` crate (the wire checkpoint)

**Files:**
- Create: `crates/buzz-meter/Cargo.toml` (axum, hyper, tokio, serde, serde_json, reqwest with `stream`, tracing; match workspace versions from `buzz-relay`'s Cargo.toml)
- Create: `crates/buzz-meter/src/lib.rs`, `src/server.rs`, `src/anthropic.rs`, `src/openai.rs`
- Modify: root `Cargo.toml` workspace members

**Interfaces:**
- Produces:

```rust
/// One observed provider call, emitted on the meter's mpsc channel.
pub struct MeteredCall {
    pub provider: String,          // "anthropic" | "openai"
    pub request_id: String,        // provider request id (header or body id)
    pub model: Option<String>,
    pub http_status: u16,
    pub tokens: Option<UsageBreakdown>, // None for non-2xx or usage-less responses
    pub timestamp: String,         // RFC 3339, captured at response completion
    /// Label bound to the virtual key that authenticated this call
    /// (the spawning harness sets it to the agent's hex pubkey).
    pub agent_label: String,
}

pub struct MeterConfig {
    pub anthropic_upstream: String, // default "https://api.anthropic.com"
    pub openai_upstream: String,    // default "https://api.openai.com"
    /// Real provider credentials. Custody rule: these live HERE and are
    /// attached at forward time; they are never placed in an agent's
    /// environment and never appear in a MeteredCall or log line.
    pub anthropic_api_key: Option<String>,
    pub openai_api_key: Option<String>,
}

/// Bind 127.0.0.1 on an ephemeral port. Returns the bound port and a stream
/// of observed calls. The server forwards /anthropic/* and /openai/* to the
/// configured upstreams, byte-transparent, and parses usage on the side.
pub async fn start_meter(config: MeterConfig) -> Result<(u16, tokio::sync::mpsc::Receiver<MeteredCall>, MeterHandle), MeterError>;

/// Owns the server task; `MeterHandle::shutdown()` stops listening and closes
/// the channel. Dropping it also shuts down (abort-on-drop).
pub struct MeterHandle { /* JoinHandle + shutdown signal + issued-key registry */ }

impl MeterHandle {
    /// Mint a per-agent virtual key: an opaque `colony-vk-` prefixed random
    /// token (32 bytes, hex) bound to `label`. The agent authenticates to the
    /// meter with THIS; it never sees a real key.
    pub fn issue_virtual_key(&self, label: &str) -> String;
    /// Revoke on agent shutdown so a leaked token dies with the process.
    pub fn revoke_virtual_key(&self, key: &str);
}
```

Virtual-key authentication (the custody contract):

- The meter reads the caller's credential from the standard provider header (`x-api-key` for Anthropic paths, `Authorization: Bearer` for OpenAI paths). If it is a currently issued virtual key: strip it, attach the real key for that provider from `MeterConfig`, forward, and stamp the key's `label` into the resulting `MeteredCall`.
- Anything else (no credential, unknown token, revoked token): respond 401 locally with a JSON error body naming the meter (`{"error":"colony-meter: unknown virtual key"}`). NEVER forward, never fall back to the real key.
- Missing real key for a routed provider: 401 locally (`colony-meter: no provider credential configured`), never forward the virtual key upstream.

- Consumes: `buzz_core::usage_record::UsageBreakdown`.

Parsing spec (this is the accuracy contract; every field comes from the provider):

**Anthropic non-streaming** (`POST .../v1/messages`, JSON response): `usage.input_tokens` = uncached input; `usage.cache_read_input_tokens` = cache read; `usage.cache_creation.ephemeral_5m_input_tokens` and `.ephemeral_1h_input_tokens` = cache writes (fall back to `usage.cache_creation_input_tokens` as 5m when the `cache_creation` object is absent); `usage.output_tokens` = output. Request id: `request-id` response header, falling back to body `id`.

**Anthropic streaming** (SSE): `message_start` event carries `message.usage` (input-side counts and initial output); the final `message_delta` carries `usage.output_tokens` (cumulative). Take input-side counts from `message_start`, output from the LAST `message_delta` that has `usage`.

**OpenAI non-streaming** (`POST .../v1/chat/completions` or `/v1/responses`): `usage.prompt_tokens` total input with `usage.prompt_tokens_details.cached_tokens` cached; uncached = prompt minus cached (saturating); cache writes are 0 (OpenAI's auto-cache has no write charge); `usage.completion_tokens` = output (reasoning inside). `/v1/responses` naming: `input_tokens`/`input_tokens_details.cached_tokens`/`output_tokens`; support both shapes. Request id: body `id`.

**OpenAI streaming**: rewrite the request JSON to set `"stream_options": {"include_usage": true}` (merge, do not clobber other stream_options keys) so the final chunk carries `usage`; parse it from the last data chunk that has a non-null `usage`.

Transparency rule: the bytes the agent receives must be byte-identical to what the upstream sent (tee, never transform the response). The only permitted request mutation is the `stream_options` merge above, plus rewriting the Host header for the upstream.

- [ ] **Step 1: Failing parser tests** (pure functions first, no server): fixture JSON/SSE strings for all four shapes above with exact expected `UsageBreakdown`s; SSE fixtures must include multiple `message_delta`s to prove last-wins; the OpenAI `stream_options` merge test proves existing keys survive.
- [ ] **Step 2: Run, watch fail; implement parsers in `anthropic.rs`/`openai.rs`; watch pass.**
- [ ] **Step 3: Failing server tests**: spin an in-process axum fake upstream returning a fixture (one per shape); point the meter at it; make a reqwest call through the meter authenticated with an issued virtual key; assert (a) the client saw byte-identical body and status, (b) one `MeteredCall` arrived with exact counts and the issuing label, (c) a 429 upstream response yields `MeteredCall { http_status: 429, tokens: None }` and passes the body through, (d) an unroutable path returns 502 without panicking, (e) the fake upstream received the REAL key and never the virtual token (capture headers in the fake), (f) a call with no credential, an unknown token, or a revoked token gets a local 401 and the fake upstream records zero requests, (g) with no real key configured the virtual key is never forwarded upstream.
- [ ] **Step 4: Implement `server.rs` + `start_meter`; watch pass.** Streaming forward: use `reqwest` with `.bytes_stream()`, forward chunks as they arrive, accumulate a copy for parsing (cap the parse buffer at 8 MiB; past the cap, keep forwarding but abandon usage parsing and emit `tokens: None` with a `tracing::warn!` so a pathological response can never OOM the harness).
- [ ] **Step 5: `cargo test -p buzz-meter && cargo clippy -p buzz-meter -- -D warnings`**
- [ ] **Step 6: Commit**

```bash
git add crates/buzz-meter Cargo.toml
git commit -s -m "feat(meter): add wire metering checkpoint crate"
```

---

### Task 9: Harness integration (`buzz-acp` + `buzz-agent`)

**Files:**
- Modify: `crates/buzz-acp/Cargo.toml` (depend on `buzz-meter`), `crates/buzz-acp/src/main.rs`/`config.rs` (flag `--no-meter` / `BUZZ_ACP_NO_METER`), `crates/buzz-acp/src/acp.rs` (`spawn` env injection), `crates/buzz-acp/src/pool.rs` (work-context snapshot + publisher task)
- Modify: `crates/buzz-agent/src/*` ONLY IF it does not already honor `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` (check first: `grep -rn "BASE_URL\|api.anthropic\|api.openai" crates/buzz-agent/src/`; if hosts are hardcoded, read them from those env vars with the hardcoded value as default)

**Interfaces:**
- Consumes: `start_meter`, `MeteredCall` (Task 8); `encrypt_usage_record`, `UsageRecordPayload` (Task 1); `KIND_USAGE_RECORD` (Task 2); `PromptContext` fields `agent_keys`, `agent_owner_pubkey`, `rest_client`, `harness_name` (existing, see `publish_agent_turn_metric` in `pool.rs` for the exact publish idiom: p + agent tags, 3s timeout, warn-and-continue on failure).
- Produces: one signed `kind:44210` event per `MeteredCall`, published immediately (crash-safe), work-context snapshot attached.

Env injection map (inject ALL of these in `AcpClient::spawn`, pointing at the meter; extra vars are harmless to harnesses that ignore them):

| Var | Value | Honored by |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:{port}/anthropic` | Anthropic SDKs (buzz-agent, opencode) |
| `ANTHROPIC_HOST` | `http://127.0.0.1:{port}/anthropic` | goose |
| `OPENAI_BASE_URL` | `http://127.0.0.1:{port}/openai/v1` | OpenAI SDKs |
| `OPENAI_HOST` | `http://127.0.0.1:{port}/openai` | goose |
| `OPENAI_API_BASE` | `http://127.0.0.1:{port}/openai/v1` | older OpenAI SDKs |
| `ANTHROPIC_API_KEY` | per-agent virtual key from `issue_virtual_key(agent_pubkey_hex)` | all Anthropic SDKs |
| `OPENAI_API_KEY` | the same virtual key | all OpenAI SDKs |
| `OPENROUTER_API_KEY` | the same virtual key | openrouter-configured harnesses |

**Key custody in spawn:** the real provider keys are read by the harness from its own config (the same place `global-agent-config.json`-style provider keys already live; `--anthropic-api-key` / `BUZZ_METER_ANTHROPIC_KEY` and the OpenAI equivalents feed `MeterConfig`). The key-name env vars above are ALWAYS set on the child to the virtual key when metering is on, deliberately masking any real key inherited from the parent environment: the agent process must never be able to read a real provider credential from its env. Issue one virtual key per agent at spawn (label = agent hex pubkey), revoke it when the agent exits.

Precedence must follow the existing `spawn` convention (`spawn_applies_runtime_env_defaults_with_extra_env_precedence` test): explicit extra_env wins over meter defaults, so an operator can opt a single agent out. Exception: when metering is ON, the four key-name vars are NOT overridable by extra_env (an override would hand the agent a real key and silently un-meter it); opting out is `--no-meter` per harness invocation, an explicit choice, never a side effect. Codex reads providers from `CODEX_CONFIG` model_providers, not env; codex coverage is OUT of this plan's gate (record it in the PR body and TESTING.md as a known gap with the follow-up: merge a `model_providers` base_url override into `build_codex_config_env`).

Work-context snapshot: `pool.rs` already computes the per-turn `AgentWorkContext` it gives `publish_agent_turn_metric`. Hold the current turn's context in an `Arc<std::sync::RwLock<Option<AgentWorkContext>>>` owned by the pool: set it where the turn begins (the same place the 44200 path resolves it), clear it at turn end. The meter consumer task reads the snapshot at each `MeteredCall` arrival. Calls landing between turns publish with `work_context: None` (the rulebook or Needs Review picks them up; that is correct, not a bug).

Publisher task (spawned once at pool startup when metering is on):

```rust
// Sketch of the consumer loop; adapt names to pool.rs conventions.
while let Some(call) = meter_rx.recv().await {
    let Some(owner_pk) = ctx.agent_owner_pubkey.as_ref() else { continue };
    let payload = UsageRecordPayload {
        source: UsageSource::Wire,
        provider: call.provider,
        request_id: call.request_id,
        model: call.model,
        timestamp: call.timestamp,
        payment_mode: payment_mode_from_config, // --payment-mode metered|imputed, default metered
        tokens: call.tokens,
        amount_nanousd: None,
        harness: Some(ctx.harness_name.clone()),
        session_id: current_session_id(),   // same source the 44200 path uses
        turn_id: current_turn_id(),
        http_status: Some(call.http_status),
        description: None,
        // agent_label was bound at issue_virtual_key time; prefer it over
        // ambient context (it is wire-authenticated, not inferred).
        agent_pubkey: Some(call.agent_label),
        channel_id: current_channel_id().map(|id| id.to_string()),
        work_context: work_context_snapshot.read().ok().and_then(|g| g.clone()),
    };
    if payload.tokens.is_none() { continue; } // non-2xx or unparsed: log, do not publish
    // encrypt_usage_record -> EventBuilder kind 44210 -> tags [p owner, agent self]
    // -> sign -> submit with 3s timeout; warn-and-continue on any failure.
    // Copy the publish idiom from publish_agent_turn_metric verbatim.
}
```

`--payment-mode` is a new harness flag (`metered` default, `imputed` for subscription-backed agents), stored in config beside the existing agent flags.

- [ ] **Step 1: Failing env-injection tests**: extend the `spawn_named_and_read_child_env` harness (`acp.rs` tests) to assert (a) a spawned agent sees `ANTHROPIC_BASE_URL` pointing at the configured meter port, (b) with a real `ANTHROPIC_API_KEY` present in the PARENT environment and metering on, the child sees the `colony-vk-` virtual key and NOT the parent's value (the masking test: this is the guardrail, watch it fail first), (c) extra_env overrides base URLs but cannot override the four key-name vars while metering is on, (d) with `--no-meter` none of the meter vars are set and parent inheritance behaves as today.
- [ ] **Step 2: Failing publisher test**: pure function `build_usage_record_event(call, snapshot, ctx_bits) -> Result<nostr::Event>` extracted so it is testable without a relay: feed a `MeteredCall`, assert kind 44210, `p`/`agent` tags, and that the owner key decrypts to the expected payload including the snapshot context.
- [ ] **Step 3: Implement**: meter startup in `main.rs` (skipped under `--no-meter`), env injection in `spawn`, snapshot wiring, consumer task, `--payment-mode`.
- [ ] **Step 4: buzz-agent base-URL check**: run the grep above; patch only if hardcoded; add a unit test that the client host comes from the env var when set.
- [ ] **Step 5: Run** `cargo test -p buzz-acp -p buzz-agent -p buzz-meter && cargo clippy -p buzz-acp -p buzz-agent -- -D warnings`.
- [ ] **Step 6: Commit**

```bash
git add crates/buzz-acp crates/buzz-agent
git commit -s -m "feat(acp): meter agent provider calls at the wire and publish usage records"
```

---

### Task 10: CLI (`buzz ledger`)

**Files:**
- Create: `crates/buzz-cli/src/commands/ledger.rs`
- Modify: `crates/buzz-cli/src/lib.rs` (enum `LedgerCmd`, `Cmd::Ledger` variant, dispatch, `command_inventory_is_stable` expected groups += `"ledger"`), `crates/buzz-cli/src/client.rs` (fetch helpers), `crates/buzz-cli/TESTING.md` (runbook section + checklist rows)

**Interfaces:**
- Consumes: everything from Tasks 1-7. Phase 2's `crates/buzz-cli/src/commands/parties.rs` is the structural template (subcommand enum, JSON output, exit codes, `--format compact` global flag).
- Produces subcommands:

| Subcommand | Does |
|---|---|
| `buzz ledger prices add --model M --input-per-mtok-usd 3.00 --cache-read-per-mtok-usd 0.30 --cache-write-5m-per-mtok-usd 3.75 --cache-write-1h-per-mtok-usd 6.00 --output-per-mtok-usd 15.00 [--effective-from RFC3339] [--note S]` | signs a `kind:40017` `AddPriceEntry` (USD flags converted to nanoUSD ONCE at the CLI boundary; `3.00`/MTok -> 3000; reject sub-nano precision with exit 1) |
| `buzz ledger prices list` | prints the pricebook head |
| `buzz ledger rules add --id I --priority N [--match-provider P] [--match-harness H] [--match-model M] [--match-channel C] [--match-agent-pubkey K] --company X --cost-centre C --team T --purpose sales\|marketing\|administration\|internal_product\|client_delivery\|uncertain [--client ORG] [--task T]` | `AddRule` |
| `buzz ledger correct --record EVENT_ID --company X --cost-centre C --team T --purpose P [--client ORG] --reason "text"` | `AddCorrection` |
| `buzz ledger budget set --cost-centre C --period 2026-08 --amount-usd 500.00` | `SetBudget` |
| `buzz ledger record --provider slug --reference invoice-123 --amount-usd 12.50 [--description S] [--imputed]` | owner-signed manual `kind:44210` (owner encrypts to self) |
| `buzz ledger report [--from RFC3339] [--to RFC3339]` | fetches 44210s + four heads, decrypts with the caller's key (must be the owner), runs `compute_ledger`, prints the `LedgerReport` as JSON |
| `buzz ledger reconcile --provider-costs file.csv [--tolerance-usd 0.01]` | CSV columns `provider,day,amount_usd`; runs report then `reconcile`; nonzero exit (4) when drift exceptions exist |

All relay queries include explicit `kinds` (p-gate). Receipt handling, exit codes, and write-result JSON follow the parties command exactly (exit 5 on `conflict:` receipts).

- [ ] **Step 1: Failing tests**: `command_inventory_is_stable` (add `"ledger"`, run, watch fail on count); unit tests for the USD-to-nanoUSD flag conversion (exact: `"3.00"` -> 3000 per token; `"0.0005"`/MTok rejected as sub-nano) and the reconcile CSV parser.
- [ ] **Step 2: Implement, watch pass.**
- [ ] **Step 3: `cargo test -p buzz-cli && cargo clippy -p buzz-cli -- -D warnings`**
- [ ] **Step 4: TESTING.md runbook rows** (follow § 7c parties formatting): prices add/list, rule add, one manual record, report, reconcile happy + drift.
- [ ] **Step 5: Commit**

```bash
git add crates/buzz-cli
git commit -s -m "feat(cli): add buzz ledger subcommands"
```

---

### Task 11: Desktop minimal slice (CFO report in chat)

**Files:**
- Create: `desktop/src-tauri/src/commands/ledger.rs` (Tauri command `ledger_report`)
- Modify: `desktop/src-tauri/src/commands/mod.rs`, `desktop/src-tauri/src/main.rs` handler registration
- Create: `desktop/src/features/ledger/contracts.ts`, `desktop/src/features/ledger/hooks.ts`, `desktop/src/features/ledger/ui/LedgerReportView.tsx`
- Modify: `desktop/src/shared/constants/kinds.ts` (mirror the seven kind integers), `desktop/src/testing/e2eBridge.ts` + `desktop/tests/helpers/bridge.ts` (mock `ledger_report`)
- Create: `desktop/src/features/ledger/ledger.test.mjs`

Scope discipline: this is deliberately thin. NO new page, NO navigation entry (chat is the primitive). The deliverable is: a `ledger_report` Tauri command that fetches `kind:44210` + the four heads from the relay, decrypts with the owner key held by the Tauri backend, runs `buzz_core::ledger::compute_ledger`, and returns the `LedgerReport` as JSON; plus a `LedgerReportView` React component (totals: COGS / OPEX / Needs Review / metered vs imputed, the Needs Review entry list, exceptions list) rendered where Colony company views already render. Find that surface with `grep -rn "CompanyProfile\|colony-company" desktop/src/features/ --include="*.tsx" -l` and mount alongside; do not invent a new shell. Corrections from the UI are OUT (CLI covers corrections this phase).

- [ ] **Step 1: Failing TS test** (`ledger.test.mjs`, node test runner like `partyRepository.test.mjs`): `parseLedgerReport` validates shape and rejects a negative total; totals formatting helper renders nanoUSD as `$0.0705` style strings (exact cases: `70_500_000n` -> `"$0.07"`, `1_234_000_000_000n` -> `"$1,234.00"`).
- [ ] **Step 2: Implement contracts + hooks** (React Query, keys rooted `["colony-ledger", communityId]`, reset via `resetPartyRepositoryState` pattern: add `resetLedgerState()` and wire it into `resetCommunityState()` in `desktop/src/features/communities/useCommunityInit.ts`; this is mandatory per the community-switching rule).
- [ ] **Step 3: Tauri command** (template: whichever existing command in `desktop/src-tauri/src/commands/` already reads relay events with the owner key; find with `grep -rn "decrypt" desktop/src-tauri/src/commands/ | head`). Rust unit test with a fixture event set.
- [ ] **Step 4: Component** with stock rem tokens only; register mock in both bridge files.
- [ ] **Step 5: Run** `cd desktop && pnpm test && pnpm exec tsc --noEmit && cargo test --manifest-path src-tauri/Cargo.toml`. NOTE the worktree gotcha: `just desktop-tauri-fmt` fails in worktrees; run it from the main checkout before committing.
- [ ] **Step 6: Commit**

```bash
git add desktop/src desktop/src-tauri
git commit -s -m "feat(desktop): render CFO ledger report from the deterministic engine"
```

---

### Task 12: Live E2E gate

**Files:**
- Create: `crates/buzz-test-client/tests/e2e_cost_ledger.rs`
- Modify: `TESTING.md` (gate section)

Relay startup facts (paid for in Phase 2, do not rediscover): `BUZZ_AUTO_MIGRATE=true` or events table silently missing; `BUZZ_RELAY_PRIVATE_KEY` set; `RELAY_OWNER_PUBKEY` = the test owner; per-run `BUZZ_METRICS_PORT`/`BUZZ_HEALTH_PORT`; **fresh relay process per full run** (documented WS-harness flake on long-lived processes); run as `exec env ... | tee log` as the background command itself. Template: `e2e_party_identity.rs` (its `broker()`/`head()` helpers, single-retry, fresh-connection reader).

Test list (each is its own `#[tokio::test]`, serialized the way the party suite serializes):

1. `non_owner_ledger_action_is_refused`: assert receipt outcome Conflict AND message contains `ledger actions require the community owner`.
2. `price_entries_append_through_broker`: two `AddPriceEntry` receipts Applied; pricebook head contains both in order.
3. `metered_call_produces_exact_usage_record`: start `buzz-meter` pointed at an in-test fake Anthropic server returning a fixture with all five categories nonzero; make one HTTP call through it; publish the resulting record via the Task 9 builder; fetch kind 44210 from the relay, decrypt as owner, assert every category equals the fixture exactly.
4. `republished_record_counts_once`: publish the same payload twice (two events, same provider+request_id); `compute_ledger` over fetched records yields one entry and zero exceptions.
5. `classification_flows`: three records (explicit COGS context with client org; explicit Administration; no context) + one rule matching nothing; report shows cogs>0, opex>0, one Needs Review.
6. `correction_preserves_original`: correct the Administration record to ClientDelivery+client via broker; recompute; effective Cogs, original Opex still on the entry.
7. `unknown_model_is_unpriced_then_priced`: record with a model absent from the book: UnpricedModel exception + Needs Review; add the price entry; recompute; priced, exception gone.
8. `reconcile_detects_drift`: provider CSV matching the report passes; +$1.00 on one day yields exactly one ReconcileDrift.

- [ ] **Step 1: Write tests 1-2, run against the relay, watch 1 fail for the RIGHT reason** (Conflict with the exact message, not "unknown event kind"; if you see "restricted: unknown event kind", Task 2 missed a site: fix there, not here).
- [ ] **Step 2: Tests 3-8, one at a time, red-green each.**
- [ ] **Step 3: Full-suite run against a fresh relay + fresh DB. All 8 green.**
- [ ] **Step 4: THE BLOCKER KILL SHOT (manual, documented, not CI):** run `buzz-acp` with `buzz-agent` and a real provider key, meter on; one real turn; `buzz ledger report` as owner shows one wire record with nonzero provider-itemized counts. Record the transcript in TESTING.md. This is the phase's headline proof: real money observed at the wire with zero agent self-reporting.
- [ ] **Step 5: TESTING.md gate section** (env vars, fresh-relay rule, the manual kill-shot procedure, codex known gap, and the scope rule: only harness-spawned agents are metered, so the live proof and any reconciliation run must use a Colony-dedicated provider key, never a key shared with personal tooling).
- [ ] **Step 6: Commit**

```bash
git add crates/buzz-test-client/tests/e2e_cost_ledger.rs TESTING.md
git commit -s -m "test(e2e): live cost-ledger gate"
```

---

### Task 13: NIP-CL spec + roadmap close-out

**Files:**
- Create: `docs/nips/NIP-CL.md`
- Modify: `docs/superpowers/plans/2026-07-31-colony-company-os-roadmap.md` (Phase 3 status note)

- [ ] **Step 1: Write `docs/nips/NIP-CL.md`** (follow NIP-AM.md's structure): the seven kinds with their table; `UsageRecordPayload` JSON schema with the tokens-XOR-amount rule and forward-compat rule; the dedupe key contract (`provider:request_id` wire, event id manual; first by created_at wins; conflicting duplicate = exception); price semantics (nanoUSD/token, effective-from inclusive, latest-appended tie-break, unknown model = unpriced never zero); the six-step engine ordering from Task 5 verbatim (it is normative); broker action/receipt semantics and every refusal message string; the metered/imputed payment-mode contract; the 44200 self-report demotion to cross-check.
- [ ] **Step 2: Roadmap Phase 3 note**: link this plan; state what is in scope (wire metering for env-honoring harnesses, CLI, minimal desktop report) and out, listed as Phase 3 follow-ups: codex config injection, automated provider-API reconciliation fetch, desktop corrections UI, turn-metric cross-check report, and margin reporting (margin needs revenue records, which do not exist until Phase 6 Opportunities; the roadmap's "margin" deliverable is explicitly deferred to when revenue is modeled, and the cost side it needs is fully delivered here).
- [ ] **Step 3: Commit**

```bash
git add docs/nips/NIP-CL.md docs/superpowers/plans/2026-07-31-colony-company-os-roadmap.md
git commit -s -m "docs: specify NIP-CL cost ledger and close Phase 3 plan scope"
```

---

## Final gate before PR

- [ ] `just ci` clean (fmt + clippy + desktop lint + unit tests + builds). Known pre-existing failure that is NOT yours: `api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo` fails on develop; leave it.
- [ ] `just test` if Postgres + Redis available (relay/db/auth touched: yes).
- [ ] All 8 E2E tests green on a fresh relay; kill-shot transcript in TESTING.md.
- [ ] PR to `develop` from `colony/cost-ledger`; PR body separates implemented / locally tested / live-proven states explicitly and lists the declared scope cuts.

## Proof gate (from the roadmap, restated)

Every paid run is counted once; reprocessing is idempotent; direct client delivery flows to COGS; internal work flows to OPEX; uncertainty appears in Needs Review; corrections preserve the original evidence. Plus this plan's addition: at least one REAL agent turn against a REAL provider has produced a wire-captured, owner-decrypted usage record with provider-itemized counts, with the agent's self-report playing no part.
