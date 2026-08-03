# Colony Discovery Brave and Exa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Businesses Discovery production-capable across Outscraper,
Brave Search, and Exa Search, with user-selected waterfall or concurrent
execution, customer-owned credentials, durable progress, and workspace-wide
deduplication.

**Architecture:** The relay owns the Campaign's mutable source configuration
and snapshots it immutably into each run. A trusted desktop worker advertises
only the providers configured on that device, claims compatible runs, and
executes the exact saved plan. Provider-specific adapters emit one strict
normalized business contract through a fenced, idempotent relay protocol. The
relay remains authoritative for entitlement, leases, progress, deduplication,
and retained Leads; secrets remain in the operating-system keychain.

**Tech Stack:** Rust, Tokio, `reqwest`, Tauri 2, React 19, TypeScript, Nostr
signed events, Colony Postgres migrations, Node contract tests, Playwright E2E.

---

## Task 1: Introduce strict source-plan types

**Files:**
- Modify: `crates/buzz-core/src/discovery.rs`
- Modify: `crates/buzz-core/src/discovery_workspace.rs`
- Modify: `crates/buzz-core/src/discovery_worker.rs`
- Modify: `crates/buzz-sdk/src/discovery.rs`
- Modify: `crates/buzz-sdk/src/discovery_workspace.rs`
- Modify: `crates/buzz-sdk/src/discovery_worker.rs`

- [x] Add failing core tests for `waterfall` and `concurrent`, the three live
  sources, a non-empty unique source list, stable order, a three-source maximum,
  unknown-field rejection, and source-to-provider mapping.
- [x] Add the shared contracts:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoverySourceMode {
    Waterfall,
    Concurrent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoverySource {
    GoogleMaps,
    BraveSearch,
    ExaSearch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoverySourceConfig {
    pub mode: DiscoverySourceMode,
    pub sources: Vec<DiscoverySource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryProvider {
    Outscraper,
    BraveSearch,
    ExaSearch,
}
```

- [x] Centralize validation and mapping so the UI, CLI, relay, database, and
  worker cannot develop separate source vocabularies.
- [x] Preserve the legacy default as waterfall with `google_maps` so upgraded
  Outscraper Campaigns remain executable.
- [x] Run:

```bash
cargo test -p buzz-core discovery
cargo test -p buzz-sdk discovery
```

- [x] Commit with `git commit -s -m "feat(discovery): define multi-source run plans"`.

## Task 2: Persist Campaign configuration and immutable run snapshots

**Files:**
- Create: `migrations/0039_discovery_multi_source.sql`
- Modify: `schema/schema.sql`
- Modify: `crates/buzz-db/src/discovery.rs`
- Modify: `crates/buzz-db/src/discovery_workspace.rs`
- Modify: `crates/buzz-core/src/discovery_workspace.rs`
- Modify: `crates/buzz-sdk/src/discovery_workspace.rs`
- Modify: `crates/buzz-relay/src/discovery_workspace_broker.rs`
- Modify: `crates/buzz-relay/src/discovery_broker.rs`
- Modify: `crates/buzz-cli/src/commands/discovery.rs`

- [x] Add failing database tests proving create/read/update round trips, strict
  validation, idempotent update replay, community isolation, and that a started
  run keeps its original plan after the Campaign is edited.
- [x] Add `source_mode` plus ordered `source_keys` to `discovery_campaigns`, and
  create a run-source snapshot plus per-source execution rows. Backfill existing
  Campaigns and runs as waterfall/Google Maps without deleting or rewriting any
  observation.
- [x] Expand provider constraints to `outscraper`, `brave_search`, and
  `exa_search`; make usage and observation-batch uniqueness provider-aware.
- [x] Add `update_campaign_sources` as an idempotent workspace operation and
  return the persisted configuration in Campaign projections.
- [x] Require start admission to load and store the Campaign configuration in
  the same transaction that creates the run. Do not trust a caller-supplied
  source plan that differs from the Campaign.
- [x] Extend the CLI with source-config inspection and update arguments while
  keeping agent starts on the same Campaign-owned configuration.
- [x] Run fresh- and upgraded-database migration tests plus:

```bash
cargo test -p buzz-db discovery --no-fail-fast
cargo test -p buzz-relay discovery --no-fail-fast
cargo test -p buzz-cli discovery
```

- [x] Commit with `git commit -s -m "feat(discovery): persist source run plans"`.

## Task 3: Make worker claims capability-aware

**Files:**
- Modify: `crates/buzz-core/src/discovery_worker.rs`
- Modify: `crates/buzz-sdk/src/discovery_worker.rs`
- Modify: `crates/buzz-db/src/discovery.rs`
- Modify: `crates/buzz-relay/src/discovery_worker_broker.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/protocol.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host.rs`

- [x] Add failing contract and database tests proving a worker claims a run only
  when its advertised provider set contains every required provider.
- [x] Add ordered, unique `available_providers` to the private claim request.
  Validate it at signing and relay admission; reveal presence only, never key
  values, identifiers, prefixes, or metadata.
- [x] Return the immutable source snapshot and per-source durable states in the
  leased projection.
- [x] Leave incompatible runs queued and claimable by another device. Do not
  claim and then fail them for a missing credential.
- [x] Prove legacy workers and legacy Outscraper runs fail closed or follow the
  explicit compatibility default without panics.
- [x] Run the focused core, SDK, database, relay, and Tauri worker tests.
- [x] Commit with `git commit -s -m "feat(discovery): match runs to provider workers"`.

## Task 4: Generalize observations, provenance, and deduplication

**Files:**
- Modify: `crates/buzz-core/src/discovery_worker.rs`
- Modify: `crates/buzz-sdk/src/discovery_worker.rs`
- Modify: `crates/buzz-db/src/discovery.rs`
- Modify: `crates/buzz-relay/src/discovery_worker_broker.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/normalization.rs`

- [x] Add failing tests proving observation identity contains provider plus
  provider-record ID, URLs become canonical lowercase digests, and an optional
  bounded description accepts Brave/Exa snippets without weakening strict
  validation.
- [x] Require every observation batch to name its provider and request/page
  identity. Include provider in deterministic observation IDs and batch
  conflict keys.
- [x] Keep exact same-provider identity as the strongest key, then suppress
  cross-provider duplicates by canonical domain, exact normalized phone, or
  normalized name plus locality.
- [x] When a duplicate is encountered, increment that run/source's duplicate
  count but do not insert or Campaign-link a second business or Lead.
- [x] Preserve first-source provenance on the canonical Lead. Persist source
  encounter metrics without overwriting that provenance.
- [x] Add database tests for same-domain Brave/Exa/Outscraper duplicates,
  different communities, idempotent replay, conflicting replay, and retained
  source counts.
- [x] Run focused tests and commit with
  `git commit -s -m "feat(discovery): deduplicate provider observations"`.

## Task 5: Generalize provider credentials without exposing secrets

**Files:**
- Modify: `desktop/src-tauri/src/discovery_credentials.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src/shared/api/discoveryCredentials.ts`
- Modify: `desktop/src/features/settings/ui/DiscoverySettingsCard.tsx`
- Modify: `desktop/src/testing/e2eBridge.ts`
- Modify: `desktop/tests/e2e/discovery-settings.spec.ts`
- Modify: `desktop/src/features/settings/ui/discoverySettings.test.mjs`

- [x] Add failing Rust and TypeScript tests for three strict provider values,
  three separate keychain entries, status-only reads, zeroized inputs,
  idempotent removal, unknown-provider rejection, and secure-storage failure.
- [x] Store keys only under:

```text
discovery.outscraper.api_key
discovery.brave_search.api_key
discovery.exa_search.api_key
```

- [x] Replace Outscraper-specific IPC with provider-parameterized status,
  save, and delete commands. No native or React API may return a key.
- [x] Render three consistent Settings rows and refresh worker capabilities
  after save, replace, or removal without making a provider request.
- [x] Extend the mock bridge and E2E proof to verify all three lifecycles and
  absence of a secret fixture from DOM, accessibility text, console, and IPC
  receipts.
- [x] Run:

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_credentials
cd desktop
node --test src/shared/api/discoveryCredentials.test.mjs src/features/settings/ui/discoverySettings.test.mjs
pnpm typecheck
pnpm exec playwright test tests/e2e/discovery-settings.spec.ts --project=smoke
```

- [x] Commit with `git commit -s -m "feat(discovery): configure three local sources"`.

## Task 6: Implement the Brave Search adapter

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/brave.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/mod.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/normalization.rs`

- [x] Build failing loopback tests for `X-Subscription-Token`, deterministic
  query shape, `count <= 20`, offsets `0..=9`, `more_results_available`, target
  bounds, canonical URL handling, excluded hosts, cancellation, timeout,
  maximum response bytes, malformed JSON, and safe error classification.
- [x] Implement a client whose production endpoint is fixed in native code:

```rust
const BRAVE_SEARCH_ENDPOINT: &str =
    "https://api.search.brave.com/res/v1/web/search";
```

- [x] Send no key, query, response body, or raw provider error through logs or
  Nostr. Retry only bounded `429` and temporary `5xx` responses after current
  lease, entitlement, and cancellation checks.
- [x] Normalize valid company-like HTTP(S) results into the shared observation
  contract with canonical website, title-derived name, snippet, image/favicon,
  source URL, geography, provider, and URL digest.
- [x] Request no more pages than the remaining target permits and never add an
  LLM query multiplier.
- [x] Run the adapter tests and strict Tauri Clippy.
- [x] Commit with `git commit -s -m "feat(discovery): add Brave business search"`.

## Task 7: Implement the Exa Search adapter

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/exa.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/mod.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/normalization.rs`

- [x] Build failing loopback tests for `x-api-key`, POST body, `category:
  company`, `type: auto`, no `excludeDomains`, no contents/summaries, result
  maximum 100, excluded hosts, cancellation, timeout, response bytes, malformed
  JSON, request ID retention, and safe error classification.
- [x] Implement a client with fixed `https://api.exa.ai/search`, one bounded
  request per attempt, and `numResults = min(remaining_target, 100)`.
- [x] Classify 401, 402, 403, 429, and temporary 5xx responses into the shared
  privacy-safe source error vocabulary. Apply bounded retries only where safe.
- [x] Normalize valid company results into the same contract and retain request
  counts without converting provider estimates into Colony credits or billing.
- [x] Run the adapter tests and strict Tauri Clippy.
- [x] Commit with `git commit -s -m "feat(discovery): add Exa company search"`.

## Task 8: Add crash-safe synchronous-provider recovery

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/outbox.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/protocol.rs`
- Modify: `desktop/src-tauri/src/app_state.rs` if lifecycle ownership belongs there.

- [x] Add failing restart tests at call-intent written, response received,
  normalized outbox written, first batch acknowledged, all batches acknowledged,
  and call accepted with no recoverable response.
- [x] Store only workspace-scoped normalized public observations plus run,
  provider, request, and batch identities. Never store keys, headers, raw bodies,
  or arbitrary provider JSON.
- [x] Write intent before Brave/Exa calls; atomically write normalized results
  immediately after receipt; drain idempotently before starting any later paid
  request; delete an entry only after relay acknowledgement.
- [x] Mark an accepted-call/no-response restart as `outcome_unknown` and do not
  repeat it automatically.
- [x] Prove two communities cannot read or drain one another's outbox entries.
- [x] Run restart and secret-scan tests.
- [x] Commit with `git commit -s -m "feat(discovery): recover synchronous source calls"`.

## Task 9: Execute waterfall and concurrent source plans

**Files:**
- Create: `desktop/src-tauri/src/discovery_worker/coordinator.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/protocol.rs`
- Modify: `crates/buzz-core/src/discovery_worker.rs`
- Modify: `crates/buzz-sdk/src/discovery_worker.rs`
- Modify: `crates/buzz-db/src/discovery.rs`
- Modify: `crates/buzz-relay/src/discovery_worker_broker.rs`

- [x] Add deterministic fake-provider tests before production wiring. Record
  call start/end order and expose barriers so concurrency is proven rather than
  inferred from elapsed time.
- [x] Prove waterfall calls only selected sources in exact saved order, checks
  retained net-new count between paid calls, and marks later sources
  `skipped_target_met` without contacting them.
- [x] Prove concurrent starts all selected sources before releasing their
  response barriers, serializes checkpoint sequence writes, stops unstarted
  pages after the target, and retains valid in-flight overshoot.
- [x] Maintain one fenced lease heartbeat. Check cancellation, entitlement,
  worker generation, and lease ownership before every provider call and retry.
- [x] Persist truthful per-source pending, active, completed, exhausted, failed,
  cancelled, `outcome_unknown`, and skipped states plus returned/retained/
  duplicate/request counts.
- [x] One-source failure must preserve other-source success. Fail the entire run
  only when every selected source fails and no usable result was retained.
- [x] Prove Outscraper provider-request resumption still submits exactly once.
- [x] Run all worker, relay, and database Discovery tests.
- [x] Commit with `git commit -s -m "feat(discovery): orchestrate multi-source runs"`.

## Task 10: Connect the live Discovery UI to persisted source plans

**Files:**
- Modify: `desktop/src/features/discovery/data/RelayDiscoveryDataSource.ts`
- Modify: `desktop/src/features/discovery/data/relayDiscoveryModels.ts`
- Modify: `desktop/src/features/discovery/sourceConfig.ts`
- Modify: `desktop/src/features/discovery/components/CreateCampaignSheet.tsx`
- Modify: `desktop/src/features/discovery/components/SourceConfigEditor.tsx`
- Modify: relevant focused tests under `desktop/src/features/discovery/`
- Modify: `desktop/src/testing/e2eBridge.ts`
- Modify: `desktop/tests/e2e/discovery.spec.ts`

- [x] Add failing contract tests showing live Campaigns no longer synthesize a
  Google-Maps-only config and start uses the persisted Campaign plan.
- [x] Remove the live-mode resets and Outscraper-only rejection. Enable the
  three production sources only when their local credentials are configured;
  leave catalogue-only sources visibly unavailable.
- [x] Save mode, selection, and waterfall order through
  `update_campaign_sources`. In concurrent mode preserve the stored order for
  display/fingerprinting but disable drag semantics.
- [x] Block start with one clear message listing missing selected credentials.
  Do not silently remove a configured source.
- [x] Map real source rows, run timeline, counts, failures, and Lead provenance
  from relay projections. Do not hardcode `google_maps` or Outscraper.
- [x] Preserve free/demo fixtures and ensure they make no live-store,
  credential, worker, or provider calls.
- [x] Add E2E cases for create/save/reload, reorder waterfall, concurrent
  selection, missing-key block, progress, one-source failure, and provenance.
- [x] Run desktop unit/contract tests, lint, typecheck, E2E build, and focused
  Playwright tests.
- [x] Commit with `git commit -s -m "feat(discovery): operate persisted source plans"`.

## Task 11: Prove agents use the same primitive

**Files:**
- Modify: `crates/buzz-cli/src/commands/discovery.rs`
- Modify: `crates/buzz-test-client/tests/e2e_discovery.rs`
- Modify: `scripts/discovery-worker-live-proof.sh`
- Create: `scripts/discovery-multi-source-proof.sh`

- [x] Add an E2E relay scenario in which a generic authorized actor creates or
  references a Campaign, updates its source plan, starts a run, inspects the
  same projections as the UI, and cancels it.
- [x] Prove neither the CLI nor signed events expose provider credentials.
- [x] Prove a capable desktop worker claims the agent-started run and an
  incompatible worker cannot.
- [x] Exercise waterfall, concurrent overshoot, dedupe, one-source failure,
  cancellation, entitlement revocation, lost lease, restart, and all-provider
  failure against loopback providers and a real local relay.
- [x] Commit with `git commit -s -m "test(discovery): prove multi-source agent runs"`.

## Task 12: Run the production acceptance gate

**Files:**
- Modify: `crates/buzz-db/src/migration.rs` to add the populated 0038 upgrade
  regression.
- Modify: `docs/superpowers/specs/2026-08-03-colony-discovery-brave-exa-design.md`
  only to append measured evidence without changing approved behavior.

- [x] Scan tracked changes and test artifacts for secret fixtures; require zero
  occurrences outside the test declarations that construct them.
- [x] Run migration tests from an empty database and from a schema at migration
  0038 with representative legacy Outscraper Campaign/run/Lead rows.
- [x] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-core discovery
cargo test -p buzz-sdk discovery
cargo test -p buzz-db discovery --no-fail-fast
cargo test -p buzz-relay discovery --no-fail-fast
cargo test -p buzz-cli discovery
cargo test --manifest-path desktop/src-tauri/Cargo.toml discovery_
cd desktop && pnpm lint && pnpm typecheck
cd .. && just test
just ci
```

- [x] Run `git diff --check`, confirm no other worktree changed, and record exact
  commands, result counts, screenshots, and any baseline failures separately.
- [x] Do not call real Brave or Exa yet. Obtain explicit approval and strict
  result caps before separate paid smoke calls; report that proof independently.
- [x] Commit final evidence with
  `git commit -s -m "docs(discovery): record multi-source proof"`.

## Delivery boundary

Passing this plan proves the branch locally. Merging to `develop`, promoting to
`main`, publishing a desktop release, and proving real customer-owned Brave and
Exa accounts are later, separately verified states.
