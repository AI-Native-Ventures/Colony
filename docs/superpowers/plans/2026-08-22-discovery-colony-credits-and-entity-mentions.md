# Discovery Colony Credits and Entity Mentions Implementation Plan

> **For Rivet:** Execute this plan task by task. Keep red, green, exact-head,
> merge, production, and installed-app proof as separate gates.

**Goal:** Ship Colony-funded light Business Discovery at 5 cents per retained
Lead, protected by a human-approved Campaign budget, then add permission-checked
Discovery entity mentions and agent context.

**Architecture:** The relay owns money, provider secrets, provider plans, and
entity authorization. The existing desktop worker keeps lease supervision,
normalization, retry, and durable outbox responsibilities, but calls a bounded
Colony provider gateway instead of provider hosts. Messages store stable
Discovery references and the receiving agent resolves current context with its
own workspace permissions.

**Tech stack:** Rust, Axum, SQLx/PostgreSQL, Nostr and NIP-98, Tauri, React,
TypeScript, node:test, Playwright.

**Approved specification:**
`docs/superpowers/specs/2026-08-22-discovery-colony-credits-and-entity-mentions-design.md`

## Delivery shape

Use two PRs so the money and provider boundary can be reviewed independently
from the composer and agent-prompt boundary.

1. `feat/discovery-colony-credits`: Campaign budget, fixed retained-Lead
   settlement, hosted provider gateway, local worker migration, light-only UI,
   and removal of user provider controls.
2. `feat/discovery-entity-mentions`: canonical taxonomy reads, universal
   Discovery entity search and references, and permission-checked ACP context.

Both PRs target `develop`. Production promotion happens once both merged heads
are jointly green on current `develop`.

## Non-negotiable invariants

- Customer price is exactly `50_000_000` nanoUSD per newly retained unique Lead.
- Campaign and account capacity are reserved before provider spend.
- One run produces at most one ledger debit under
  `discovery:run:<run-id>`.
- Duplicates, empty results, failed requests, and replay do not create extra
  customer charges.
- Provider keys, arbitrary URLs, authorization headers, and raw provider bodies
  never cross the desktop boundary.
- Old workers cannot claim or spend from hosted-gateway runs.
- No deep enrichment request, field, stage, action, or UI remains.
- Discovery message tags contain references only. Current context is resolved
  under the receiving agent's permission.
- No PR merges with a red or pending check, behind `origin/develop`, or without
  package-level local proof on the exact head.

## PR 1: Colony-funded light Discovery

### Task 1: Add the database shape and migration proof

**Files:**

- Create: `migrations/0062_discovery_colony_credits.sql`
- Modify: `crates/buzz-db/src/migration.rs`
- Test: `crates/buzz-db/src/migration.rs`

**Step 1: Write failing migration assertions**

Add assertions that migration 0061 exists and contains:

- Campaign payer, approved, spent, reserved, state, fingerprint, and approval
  evidence columns;
- run protocol, unit price, capacity, reservation, settlement, quantity,
  reference, and settled timestamp columns;
- nullable `credit_ledger` service, quantity, unit price, Campaign ID, and run ID
  attribution; and
- constraints that prevent negative money, reservation above approval, invalid
  budget states, or partial Discovery attribution.

Run the full package:

```bash
. ./bin/activate-hermit
cargo test -p buzz-db
```

Expected: fail because migration 0061 and its schema assertions do not exist.

**Step 2: Write the migration**

Use `BIGINT` for all nanoUSD values and counts that participate in arithmetic.
Backfill existing model debits to `service = 'model'`; leave seeds, credits, and
corrections null. Existing Campaigns remain `unapproved`. Existing runs remain
on their released protocol and have no reservation or settlement attribution.

Do not create a second account, ledger, or public table.

**Step 3: Prove forward migration and schema constraints**

Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-db
```

Expected: all `buzz-db` tests pass, including migrations from the current
schema and a populated pre-0061 fixture.

**Step 4: Commit**

```bash
git add migrations/0062_discovery_colony_credits.sql crates/buzz-db/src/migration.rs
git commit -m "feat(discovery): add Campaign budget schema" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 2: Define strict budget and settlement contracts

**Files:**

- Modify: `crates/buzz-core/src/discovery.rs`
- Modify: `crates/buzz-core/src/discovery_workspace.rs`
- Modify: `crates/buzz-core/src/discovery_worker.rs`
- Test: the `#[cfg(test)]` modules in those files

**Step 1: Add failing contract tests**

Cover:

- `50_000_000` nanoUSD launch price;
- budget states and bounded integer-string JSON amounts;
- approved Campaign fingerprint inputs;
- budget approve, pause, revoke, status, and run-start request variants;
- run projections with reserved, settled, released, quantity, and unit price;
- worker protocol version 3 for hosted-gateway runs;
- rejection of zero, negative, overflowed, inconsistent, or unknown fields; and
- released v1 and v2 payload compatibility.

Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-core
```

Expected: fail until the new types and validation exist.

**Step 2: Implement the types and validation**

Keep money serialized as decimal strings at JSON boundaries. Keep all internal
math checked and integer-only. The fingerprint builder must use one versioned
canonical encoding and include every approved targeting and payer field.

Remove source configuration from the new Campaign input version. Preserve a
strict parser for old input only for rolling compatibility.

**Step 3: Run the full package and commit**

```bash
. ./bin/activate-hermit
cargo test -p buzz-core
git add crates/buzz-core/src/discovery.rs \
  crates/buzz-core/src/discovery_workspace.rs \
  crates/buzz-core/src/discovery_worker.rs
git commit -m "feat(discovery): define budget and billing contracts" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 3: Implement atomic reservation and settlement

**Files:**

- Modify: `crates/buzz-db/src/discovery.rs`
- Modify: `crates/buzz-db/src/discovery_workspace.rs`
- Modify: `crates/buzz-db/src/gateway.rs`
- Test: `crates/buzz-db/src/discovery.rs`
- Test: `crates/buzz-db/src/discovery_workspace.rs`

**Step 1: Write failing real-Postgres tests**

Add ignored tests using the existing isolated database harness for:

1. human approval binds payer, fingerprint, price, and maximum;
2. an agent cannot approve or increase a budget;
3. two concurrent Campaign starts for the same payer cannot over-reserve the
   account;
4. Campaign remaining budget and account available balance both cap run Lead
   capacity;
5. one inserted observation settles one 50,000,000 nanoUSD debit;
6. multiple retained observations settle one aggregate run debit with quantity
   and unit price attribution;
7. duplicates, empty results, and failed provider requests settle zero;
8. settlement replay and lost acknowledgment return the original ledger row;
9. cancel and fail settle only observations durably retained before terminal;
10. a retry charges only newly inserted community-unique observations;
11. pause, revoke, target mutation, and fingerprint mismatch reject new spend;
12. stale claims cannot store or settle; and
13. recovery after Lead storage but before terminal settlement produces one
    debit and releases the reservation.

Run the full package plus its ignored database suite against an isolated test
database. Use the repository harness ports and a uniquely validated database
name.

Expected: the new tests fail before implementation.

**Step 2: Implement one transactional authority**

Add DB methods that lock the payer account, Campaign, and run in a consistent
order. Admission must sum active Discovery reservations for the payer across
communities before creating the run. Settlement must derive billable quantity
from inserted observations for the exact run, never from a client count.

The settlement transaction inserts the unique ledger reference, updates the
account balance, moves Campaign reserved to spent, snapshots the run charge,
and releases the reservation together.

**Step 3: Run full package proof**

```bash
. ./bin/activate-hermit
cargo test -p buzz-db
```

Then run the ignored database suite with `BUZZ_TEST_DATABASE_URL` and
`--test-threads=1`.

Expected: all package and new fault tests pass.

**Step 4: Commit**

```bash
git add crates/buzz-db/src/discovery.rs \
  crates/buzz-db/src/discovery_workspace.rs crates/buzz-db/src/gateway.rs
git commit -m "feat(discovery): reserve and settle Campaign credits" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 4: Wire signed workspace actions, receipts, SDK, and CLI

**Files:**

- Modify: `crates/buzz-sdk/src/discovery_workspace.rs`
- Modify: `crates/buzz-relay/src/handlers/ingest.rs`
- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/commands/discovery.rs`
- Test: the test modules in each modified file
- Test: `crates/buzz-test-client/tests/e2e_discovery.rs`

**Step 1: Add failing package and real-relay cases**

Cover:

- a human can approve, pause, revoke, and read a budget;
- an agent can create and read Campaigns but cannot approve a budget;
- an agent may submit one unused, unexpired human `approval` Block action as
  evidence for the exact Campaign budget;
- modified Block content, wrong author, wrong community, expired approval,
  replay for another Campaign, and agent-authored approval are rejected;
- run start returns structured `budget_unapproved`, `budget_exhausted`,
  `balance_depleted`, and `desktop_upgrade_required` outcomes;
- CLI source flags disappear from normal help and new Campaigns omit source
  selection; and
- released workspace payloads still round-trip.

Run full packages:

```bash
. ./bin/activate-hermit
cargo test -p buzz-sdk
cargo test -p buzz-relay
cargo test -p buzz-cli
```

Expected: fail until the new operations are wired.

**Step 2: Implement broker and CLI flow**

The relay verifies the signed approval action and referenced Block instance
from stored events. The CLI prints decimal-string nanoUSD plus a human dollar
display, never floating-point values used for decisions.

Add commands for Campaign budget request data, approval evidence submission,
status, pause, and revoke. The budget request helper must output the exact data
for the core `approval` Block without publishing or spending by itself.

**Step 3: Run package and real-relay proof**

Run the three full packages above, then the full
`crates/buzz-test-client/tests/e2e_discovery.rs` ignored test binary against an
isolated relay.

**Step 4: Commit**

```bash
git add crates/buzz-sdk/src/discovery_workspace.rs \
  crates/buzz-relay/src/handlers/ingest.rs crates/buzz-cli/src/lib.rs \
  crates/buzz-cli/src/commands/discovery.rs \
  crates/buzz-test-client/tests/e2e_discovery.rs
git commit -m "feat(discovery): expose approved Campaign budgets" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 5: Add the bounded Colony provider gateway

**Files:**

- Create: `crates/buzz-relay/src/discovery_gateway.rs`
- Create: `crates/buzz-relay/src/discovery_gateway_tests.rs`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-relay/src/config.rs`
- Modify: `crates/buzz-relay/src/gateway/mod.rs`
- Modify: `crates/buzz-relay/src/state.rs`
- Modify: `deploy/fly/fly.toml`

**Step 1: Write failing relay package tests**

Use loopback provider fixtures, never paid provider endpoints. Cover:

- required Outscraper, Brave, and Exa server secrets are absent from response,
  logs, errors, and debug output;
- startup refuses enabled hosted mode with a missing required key, invalid price,
  duplicate source, unsupported source, or empty source plan;
- NIP-98 is host-bound, body-bound, fresh, replay-protected, and signed by the
  active human worker identity;
- agent, outsider, wrong community, wrong payer, stale claim, expired lease,
  revoked budget, zero capacity, unplanned source, modified query, client cursor,
  arbitrary host, and arbitrary header requests are rejected before upstream;
- the same deterministic provider fingerprint returns the same provider request
  instead of submitting twice;
- the server derives query and cursor from the run snapshot and checkpoint;
- filtered responses contain only the light-profile allowlist; and
- provider errors map to safe existing failure classes.

Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-relay
```

Expected: fail because the gateway module and routes do not exist.

**Step 2: Implement provider-specific routes**

Keep request and response types private and bounded. Reuse the existing gateway
NIP-98 verifier and replay guard. Use relay-owned reqwest clients with explicit
timeouts and body-size limits. Do not accept provider URLs, credentials,
headers, or raw JSON passthrough from the desktop.

The default server source plan is Google Maps, Brave Search, then Exa Search in
waterfall order. Snapshot it on run creation.

**Step 3: Run full relay package and commit**

```bash
. ./bin/activate-hermit
cargo test -p buzz-relay
git add crates/buzz-relay/src/discovery_gateway.rs \
  crates/buzz-relay/src/discovery_gateway_tests.rs crates/buzz-relay/src/lib.rs \
  crates/buzz-relay/src/config.rs crates/buzz-relay/src/gateway/mod.rs \
  crates/buzz-relay/src/state.rs deploy/fly/fly.toml
git commit -m "feat(discovery): proxy bounded provider operations" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 6: Move the desktop worker to hosted provider calls

**Files:**

- Create: `desktop/src-tauri/src/discovery_worker/hosted_gateway.rs`
- Create: `desktop/src-tauri/src/discovery_worker/hosted_gateway_tests.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/mod.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/provider_context.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/source_executor.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/source_executor_outscraper.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/protocol.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host_integration_tests.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host_multi_source_tests.rs`
- Modify: `desktop/src-tauri/src/discovery_worker/worker_host_outbox_tests.rs`

**Step 1: Add failing full Tauri package tests**

Cover:

- production worker protocol 3 never loads a local provider credential;
- every hosted request carries current human NIP-98 auth, run, claim, source,
  and deterministic request fingerprint;
- restart after provider submission reuses the same hosted request;
- lost lease cancels further gateway requests;
- worker outbox recovery stores observations and settles once;
- closing the host pauses work without claiming cloud continuation;
- direct provider hosts are absent from protocol 3 requests; and
- a fixture secret appears zero times in IPC, outbox, logs, relay events, and
  serialized test artifacts.

Run the full native package:

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml
```

Expected: fail until hosted clients replace credential-backed production
clients.

**Step 2: Implement the hosted client boundary**

Reuse `build_nip98_auth_header_for_keys` and relay base URL helpers. The worker
keeps normalizers and source coordinators but swaps provider transport for the
new gateway. Protocol 1 and 2 compatibility remains read-only for already
leased old runs; new runs use protocol 3.

**Step 3: Run the full native package and commit**

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml
git add desktop/src-tauri/src/discovery_worker
git commit -m "feat(discovery): use Colony-hosted provider keys" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 7: Replace source and credential UI with budget UI

**Files:**

- Modify: `desktop/src/features/discovery/data/DiscoveryDataSource.ts`
- Modify: `desktop/src/features/discovery/data/RelayDiscoveryDataSource.ts`
- Modify: `desktop/src/features/discovery/data/relayDiscoveryModels.ts`
- Modify: `desktop/src/features/discovery/types.ts`
- Modify: `desktop/src/features/discovery/ui/CreateCampaignSheet.tsx`
- Modify: `desktop/src/features/discovery/ui/CampaignDetailView.tsx`
- Modify: `desktop/src/features/discovery/ui/DiscoveryRunTab.tsx`
- Create: `desktop/src/features/discovery/ui/CampaignBudgetCard.tsx`
- Delete: `desktop/src/features/discovery/ui/SourceConfigEditor.tsx`
- Modify: `desktop/src/features/settings/ui/SettingsPanels.tsx`
- Delete: `desktop/src/features/settings/ui/DiscoverySettingsCard.tsx`
- Delete: `desktop/src/features/settings/ui/discoverySettings.test.mjs`
- Delete: `desktop/src/shared/api/discoveryCredentials.ts`
- Delete: `desktop/src/shared/api/discoveryCredentials.test.mjs`
- Modify: `desktop/src-tauri/src/provisioned_credits.rs`
- Modify: `desktop/src-tauri/src/commands/provisioned_credits.rs`
- Modify: `desktop/src-tauri/src/discovery_credentials.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src/testing/e2eBridge.ts`
- Modify: `desktop/src/parity/session/script.ts`
- Modify: `desktop/src/parity/replay.test.mjs`
- Modify: `desktop/src/parity/canonicalizers.ts`
- Modify: `desktop/src/parity/recorder.ts`
- Modify: `desktop/native-inventory.json`
- Test: `desktop/src/features/discovery/data/RelayDiscoveryDataSource.test.mjs`
- Test: `desktop/src/features/discovery/data/discoveryData.test.mjs`
- Test: `desktop/src/features/discovery/ui/discoveryState.test.mjs`
- Test: `desktop/tests/e2e/discovery-settings.spec.ts`
- Test: `desktop/tests/e2e/discovery.spec.ts`

**Step 1: Add failing Desktop package and browser cases**

Cover:

- Campaign creation shows 5 cents per Lead, target, maximum, available balance,
  and explicit approval;
- account responses distinguish total balance, active Discovery reservations,
  and currently available balance using integer-string nanoUSD fields;
- no source choice, source order, provider key field, or direct provider billing
  copy remains;
- Campaign detail shows approved, spent, reserved, remaining, estimated Lead
  capacity, pause, revoke, and request-more-budget states;
- start is disabled with exact unapproved, exhausted, depleted, or unsupported
  desktop copy;
- an offline run says it is waiting for this device;
- provenance remains visible after results;
- the released Tauri command inventory no longer exposes save, status, or delete
  provider credential commands; and
- hosted-mode adoption deletes only the three known legacy Discovery keychain
  entries once, without logging values.

Run:

```bash
pnpm --dir desktop test
pnpm --dir desktop test:e2e:smoke -- --grep "Discovery"
```

Expected: fail before the UI and bridge change.

**Step 2: Implement the customer surface and narrow key purge**

Keep the keychain module only long enough to perform an idempotent one-time
deletion after hosted-mode adoption. Remove save, read-status, and delete IPC
commands. Retain only the narrow legacy purge and its no-secret tests in this
release so an updated installation can complete cleanup after adoption.

Do not add deep enrichment copy or controls. Keep provider provenance read-only.

**Step 3: Run complete Desktop and native packages**

```bash
pnpm --dir desktop test
pnpm --dir desktop typecheck
pnpm --dir desktop check
pnpm --dir desktop build
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml
pnpm --dir desktop test:e2e:smoke -- --grep "Discovery"
```

Expected: all pass.

**Step 4: Commit**

Stage only the named Discovery, Settings, bridge, inventory, and native files.

```bash
git commit -m "feat(discovery): show Campaign credits and remove provider setup" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 8: Prove the paid Discovery vertical slice and open PR 1

**Files:**

- Modify: `crates/buzz-test-client/tests/e2e_discovery.rs`
- Modify: `scripts/discovery-multi-source-proof.sh`
- Create: `scripts/discovery-colony-credits-proof.sh`
- Modify: `docs/nips/NIP-DV.md`

**Step 1: Add fault-injected real-relay proof**

The proof must use loopback provider fixtures and a real isolated relay and
Postgres. It must demonstrate:

- human Campaign approval and agent start;
- provider submission through the hosted gateway with no client key;
- worker restart after provider submission;
- one retained Lead, one 50,000,000 nanoUSD debit, and released reservation;
- duplicate retry with zero new debit;
- stale claim and forged approval rejection;
- budget exhaustion before another provider request; and
- zero secret matches across captured events, logs, database text, and outbox.

**Step 2: Run every affected full package**

```bash
. ./bin/activate-hermit
cargo test -p buzz-core
cargo test -p buzz-sdk
cargo test -p buzz-db
cargo test -p buzz-relay
cargo test -p buzz-cli
cargo test -p buzz-test-client
cargo test --manifest-path desktop/src-tauri/Cargo.toml
pnpm --dir desktop test
pnpm --dir desktop typecheck
pnpm --dir desktop check
pnpm --dir desktop build
pnpm --dir desktop test:e2e:smoke -- --grep "Discovery"
./scripts/discovery-colony-credits-proof.sh
```

Run `git rev-parse HEAD` before and after the gate. They must match.

**Step 3: Clean review**

Check:

```bash
git diff origin/develop...HEAD --check
git status --short
git log -1 --format=full
git diff --name-only -z origin/develop...HEAD | xargs -0 rg -n $'\u2014'
```

Confirm no unrelated files, temporary fixtures, credentials, direct provider
production calls, source controls, or deep enrichment paths remain.

**Step 4: Push and open PR 1**

Use the nocodeafrica token explicitly. Open into `develop` with:

```bash
buzz pr open --channel 0b41ede9-9fb3-4a4d-9566-60c70a0403d2 ...
```

Post the returned `buzz://` link in the originating Product thread. Watch every
check. Do not merge pending or red. Rebase on current `origin/develop`, rerun the
full gate if the head moves, wait for green again, then merge.

## PR 2: Discovery entity mentions and agent context

After PR 1 merges, create a new worktree and branch
`feat/discovery-entity-mentions` from the current `origin/develop`.

### Task 9: Make taxonomy and entity search relay-authoritative

**Files:**

- Create: `assets/discovery/business_taxonomy.json`
- Create: `crates/buzz-core/src/discovery_taxonomy.rs`
- Modify: `crates/buzz-core/src/lib.rs`
- Modify: `crates/buzz-core/src/discovery_workspace.rs`
- Modify: `crates/buzz-db/src/discovery_workspace.rs`
- Modify: `crates/buzz-sdk/src/discovery_workspace.rs`
- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/commands/discovery.rs`
- Modify: `desktop/src/features/discovery/data/businessTaxonomy/index.ts`
- Test: all modified Rust modules
- Test: `desktop/src/features/discovery/data/discoveryData.test.mjs`

**Step 1: Add failing full-package tests**

Cover:

- canonical JSON has the same stable IDs, labels, descriptions, Industry count,
  and Vertical count as the current six TypeScript parts;
- taxonomy search is case-insensitive, bounded, deterministic, and available to
  current members without provider spend;
- entity search returns only the active community's Campaigns, virtual Campaign
  Lead collections, Leads, and runs;
- entity resolution is bounded to 20 refs and Lead collection rows to 25;
- outsider and wrong-community queries reveal no existence; and
- CLI taxonomy and entity commands print stable IDs suitable for mentions.

Run full packages:

```bash
. ./bin/activate-hermit
cargo test -p buzz-core
cargo test -p buzz-db
cargo test -p buzz-sdk
cargo test -p buzz-cli
pnpm --dir desktop test
```

Expected: fail before canonical taxonomy and search operations exist.

**Step 2: Convert the current taxonomy mechanically**

Generate the JSON from the existing TypeScript data once, review the diff, then
make JSON the canonical source for both Rust and Desktop. Add a parity hash test
so future edits cannot drift.

Do not create a taxonomy table or expose a public endpoint.

**Step 3: Implement bounded search and resolution, run packages, commit**

Use the existing signed Discovery workspace action and receipt path. Campaign,
Lead, and run resolution must reuse current authorization, not add a parallel
read path.

```bash
git commit -m "feat(discovery): add canonical entity search" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 10: Add Discovery references to every message composer

**Files:**

- Create: `desktop/src/features/messages/lib/discoveryMentionRefs.ts`
- Create: `desktop/src/features/messages/lib/discoveryMentionRefs.test.mjs`
- Modify: `desktop/src/features/messages/lib/mentionCandidates.ts`
- Modify: `desktop/src/features/messages/lib/mentionCandidates.test.mjs`
- Modify: `desktop/src/features/messages/lib/mentionRanking.ts`
- Modify: `desktop/src/features/messages/lib/mentionRanking.test.mjs`
- Modify: `desktop/src/features/messages/lib/mentionSuggestionMapping.ts`
- Modify: `desktop/src/features/messages/lib/draftMentionRefs.ts`
- Modify: `desktop/src/features/messages/lib/draftMentionRefs.test.mjs`
- Modify: `desktop/src/features/messages/lib/useMentions.ts`
- Modify: `desktop/src/features/messages/ui/MentionAutocomplete.tsx`
- Modify: `desktop/src/features/messages/ui/useMentionSendFlow.helpers.ts`
- Modify: `desktop/src/features/messages/ui/useMentionSendFlow.ts`
- Test: `desktop/src/features/messages/lib/useMentions.test.mjs`
- Test: `desktop/tests/e2e/mentions.spec.ts`

**Step 1: Add failing Desktop and browser cases**

Cover:

- Industry, Vertical, Campaign, Campaign Leads, Lead, and run candidates appear
  in channel, thread, DM, and new-message composers;
- ranking remains people first for exact identity matches and groups Discovery
  types clearly for collisions;
- selecting a Discovery result inserts readable `@Label` plus exactly one
  `["discovery", kind, id, label]` tag;
- Discovery refs add no `p` recipient and trigger no notification;
- drafts persist and reload the structured ref;
- edit, reply, paste, and multiple-ref paths preserve correct ranges;
- cross-community cached candidates disappear on community switch; and
- result lists stay bounded and debounced.

Run:

```bash
pnpm --dir desktop test
pnpm --dir desktop test:e2e:smoke -- --grep "mentions"
```

Expected: fail before the new candidate and tag path exists.

**Step 2: Implement one candidate union and stable draft refs**

Do not convert Discovery refs into actor candidates. Keep recipient delivery and
entity context as separate types end to end.

**Step 3: Run complete Desktop gates and commit**

```bash
pnpm --dir desktop test
pnpm --dir desktop typecheck
pnpm --dir desktop check
pnpm --dir desktop build
pnpm --dir desktop test:e2e:smoke -- --grep "mentions"
git commit -m "feat(messages): mention Discovery entities" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 11: Hydrate current Discovery context for receiving agents

**Files:**

- Create: `crates/buzz-acp/src/discovery_context.rs`
- Modify: `crates/buzz-acp/src/lib.rs`
- Modify: `crates/buzz-acp/src/queue.rs`
- Modify: `crates/buzz-acp/src/relay.rs`
- Test: the test modules in those files
- Modify: `crates/buzz-test-client/tests/e2e_discovery.rs`

**Step 1: Add failing ACP package and real-relay cases**

Cover:

- the raw event remains unchanged while the prompt gains a bounded
  `<discovery-context>` block;
- the receiving agent signs the resolve request with its own identity;
- authorized Industry, Vertical, Campaign, Campaign Leads, Lead, and run refs
  hydrate current projections;
- forged IDs, malformed tags, duplicate refs, wrong community, outsider agent,
  revoked grant, and deleted entity return only `unavailable`;
- at most 20 refs and 25 collection rows enter a prompt;
- labels in the message cannot override resolved IDs or fields;
- a profile change after message send appears current at processing time; and
- no provider key, raw provider body, approval content, or hidden record leaks.

Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-acp
cargo test -p buzz-test-client
```

Expected: fail before the resolver is integrated.

**Step 2: Resolve before prompt formatting**

Parse only the strict Discovery tag shape. Resolve through the signed workspace
read contract with the receiving agent's current community identity. Add the
context beside the existing Buzz event block without modifying message content
or recipient tags.

If resolution fails or times out, deliver the user message with unavailable
context rather than dropping the turn.

**Step 3: Run full packages and commit**

```bash
. ./bin/activate-hermit
cargo test -p buzz-acp
cargo test -p buzz-test-client
git commit -m "feat(agents): hydrate Discovery mention context" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 12: Prove universal mention behavior and open PR 2

**Files:**

- Create: `desktop/tests/e2e/discovery-mentions.spec.ts`
- Create: `scripts/discovery-mentions-proof.sh`
- Modify: `crates/buzz-test-client/tests/e2e_discovery.rs`
- Modify: `docs/nips/NIP-DV.md`

**Step 1: Add end-to-end proof**

Drive a real user message that mentions each Discovery entity type. Prove:

- the signed event contains stable Discovery tags and no extra recipients;
- the receiving agent gets current authorized context;
- a Campaign Leads collection is bounded;
- revoked access becomes unavailable on a later message;
- draft reload preserves every entity ref; and
- the composer works in channel, thread, DM, and new-message surfaces.

**Step 2: Run every affected full package**

```bash
. ./bin/activate-hermit
cargo test -p buzz-core
cargo test -p buzz-sdk
cargo test -p buzz-db
cargo test -p buzz-relay
cargo test -p buzz-cli
cargo test -p buzz-acp
cargo test -p buzz-test-client
pnpm --dir desktop test
pnpm --dir desktop typecheck
pnpm --dir desktop check
pnpm --dir desktop build
pnpm --dir desktop test:e2e:smoke -- --grep "mentions|Discovery"
./scripts/discovery-mentions-proof.sh
```

Confirm `git rev-parse HEAD` is unchanged across the complete gate.

**Step 3: Clean review, push, and open PR 2**

Use the same diff, trailer, no-em-dash, no-secret, current-develop, explicit
nocodeafrica token, `buzz pr open --channel`, CI, rebase, and merge rules from
PR 1.

## Joint production release

### Task 13: Verify current develop before promotion

After both PRs merge:

1. fetch `origin/develop` and record its exact SHA;
2. verify both merge commits are ancestors;
3. wait for every push-triggered check on that exact develop SHA;
4. rerun the paid Discovery and mention proof scripts against the exact merged
   source if CI does not already cover their real-relay shapes; and
5. stop on any red, pending, flaky retry, missing provider secret, or unrelated
   failure.

Do not describe this state as production or live.

### Task 14: Promote, publish, and prove production

Basheer's written authorization in the Product thread covers production for this
specific Discovery change.

1. create the normal release branch from the exact green `origin/develop`;
2. update version and changelog using repository conventions;
3. open the production PR into `main` with the originating Product channel;
4. wait for every production check and rebase if `main` moves;
5. merge only on green;
6. verify the deployed relay health and hosted Discovery configuration without
   printing secrets;
7. wait for desktop publication and updater adoption;
8. install or update the production desktop build;
9. approve a small real Campaign budget;
10. run a real provider-backed Campaign while the desktop is open;
11. verify retained count, exact 5 cent unit price, aggregate debit, released
    reservation, provider provenance, and no deep-enrichment fields;
12. send a production message mentioning the Campaign, Campaign Leads, one Lead,
    and its run;
13. verify the receiving production agent gets current permission-checked
    context; and
14. report the exact release commit, artifact version, installed version, real
    Campaign and run IDs, debit reference, and remaining unproven items.

If real provider credentials are not provisioned in the production relay, stop
before promotion and raise a credential ask containing only the provider names,
never secret values.
