# Colony Discovery Outscraper Source Gate Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, with a proof
> gate between commits. Subagent delegation is not authorized for this task.

**Goal:** Turn the proven local worker into Colony's first real, restart-safe
Outscraper Businesses source while adding safe credential controls and retained
normalized source observations.

**Architecture:** A signed Discovery start action carries a bounded, non-secret
Businesses search snapshot. The relay persists that snapshot with the run and
returns it only in the worker's private leased projection. The trusted desktop
worker reads the Outscraper key from the existing OS keychain, submits and polls
the current official asynchronous Google Maps Search API, normalizes a strict
field allowlist, and sends bounded signed observation batches back through the
fenced worker protocol. The relay persists observations and usage idempotently;
the frontend can configure but never recover the secret.

**Tech Stack:** Rust, Tauri 2, React 19, Nostr signed events, Colony Postgres
migrations, `reqwest`, Tokio, serde, Node contract tests, Playwright mock bridge.

**Approved scope:** Outscraper Businesses acquisition only. This gate does not
add People Discovery, LLM qualification, deduplication, Leads, Outreach, Brave,
Exa, Colony credits, pricing, or checkout.

---

## Task 1: Integrate current `develop` without overlapping parallel work

**Files:**
- No intended product-file changes.

- [x] Recheck `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine` with `git status --short --branch` and `git log -5 --oneline`; require clean `fa52ff60d` unless new evidence appears.
- [x] Inspect `git diff --name-status HEAD...origin/develop`; confirm the five incoming profile/onboarding/test commits do not touch Discovery.
- [x] Run `. ./bin/activate-hermit && git rebase origin/develop` from `discovery-next`.
- [x] Run `git status --short --branch` and `git rev-list --left-right --count origin/develop...HEAD`; expect a clean worktree and `0` commits behind.
- [x] Run the existing focused foundation tests before new code:

```bash
cargo test -p buzz-core discovery
cargo test -p buzz-sdk discovery
cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_
cd desktop && node --test src/shared/api/discoveryCredentials.test.mjs
```

- [x] Record any rebased commit-hash corrections in the existing evidence document before later evidence refers to them.

## Task 2: Add a bounded Businesses search snapshot to the signed run contract

**Files:**
- Modify: `crates/buzz-core/src/discovery.rs`
- Modify: `crates/buzz-sdk/src/discovery.rs`
- Modify: `crates/buzz-core/src/discovery_worker.rs`
- Modify: `crates/buzz-sdk/src/discovery_worker.rs`
- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/commands/discovery.rs`
- Modify: `crates/buzz-relay/src/discovery_broker.rs`
- Modify: `crates/buzz-db/src/discovery.rs`
- Create: `migrations/0033_discovery_business_search.sql`

- [x] Add failing core tests for trimmed query/location validation, maximum lengths, result limit `1..=500`, lowercase ISO language, uppercase ISO region, and strict serialization with no credential-shaped field.
- [x] Define the shared non-secret snapshot and require it on new starts:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryBusinessSearchSpec {
    pub query: String,
    pub location: String,
    pub limit: u16,
    pub language: String,
    pub region: Option<String>,
}

pub struct DiscoveryStartRequest {
    pub request_id: Uuid,
    pub idempotency_key: Uuid,
    pub campaign_id: Uuid,
    pub business_search: DiscoveryBusinessSearchSpec,
}
```

- [x] Validate before signing and again at relay admission. Build the final provider query as `"{query}, {location}"`; do not accept an arbitrary URL, endpoint, headers, enrichment list, or provider name from an event.
- [x] Store the snapshot in a separate `discovery_run_business_searches` row so historical foundation runs remain readable. External workers may claim only runs with a complete snapshot.
- [x] Include `business_search: DiscoveryBusinessSearchSpec` only in `DiscoveryWorkerLeaseProjection`. Do not expose user-authored search terms through the ordinary run/status receipt.
- [x] Extend CLI start with `--query`, `--location`, `--limit`, `--language`, and optional `--region`. Keep `--campaign` as the stable Campaign reference.
- [x] Update SDK canonical-envelope tests so invalid search fields and unknown secret-shaped fields are rejected. The signed event authenticates the complete canonical content.
- [x] Run:

```bash
cargo test -p buzz-core discovery
cargo test -p buzz-sdk discovery
cargo test -p buzz-cli discovery
cargo test -p buzz-db discovery --no-fail-fast
cargo test -p buzz-relay discovery --no-fail-fast
```

- [x] Commit with `git commit -s -m "feat(discovery): carry business search into worker leases"`.

## Task 3: Add strict normalized observations and idempotent relay persistence

**Files:**
- Modify: `crates/buzz-core/src/discovery_worker.rs`
- Modify: `crates/buzz-sdk/src/discovery_worker.rs`
- Modify: `crates/buzz-db/src/discovery.rs`
- Modify: `crates/buzz-relay/src/discovery_worker_broker.rs`
- Inspect unchanged: `crates/buzz-relay/src/event_admission.rs`
- Create: `migrations/0034_discovery_business_observations.sql`
- Modify: `schema/schema.sql`

- [x] Add failing strict-contract tests for a bounded observation batch, maximum string lengths, finite/ranged coordinates and rating, nonnegative counts, valid provider identifiers, and rejection of unknown/raw fields.
- [x] Define a business allowlist sufficient for the existing UI and later identity resolution:

```rust
pub struct DiscoveryBusinessObservationInput {
    pub observation_id: Uuid,
    pub provider_record_id: String,
    pub place_id: Option<String>,
    pub google_id: Option<String>,
    pub name: String,
    pub website: Option<String>,
    pub phone: Option<String>,
    pub full_address: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub latitude_micros: Option<i32>,
    pub longitude_micros: Option<i32>,
    pub category: Option<String>,
    pub subtypes: Vec<String>,
    pub rating_hundredths: Option<u16>,
    pub reviews_count: Option<u32>,
    pub business_status: Option<DiscoveryBusinessStatus>,
    pub verified: Option<bool>,
    pub source_url: Option<String>,
    pub image_url: Option<String>,
}

pub struct DiscoveryWorkerObservationBatchRequest {
    #[serde(flatten)]
    pub lease: DiscoveryWorkerLeaseRequest,
    pub provider_request_id: String,
    pub batch_index: u32,
    pub observations: Vec<DiscoveryBusinessObservationInput>,
}
```

- [x] Add `StoreObservations` to the worker operation contract. Require batches of `1..=25`, a strict provider request ID, and deterministic provider-scoped `observation_id` values so retries are naturally idempotent.
- [x] Create `discovery_business_observations`, `discovery_observation_batches`, and `discovery_usage`. Scope every key by community; retain one Outscraper record per workspace even when later campaigns rediscover it, and keep one aggregate usage row per run.
- [x] Persist a complete business-relevant normalized record, not arbitrary provider JSON, response headers, request URLs, error bodies, or credentials.
- [x] Under the same transaction, verify the current worker/lease/fence, insert observations, and update returned/stored/existing counts. Replaying the same batch succeeds without inflating usage; conflicting content for an already committed batch index fails closed; a later campaign's updated copy of an existing provider record does not overwrite or duplicate the retained business.
- [x] Return only safe accepted/existing counts in the private relay receipt. Verify the existing kind-level result gate keeps observation actions and receipts actor-private and outside full-text search.
- [x] Add database tests for replay, conflicting replay, stale lease, cancellation, revocation, cross-community access, usage totals, and secret absence.
- [x] Run the same core/SDK/database/relay commands from Task 2 and the existing search privacy test.
- [x] Commit with `git commit -s -m "feat(discovery): retain normalized source observations"`.

## Task 4: Implement the current Outscraper asynchronous client

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/outscraper.rs`
- Create: `desktop/src-tauri/src/discovery_worker/normalization.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/adapter.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/mod.rs`
- Modify: `desktop/src-tauri/Cargo.toml` only if a test-only dependency is genuinely required.

- [x] Add a local Axum test server covering synchronous success, `202 Pending` then `Success`, repeated `Pending`, `Failure`, `401`, `402`, `422`, `429`, `5xx`, malformed JSON, oversized bodies, timeout, cancellation, and a response that contains unknown fields.
- [ ] Implement a concrete client with fixed production endpoints from the current official API contract:

```rust
const SEARCH_ENDPOINT: &str = "https://api.outscraper.com/google-maps-search";
const REQUESTS_ENDPOINT: &str = "https://api.outscraper.com/requests";

pub struct OutscraperClient {
    http: reqwest::Client,
    endpoints: OutscraperEndpoints,
    poll: PollPolicy,
}
```

- [x] Submit `POST /google-maps-search` with the official query parameters: one `query=category, location`, `limit`, `language`, optional `region`, `async=true`, and a fixed field allowlist; place the secret only in `X-API-KEY`. Do not copy SalesTeams' server environment fallback, Redis cache, platform cost estimate, or legacy `/maps/search-v3` URL.
- [x] Return the opaque request ID for checkpointing before polling. Poll only `GET /requests/{requestId}` using a locally constructed URL; never follow `results_location` from the provider response.
- [x] Bound connect/request timeout, response bytes, poll interval, total poll duration, and retry count. Retry `429` and transient `5xx` with bounded backoff; classify `401`, `402`, and `422` as terminal actionable states without retaining raw bodies.
- [x] Parse only the known response envelope and normalized place fields. Allow unknown provider fields at the response edge, then discard them during conversion.
- [x] Normalize `website` with legacy `site` fallback, canonical source identifiers, address, coordinates, category/type, subtypes, ratings, status, verified state, image, and source URL. Reject records without a non-empty name or any stable provider identifier.
- [x] Ensure debug/error implementations never include headers, the API key, full response bodies, or a complete user-authored query.
- [x] Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_worker::outscraper -- --nocapture` and `cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`.
- [x] Commit with `git commit -s -m "feat(discovery): integrate Outscraper business search"`.

## Task 5: Replace proof-only execution with production provider supervision

**Files:**
- Modify: `desktop/src-tauri/src/discovery_worker/adapter.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/protocol.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/src/app_state.rs` only if the shared HTTP client cannot satisfy provider limits.

- [x] Introduce an injected provider trait whose production implementation is `OutscraperClient` and whose deterministic fake remains available only behind the explicit proof flag.
- [x] Start the production host by default after successful workspace setup, except during shutdown or identity/keyring/reset recovery. Missing credentials cause zero claims and zero provider traffic.
- [x] Require the relay-issued immutable `lease.business_search`; the relay leaves runs without that private search contract unclaimed rather than inventing a query.
- [x] Implement exact resume behavior:

```text
no checkpoint -> submit once -> checkpoint provider_submitted
provider_submitted -> poll existing request -> store deterministic batches
all batches stored -> checkpoint provider_results_ready
provider_results_ready -> complete without provider traffic
```

- [x] Heartbeat immediately before and throughout submit and polling, and renew the lease on every observation write. Cancellation, entitlement loss, workspace generation change, credential change, or shutdown cancels pending work and prevents every later action.
- [x] Add `store_observations` to `WorkerProtocol` and strict signed-receipt matching. A stale or mismatched receipt cancels the attempt.
- [x] Add a privacy-safe `fail` worker operation so a terminal provider error cannot leave a paid run retrying forever; retain only the generic `executor_failed` reason.
- [x] Test restart points after provider checkpointing, batch persistence, and results checkpoint. Prove one provider submission after the durable provider reference, idempotent observation replay, and one completion.
- [x] Keep the fake-worker proof path network-incapable and explicit; the production path is not selected when the fake flag is enabled.
- [x] Run all `discovery_worker` tests, a fresh-database worker failure proof, strict Clippy for core/SDK/database/relay/desktop, and `scripts/discovery-worker-live-proof.sh`.
- [x] Commit with `git commit -s -m "feat(discovery): execute restart-safe Outscraper runs"`.

## Task 6: Add safe Discovery credential controls to Colony Settings

**Files:**
- Create: `desktop/src/features/settings/ui/DiscoverySettingsCard.tsx`
- Create: `desktop/src/features/settings/ui/discoverySettings.test.mjs`
- Modify: `desktop/src/features/settings/ui/SettingsPanels.tsx`
- Modify: `desktop/src/features/settings/ui/SettingsView.tsx`
- Modify: `desktop/src/shared/api/discoveryCredentials.ts` only if safe status typing needs correction.
- Modify: `desktop/package.json`
- Modify: `desktop/tests/helpers/e2eBridge.ts`
- Create: `desktop/tests/e2e/discovery-settings.spec.ts`
- Modify: `desktop/playwright.config.ts`

- [x] Add failing contract tests for a `discovery` Settings section and a card that imports only save/status/delete—not an API that can reveal a stored value.
- [x] Add Discovery under the App settings group with a Telescope icon and render `DiscoverySettingsCard`.
- [x] Implement four explicit states: loading, not configured, configured on this device, and keychain unavailable. Use a password input only for a new/replacement key; clear React state immediately after save settles.
- [x] Provide Save/Replace and Remove actions with inline success/error copy. Never display a prefix, suffix, character count, last four characters, raw Tauri error, or a reveal button for the stored key.
- [x] Explain in user-facing copy that Outscraper charges the customer's account and Colony neither receives nor synchronizes the key. Do not invent price estimates.
- [x] Mock the three Tauri commands in the E2E bridge. Prove initial missing, successful save/configured, reload/configured without secret recovery, remove/missing, unavailable, trimmed-empty rejection, and disabled duplicate submissions.
- [x] Capture focused Settings screenshots after animations complete; verify no secret value appears in DOM text, accessibility snapshot, console, or image fixture names.
- [x] Run:

```bash
cd desktop
node --test src/shared/api/discoveryCredentials.test.mjs src/features/settings/ui/discoverySettings.test.mjs
pnpm lint
pnpm typecheck
pnpm build:e2e
pnpm exec playwright test tests/e2e/discovery-settings.spec.ts --project=smoke
```

- [x] Commit with `git commit -s -m "feat(discovery): configure Outscraper on this device"`.

## Task 7: Prove the source gate without spending customer money

**Files:**
- Modify: `scripts/discovery-worker-live-proof.sh`
- Create: `scripts/discovery-outscraper-source-proof.sh`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host.rs` ignored live test module.
- Modify: `docs/superpowers/specs/2026-08-02-colony-discovery-outscraper-businesses-design.md`

- [x] Extend the isolated harness with a local provider server that records request count and sanitized request shape but never accepts or prints a real key.
- [x] Start a run carrying `dentists` + `Sandton, Johannesburg, South Africa`, limit `3`, language `en`, region `ZA`; prove the worker sends the correct fixed endpoint request and header presence without retaining the fixture secret.
- [x] Return `Pending`, terminate the first host after the submitted checkpoint, restart with the same worker ID, then return three results. Prove exactly one provider submission, resumed polling, three retained normalized observations, returned/stored usage `3`, attempt `2`, and success.
- [x] Repeat with cancellation, entitlement revocation, `401`, `402`, `422`, `429` recovery, terminal `5xx`, malformed payload, and source exhaustion. Prove truthful safe outcomes and zero later calls after lease loss.
- [x] Search process output, Nostr event content, Discovery tables, and screenshots for the fixture key; expect zero matches.
- [x] Run `scripts/discovery-outscraper-source-proof.sh`; require an explicit PASS summary naming request idempotency, restart recovery, persistence, usage, privacy, and failure classification.
- [x] Do not execute a real Outscraper request in this task. A real paid call requires the user's explicit spending approval after every no-cost proof passes.

## Task 8: Run the full acceptance gate and record evidence

**Files:**
- Modify only files required to correct failures attributable to this branch.
- Modify: `docs/superpowers/specs/2026-08-02-colony-discovery-outscraper-businesses-design.md`

- [x] Run focused core, SDK, database, relay, desktop worker, credential, Settings, and Playwright commands from Tasks 2-7.
- [x] Run `git diff --check` and the production marker scan:

```bash
rg -n "T[O]DO|T[B]D|place[h]older|example\.com|sk-[A-Za-z0-9]" \
  crates/buzz-core/src/discovery.rs \
  crates/buzz-core/src/discovery_worker.rs \
  crates/buzz-sdk/src/discovery.rs \
  crates/buzz-sdk/src/discovery_worker.rs \
  crates/buzz-db/src/discovery.rs \
  crates/buzz-relay/src/discovery_worker_broker.rs \
  desktop/src-tauri/src/discovery_worker \
  desktop/src/features/settings/ui/DiscoverySettingsCard.tsx
```

Result: `git diff --check` passed. The scan found only two benign matches: the
Tailwind `placeholder:` modifier/JSX `placeholder` attribute in the Settings
input, and an adversarial secret-shaped value inside an SDK unit test. No
incomplete marker or secret-like fixture exists in a production path.

- [x] Run `just ci`; require exit `0` or document a clean-`origin/develop` baseline failure without claiming it as fixed.
- [x] Record implemented/tested/committed separately from real-provider-tested, pushed, merged, deployed, and customer-proven.
- [x] Recheck the parallel `discovery-engine` worktree and record that it remained untouched.
- [x] Commit with `git commit -s -m "docs(discovery): record Outscraper source gate"`.

## Acceptance gate result

This gate is complete when all no-cost deterministic and real-relay proofs pass,
the existing Settings UI safely manages the device-local Outscraper credential,
the production worker can execute the official asynchronous provider contract,
restart without a second submission, and retain normalized observations and
usage. It is not complete merely because an HTTP request succeeds.

A single real provider call remains a separate spending gate. It will use a
user-supplied credential, a visible query limit of three records, and no
enrichments only after explicit approval.
