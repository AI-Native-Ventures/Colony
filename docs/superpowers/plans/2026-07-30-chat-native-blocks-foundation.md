# Chat-Native Blocks Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat the operating canvas by letting agents publish safe, versioned, interactive Blocks inside ordinary message threads, with a visible Blocks catalog for discovery and conversational workshop handoff.

**Architecture:** Keep every Block instance as a normal kind `9` message with readable fallback text. Add immutable manifest, replaceable catalog-head, action, and receipt events around that message. The relay validates public envelopes, is the sole signer of the one authoritative catalog head per handle, brokers owner/admin-signed catalog actions, and enforces action idempotency. The SDK and CLI own canonical creation; the desktop resolves and validates manifests, renders a closed native primitive grammar, signs interactions, and overlays receipts. Web and mobile remain fallback-only in this phase.

**Tech Stack:** Rust, Nostr events, Postgres, `jsonschema` 0.49.x (Draft 2020-12), Tauri 2, React 19, TypeScript 6, TanStack Query/Router, Zod 4, Ajv 8.20.x, Tailwind CSS, node:test, Playwright, Flutter widget tests.

---

## Approved scope and non-goals

The source of truth is
`docs/superpowers/specs/2026-07-30-chat-native-blocks-design.md`.

This plan implements:

- kinds `40010`, `40011`, `40012`, and `30178`;
- versioned manifests and catalog heads;
- ordinary kind `9` Block instances with permanent text fallbacks;
- Block actions, receipts, and durable idempotency;
- the eleven native primitives and six starter composites;
- a catalog that returns the user to a conversation rather than becoming a
  workflow UI;
- typed Block references in the existing `@` picker;
- ACP delivery of Block actions to the responsible agent;
- desktop rich rendering and web/mobile fallback preservation;
- mocked renderer proof and real relay/CLI/ACP/desktop proof.

This plan does not implement Company storage, Lead/Client lifecycle, Plugin
credentials, outbound email or WhatsApp, payments, accounting connectors,
arbitrary code-backed Blocks, a marketplace, or a technical rename of Buzz
crate/protocol identifiers.

## Acceptance gates

### Gate A — Protocol is proven

Pass only when canonical manifest/instance/action/receipt vectors round-trip
through core, SDK, relay, and CLI; malformed envelopes are rejected; and two
different signed actions with the same `(community, instance, idempotency_key)`
resolve to one stored action.

### Gate B — Desktop experience is proven

Pass only when every native primitive renders in the real desktop build with
loading, empty, populated, error, disabled, and completed states; unknown or
invalid Blocks show their fallback; keyboard and screen-reader checks pass; and
community switching leaks no manifest, payload, action, or receipt state.

### Gate C — Conversation loop is proven

Pass only when the real relay, CLI, ACP harness, and desktop complete the
eleven-step proof from the design spec, including a restarted desktop rendering
an old pinned manifest, a multi-select Brainstorm submission reaching an agent,
and one Approval result under deliberate double-click/retry.

## Wire contract to pin before UI work

| Event | Kind | Required public tags | Content |
|---|---:|---|---|
| Manifest | `40012` | `["block","1",handle,version]` | Canonical `BlockManifest` JSON |
| Catalog head | `30178` | `["d",handle]`, `["e",manifest_id,"","block-manifest"]`, `["block-state","active"|"deprecated"]` | Canonical `BlockCatalogEntry` JSON; relay-signed only |
| Instance | `9` | normal `h/e/p`, `["e",manifest_id,"","block"]`, `["block","1",handle,manifest_id,instance_id]`, exactly one data tag | Human-readable fallback |
| Action | `40010` | `h`, `p` for responsible agent, instance/manifest `e` tags, `["block-action","1",action_id,instance_id,idempotency_key]` | Canonical action input JSON |
| Receipt | `40011` | `h`, action/instance `e` tags, `["block-receipt","1",instance_id,idempotency_key,status]` | Canonical result JSON |
| Typed Block reference | any conversational kind `9` | `["a","30178:relay_self_pubkey:handle","","block"]` | Ordinary message text containing `@handle` |

Inline instance data uses `["block-data", canonical_json]` and is capped at
32 KiB. Larger data uses
`["block-data-ref", url, mime, sha256, byte_size]`, is capped at 2 MiB, and is
downloaded through a Tauri command that blocks private-network destinations,
checks the declared size, verifies SHA-256, and only then parses JSON.

Handles use `^[a-z][a-z0-9-]{0,63}$`. IDs are lowercase 64-hex event IDs except
`instance_id` and `idempotency_key`, which are UUIDs. Only JSON Schema Draft
2020-12 is accepted, and external `$ref` values are rejected so validation
never performs network I/O.

### Catalog authority and activation

There is exactly one authoritative catalog coordinate per community and handle:
`30178:<relay-self-pubkey>:<handle>`. The relay is the only catalog-head signer,
so different manifest publishers cannot create competing “active” versions.

Draft manifests may be signed by agents, users, or installed publishers.
Activation, rollback, and deprecation are reserved Block actions
(`catalog.activate`, `catalog.rollback`, `catalog.deprecate`) signed by a human
community owner/admin and `p`-tagged to relay self. The relay's core Block
broker verifies role, manifest signature/handle/test evidence, action expiry,
and idempotency, then atomically moves the relay-signed head and emits a
relay-signed receipt. Agents can create and test drafts but cannot activate
them. The catalog page remains read-only; the user grants the catalog action in
the workshop conversation or runs the equivalent CLI command with a human key.

## File map

### Shared Rust contract

- Modify `Cargo.toml`
- Modify `crates/buzz-core/Cargo.toml`
- Modify `crates/buzz-core/src/lib.rs`
- Modify `crates/buzz-core/src/kind.rs`
- Create `crates/buzz-core/src/block.rs`
- Modify `crates/buzz-sdk/src/lib.rs`
- Create `crates/buzz-sdk/src/blocks.rs`

### Relay, persistence, bundled manifests, and agent delivery

- Create `migrations/0027_block_action_claims.sql`
- Modify `crates/buzz-db/src/lib.rs`
- Modify `crates/buzz-db/src/event.rs`
- Create `crates/buzz-relay/src/blocks.rs`
- Create `crates/buzz-relay/src/core_blocks.rs`
- Create `crates/buzz-relay/src/block_broker.rs`
- Create `crates/buzz-relay/src/core_blocks/primitives/*.json`
- Create `crates/buzz-relay/src/core_blocks/composites/*.json`
- Modify `crates/buzz-relay/src/lib.rs`
- Modify `crates/buzz-relay/src/main.rs`
- Modify `crates/buzz-relay/src/handlers/ingest.rs`
- Modify `crates/buzz-relay/src/handlers/community_provisioning.rs`
- Modify `crates/buzz-acp/src/config.rs`
- Modify `crates/buzz-acp/src/setup_mode.rs`
- Modify `crates/buzz-acp/src/queue.rs`

### Agent-first CLI

- Modify `crates/buzz-cli/src/lib.rs`
- Modify `crates/buzz-cli/src/commands/mod.rs`
- Create `crates/buzz-cli/src/commands/blocks.rs`
- Modify `crates/buzz-cli/TESTING.md`

### Desktop protocol and safe data loading

- Modify `desktop/package.json`
- Modify `pnpm-lock.yaml`
- Modify `desktop/src/shared/constants/kinds.ts`
- Create `desktop/src/features/blocks/contracts.ts`
- Create `desktop/src/features/blocks/blockTags.ts`
- Create `desktop/src/features/blocks/blockValidation.ts`
- Create `desktop/src/features/blocks/blockRepository.ts`
- Create `desktop/src/features/blocks/blockData.ts`
- Create `desktop/src/features/blocks/hooks.ts`
- Create `desktop/src-tauri/src/commands/block_data.rs`
- Modify `desktop/src-tauri/src/commands/mod.rs`
- Modify `desktop/src-tauri/src/lib.rs`
- Create `desktop/src/shared/api/blockData.ts`
- Modify `desktop/src/features/communities/useCommunityInit.ts`

### Desktop inline rendering and interaction

- Create `desktop/src/features/blocks/ui/BlockMessage.tsx`
- Create `desktop/src/features/blocks/ui/BlockFallback.tsx`
- Create `desktop/src/features/blocks/ui/BlockRenderer.tsx`
- Create `desktop/src/features/blocks/ui/BlockRenderContext.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockLayout.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockSection.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockMetric.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockDetails.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockStatus.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockActions.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockTable.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockCard.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockCardList.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockChart.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockMedia.tsx`
- Create `desktop/src/features/blocks/ui/primitives/BlockQuestion.tsx`
- Create `desktop/src/features/blocks/blockActions.ts`
- Create `desktop/src/features/blocks/blockActionQueue.ts`
- Modify `desktop/src/features/messages/types.ts`
- Modify `desktop/src/features/messages/lib/formatTimelineMessages.ts`
- Modify `desktop/src/features/messages/ui/MessageRow.tsx`
- Modify `desktop/src/features/messages/hooks.ts`
- Modify `desktop/src/features/messages/lib/imetaMediaMarkdown.ts`
- Modify `desktop/src/shared/api/relayClientSession.ts`
- Modify `desktop/src-tauri/src/events.rs`
- Modify `desktop/src-tauri/src/commands/messages.rs`

### Catalog, workshop handoff, and typed references

- Create `desktop/src/app/routes/blocks.tsx`
- Create `desktop/src/app/routes/BlocksRouteScreen.tsx`
- Modify `desktop/src/app/routes.ts`
- Regenerate `desktop/src/app/routeTree.gen.ts`
- Modify `desktop/src/app/AppShell.helpers.ts`
- Modify `desktop/src/app/navigation/useAppNavigation.ts`
- Modify `desktop/src/app/AppShell.tsx`
- Modify `desktop/src/features/sidebar/ui/AppSidebar.tsx`
- Modify `desktop/src/features/sidebar/ui/AppSidebarPinnedHeader.tsx`
- Create `desktop/src/features/blocks/ui/BlocksCatalogScreen.tsx`
- Create `desktop/src/features/blocks/ui/BlockCatalogCard.tsx`
- Modify `desktop/src/app/routes/messages.new.tsx`
- Modify `desktop/src/features/messages/ui/NewMessageScreen.tsx`
- Modify `desktop/src/features/messages/lib/mentionCandidates.ts`
- Modify `desktop/src/features/messages/lib/mentionSuggestionMapping.ts`
- Modify `desktop/src/features/messages/lib/useMentions.ts`
- Modify `desktop/src/features/messages/ui/MentionAutocomplete.tsx`
- Modify `desktop/src/features/messages/ui/useMentionSendFlow.ts`

### Cross-client fallback and proof

- Modify `mobile/test/features/channels/message_content_test.dart`
- Modify `mobile/test/shared/relay/nostr_models_test.dart`
- Create `desktop/tests/e2e/blocks.spec.ts`
- Create `desktop/tests/e2e/blocks-faults.spec.ts`
- Create `desktop/tests/e2e/blocks-live.spec.ts`
- Modify `desktop/playwright.config.ts`
- Modify `desktop/src/testing/e2eBridge.ts`
- Create `scripts/prove-blocks.sh`
- Create `docs/testing/BLOCKS_E2E.md`

## Task 1: Pin Block kinds, canonical models, and validation

**Files:**

- Modify: `Cargo.toml`
- Modify: `crates/buzz-core/Cargo.toml`
- Modify: `crates/buzz-core/src/lib.rs`
- Modify: `crates/buzz-core/src/kind.rs`
- Create: `crates/buzz-core/src/block.rs`

- [ ] Add failing kind-registry tests asserting the four exact values are in
  `ALL_KINDS`, `30178` is parameterized replaceable, and the three `400xx`
  kinds are immutable.

```rust
assert_eq!(KIND_BLOCK_ACTION, 40010);
assert_eq!(KIND_BLOCK_RECEIPT, 40011);
assert_eq!(KIND_BLOCK_MANIFEST, 40012);
assert_eq!(KIND_BLOCK_CATALOG_ENTRY, 30178);
assert!(is_parameterized_replaceable(KIND_BLOCK_CATALOG_ENTRY));
```

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-core kind::tests::block_kinds
```

Expected: fail because the constants do not exist.

- [ ] Add `jsonschema = "0.49.2"` and `semver = { version = "1", features =
  ["serde"] }` to workspace dependencies and `buzz-core`.

- [ ] Define the contract in `block.rs`. Use a closed tagged enum, never
  arbitrary HTML/CSS/JS:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BlockNode {
    Stack { gap: BlockGap, children: Vec<BlockNode> },
    Grid { columns: u8, gap: BlockGap, children: Vec<BlockNode> },
    Section(SectionNode),
    Metric(MetricNode),
    Details(DetailsNode),
    Table(TableNode),
    Card(CardNode),
    CardList(CardListNode),
    Chart(ChartNode),
    Media(MediaNode),
    Status(StatusNode),
    Actions(ActionsNode),
    Question(QuestionNode),
}
```

`BlockManifest` must contain `schema`, `handle`, `version`, `name`,
`description`, `origin`, `input_schema`, `tree`, `actions`, `permissions`,
`fallback_template`, `supported_clients`, `primitive_versions`, `examples`,
and `validation`. `BlockCatalogEntry` must contain `schema`, `handle`,
`active_manifest_id`, `status`, `summary`, `origin`, `preview`, `permissions`,
and optional `workshop`.

- [ ] Implement and test these public functions:

```rust
pub fn normalize_block_handle(raw: &str) -> Result<String, BlockError>;
pub fn canonical_json(value: &serde_json::Value) -> Result<String, BlockError>;
pub fn parse_manifest(content: &str) -> Result<BlockManifest, BlockError>;
pub fn validate_manifest(manifest: &BlockManifest) -> Result<(), BlockError>;
pub fn validate_instance(schema: &Value, data: &Value) -> Result<(), BlockError>;
pub fn compute_approval_hash(proposal: &ApprovalProposal) -> Result<String, BlockError>;
```

Tests must reject duplicate action IDs, unknown primitive versions, more than
12 nesting levels, more than 200 nodes, remote `$ref`, non-HTTP(S) media URLs,
credential-looking permission payload fields, invalid examples, an Approval
without exact destination/content/expiry, and a Question whose selection
bounds are impossible.

The primitive manifest handles are exactly `@section`, `@metric`, `@details`,
`@table`, `@card`, `@card-list`, `@chart`, `@media`, `@status`, `@actions`, and
`@question`. The starter composite handles are exactly `@lead-card`,
`@approval`, `@report`, `@artifact`, `@receipt`, and `@brainstorm`.

- [ ] Add golden vectors in the test module for canonical key ordering,
Question single-select/multi-select/custom input, and Approval hash stability.

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-core block
cargo test -p buzz-core kind::tests::block_kinds
```

Expected: all Block contract tests pass.

- [ ] Commit:

```bash
git add Cargo.toml Cargo.lock crates/buzz-core
git commit -s -m "feat(blocks): define block protocol contracts"
```

## Task 2: Build typed SDK event constructors

**Files:**

- Create: `crates/buzz-sdk/src/blocks.rs`
- Modify: `crates/buzz-sdk/src/lib.rs`

- [ ] Write failing tests for exact tags and canonical content for a manifest,
  catalog head, inline instance, external-data instance, action, receipt, and
  typed Block reference.

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-sdk blocks
```

Expected: fail because `buzz_sdk::blocks` does not exist.

- [ ] Implement these builders:

```rust
pub fn build_block_manifest(manifest: &BlockManifest) -> Result<EventBuilder, SdkError>;
pub fn build_block_catalog_entry(entry: &BlockCatalogEntry) -> Result<EventBuilder, SdkError>;
pub fn build_block_instance(input: &BlockInstanceInput) -> Result<EventBuilder, SdkError>;
pub fn build_block_action(input: &BlockActionInput) -> Result<EventBuilder, SdkError>;
pub fn build_block_receipt(input: &BlockReceiptInput) -> Result<EventBuilder, SdkError>;
pub fn block_reference_tag(publisher: &PublicKey, handle: &str) -> Result<Tag, SdkError>;
```

`build_block_instance` must call `validate_instance` before emitting, require
non-empty fallback text, emit only one data source, and require `p` for the
responsible agent when the manifest declares actions. `build_block_action`
must derive a UUID idempotency key when none is supplied and return it to the
caller with the builder.

- [ ] Add a property-style loop over 100 differently ordered JSON objects and
  assert they produce identical canonical content and event tags.

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-sdk blocks
cargo test -p buzz-sdk
```

Expected: all SDK tests pass.

- [ ] Commit:

```bash
git add crates/buzz-sdk
git commit -s -m "feat(blocks): add typed event builders"
```

## Task 3: Validate and persist Block events with durable idempotency

**Files:**

- Create: `migrations/0027_block_action_claims.sql`
- Modify: `crates/buzz-db/src/lib.rs`
- Modify: `crates/buzz-db/src/event.rs`
- Create: `crates/buzz-relay/src/blocks.rs`
- Create: `crates/buzz-relay/src/block_broker.rs`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-relay/src/handlers/ingest.rs`

- [ ] Add failing migration and DB integration tests for two separately signed
  actions sharing one idempotency key.

The table contract is:

```sql
CREATE TABLE block_action_claims (
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    instance_event_id BYTEA NOT NULL CHECK (octet_length(instance_event_id) = 32),
    idempotency_key UUID NOT NULL,
    action_event_id BYTEA NOT NULL CHECK (octet_length(action_event_id) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, instance_event_id, idempotency_key)
);
```

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-db block_action
```

Expected: fail because the migration/API does not exist.

- [ ] Refactor the existing event insertion internals just enough to expose one
  transaction-scoped helper, then implement:

```rust
pub enum BlockActionInsert {
    Inserted(StoredEvent),
    Duplicate { original_event_id: Vec<u8> },
}

pub async fn insert_block_action_once(
    &self,
    community: CommunityId,
    event: &Event,
    channel_id: Uuid,
    instance_event_id: &[u8],
    idempotency_key: Uuid,
) -> Result<BlockActionInsert>;
```

The claim and event insertion must commit in the same transaction. Losing the
claim returns the original action event ID and must not insert, fan out, or
trigger ACP a second time.

- [ ] In `relay/src/blocks.rs`, implement public-envelope validators for all
  five shapes (including kind `9` with a `block` tag). Validators must enforce
  exact cardinality, lowercase hex, UUID syntax, size limits, HTTP(S), MIME
  `application/json`, SHA-256 shape, declared action IDs, and catalog target
  state. They must never fetch external data.

- [ ] Update kind authorization:

  - manifest: `UsersWrite`;
  - action and receipt: `MessagesWrite`.

Add catalog to `is_relay_only_kind`; add manifest/catalog to
`is_global_only_kind`; add action/receipt to `requires_h_channel_scope`; and
add all four to `ALL_KINDS`. Client submission of kind `30178` must fail even
for owners.

- [ ] Implement the core catalog broker in `block_broker.rs`. After a reserved
  catalog action wins the durable idempotency claim, require a human
  owner/admin signer, fetch and validate the target manifest, sign the new
  `30178:<relay-self>:<handle>` head with `state.relay_keypair`, persist it with
  NIP-33 replacement, and publish a relay-signed receipt. General actions
  continue through normal fan-out to ACP.

- [ ] Add relay tests that reject missing `h`, duplicate data tags, bad markers,
  oversized inline JSON, a client-authored catalog head, a catalog action
  pointing at an untested manifest, a non-owner catalog action, a receipt with
  no action reference, and an action ID absent from the manifest.

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-db block_action
cargo test -p buzz-relay blocks
cargo test -p buzz-relay handlers::ingest
```

Expected: all tests pass, including the cross-community idempotency test
showing the same key is independent in two communities.

- [ ] Commit:

```bash
git add migrations/0027_block_action_claims.sql crates/buzz-db crates/buzz-relay
git commit -s -m "feat(blocks): validate events and enforce action idempotency"
```

## Task 4: Bundle and seed the native catalog

**Files:**

- Create: `crates/buzz-relay/src/core_blocks.rs`
- Create: `crates/buzz-relay/src/core_blocks/primitives/section.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/metric.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/details.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/table.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/card.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/card-list.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/chart.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/media.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/status.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/actions.json`
- Create: `crates/buzz-relay/src/core_blocks/primitives/question.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/lead-card.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/approval.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/report.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/artifact.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/receipt.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/brainstorm.json`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-relay/src/main.rs`
- Modify: `crates/buzz-relay/src/handlers/community_provisioning.rs`
- Modify: `crates/buzz-db/src/lib.rs`

- [ ] Write failing tests that load all seventeen JSON assets, validate every
  example, assert the handles are unique, prove each primitive asset has its
  matching root node, and prove `brainstorm` contains a multi-select Question
  with optional custom input.

- [ ] Implement:

```rust
pub fn core_block_manifests() -> Result<Vec<BlockManifest>, BlockError>;
pub async fn ensure_core_blocks(state: &AppState, community: CommunityId) -> anyhow::Result<usize>;
pub async fn ensure_core_blocks_for_all_communities(state: &AppState) -> anyhow::Result<usize>;
```

The relay signs manifests and heads with `state.relay_keypair`; desktop trust
therefore binds core Blocks to the active relay's NIP-11 `self`. Use fixed
per-version `created_at` values from the assets so restart and multi-pod
seeding generate the same signed IDs. Insert with normal
immutable/parameterized semantics and never overwrite a newer relay-signed
head selected through the catalog broker.

- [ ] Call the all-community function before opening the listener and the
  one-community function after successful provisioning. A seeding failure is
  loud and non-fatal for existing communities; provisioning must return an
  explicit warning field if its seed fails.

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-relay core_blocks
```

Expected: seventeen valid manifests and seventeen catalog heads; a second seed
inserts zero; a newer broker-selected head remains untouched.

- [ ] Commit:

```bash
git add crates/buzz-relay crates/buzz-db
git commit -s -m "feat(blocks): seed native composite catalog"
```

## Task 5: Add the complete agent-first CLI surface

**Files:**

- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/commands/mod.rs`
- Create: `crates/buzz-cli/src/commands/blocks.rs`
- Modify: `crates/buzz-cli/TESTING.md`

- [ ] Add clap parsing tests for this exact surface:

```text
buzz blocks list
buzz blocks get --handle lead-card [--author <pubkey>]
buzz blocks draft --manifest manifest.json
buzz blocks test --manifest manifest.json [--data data.json]
buzz blocks activate --handle lead-card --manifest <event-id>
buzz blocks rollback --handle lead-card --manifest <event-id>
buzz blocks deprecate --handle lead-card --manifest <event-id>
buzz blocks invoke --channel <uuid> --handle lead-card --data data.json --fallback fallback.md [--manifest <event-id>] [--reply-to <event-id>]
buzz blocks actions --channel <uuid> [--instance <event-id>] [--since <unix>]
buzz blocks act --channel <uuid> --instance <event-id> --action submit --input input.json [--idempotency-key <uuid>]
buzz blocks receipt --channel <uuid> --action <event-id> --instance <event-id> --status succeeded --result result.json
```

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-cli blocks
```

Expected: fail because `BlocksCmd` does not exist.

- [ ] Implement read paths with explicit kind filters and `#d`/`#e` tags.
  `invoke` without `--manifest` resolves exactly one active head, fetches its
  immutable manifest, validates data, generates fallback from the manifest
  when `--fallback` is omitted, and publishes kind `9`.

- [ ] Make `test` run manifest validation, all examples, fallback generation,
  action schemas, and primitive/client compatibility. Print stable JSON:

```json
{"valid":true,"handle":"lead-card","version":"1.0.0","examples":2,"digest":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}
```

`activate`, `rollback`, and `deprecate` must fetch the target manifest and
refuse manifests without matching handle or `validation.state == "tested"`.
They publish reserved Block actions `p`-tagged to relay self; they never publish
kind `30178` directly. The relay rejects these commands when the CLI signer is
not a human community owner/admin.

- [ ] Make `act` print the idempotency key and action event ID. When the relay
  returns `duplicate:idempotency`, print the original event ID and exit `0`.

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-cli blocks
cargo run -p buzz-cli -- blocks --help
```

Expected: tests pass and help shows every command above.

- [ ] Commit:

```bash
git add crates/buzz-cli
git commit -s -m "feat(blocks): add agent-first block commands"
```

## Task 6: Deliver signed Block actions to ACP agents

**Files:**

- Modify: `crates/buzz-acp/src/config.rs`
- Modify: `crates/buzz-acp/src/setup_mode.rs`
- Modify: `crates/buzz-acp/src/queue.rs`

- [ ] Add failing tests proving default Mention-mode filters subscribe to both
  kind `9` and `KIND_BLOCK_ACTION`, and that an action only matches the agent
  named by its `p` tag.

- [ ] Add `KIND_BLOCK_ACTION` to default and dynamic channel filters, setup-mode
  defaults, and setup listener acceptance. Do not add receipts: agents create
  receipts but do not need every other agent's outcomes.

- [ ] Extend `format_event_block` with a parsed line while keeping the raw tags:

```text
Block action: instance=<event-id> action=submit idempotency=<uuid>
```

Reject malformed Block actions before queueing even if a permissive custom
subscription rule matched them.

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-acp block_action
cargo test -p buzz-acp config
```

Expected: all tests pass and an action is queued once for its responsible
agent.

- [ ] Commit:

```bash
git add crates/buzz-acp
git commit -s -m "feat(blocks): route block actions to agents"
```

### Gate A proof

- [ ] Start Postgres/Redis/relay with the repo's normal development commands.
- [ ] Publish one manifest, activate it, invoke it, submit the same logical
  action twice with different signed events, and query actions.
- [ ] Save the command/output transcript under
  `test-results/blocks/gate-a.txt`.
- [ ] Do not continue until the second submission returns the first action ID,
  exactly one action is stored, and every malformed fixture is rejected.

## Task 7: Mirror contracts in desktop and load data safely

**Files:**

- Modify: `desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `desktop/src/features/blocks/contracts.ts`
- Create: `desktop/src/features/blocks/blockTags.ts`
- Create: `desktop/src/features/blocks/blockValidation.ts`
- Create: `desktop/src/features/blocks/blockRepository.ts`
- Create: `desktop/src/features/blocks/blockData.ts`
- Create: `desktop/src/features/blocks/hooks.ts`
- Create: `desktop/src-tauri/src/commands/block_data.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Create: `desktop/src/shared/api/blockData.ts`
- Modify: `desktop/src/features/communities/useCommunityInit.ts`

- [ ] Add Ajv `^8.20.0`; use Zod for the fixed outer manifest/primitive shape
  and Ajv Draft 2020-12 for each manifest's dynamic input/action schemas.

- [ ] Write failing node tests using the Rust golden vectors. Assert the same
  canonical JSON, handles, primitive discriminators, manifest/data failures,
  approval hash, and tag extraction.

- [ ] Implement strict parsers returning result objects, not thrown render-path
  errors:

```ts
export type BlockParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: BlockFailureCode; message: string };

export function parseBlockInstance(tags: string[][]): BlockParseResult<BlockInstanceRef>;
export function validateBlockManifest(value: unknown): BlockParseResult<BlockManifest>;
export function validateBlockData(manifest: BlockManifest, value: unknown): BlockParseResult<unknown>;
```

- [ ] Implement a community-scoped manifest repository with in-flight request
  coalescing and a maximum of 200 entries. It must verify event ID/signature
  through the already verified `RelayEvent`, compare tag handle/version to
  content, classify relay-self + bundled digest as `core`, classify a human
  owner/admin or that owner's verified managed agent as `workspace-custom`,
  classify only configured publisher keys as `installed`, and otherwise return
  `untrusted`. A relay-signed active catalog head is trust evidence for its
  exact target manifest, not for other versions by the same publisher.

- [ ] Add `resetBlockRepository()` to `resetCommunityState()` in
  `useCommunityInit.ts`.

- [ ] Implement `fetch_block_data` in Tauri. Resolve DNS, reject loopback,
  link-local, private, multicast, and metadata-service destinations before and
  after redirects; stream at most 2 MiB; verify declared size and SHA-256; and
  return UTF-8 JSON bytes. Never attach cookies, auth headers, or Plugin
  credentials.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="block"
pnpm typecheck
```

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml block_data
```

Expected: all contract and safe-fetch tests pass.

- [ ] Commit:

```bash
git add desktop pnpm-lock.yaml
git commit -s -m "feat(blocks): validate manifests and load data safely"
```

## Task 8: Integrate Blocks into the real message timeline

**Files:**

- Modify: `desktop/src/shared/constants/kinds.ts`
- Modify: `desktop/src/features/messages/types.ts`
- Modify: `desktop/src/features/messages/lib/formatTimelineMessages.ts`
- Modify: `desktop/src/features/messages/ui/MessageRow.tsx`
- Create: `desktop/src/features/blocks/ui/BlockMessage.tsx`
- Create: `desktop/src/features/blocks/ui/BlockFallback.tsx`
- Create: `desktop/src/features/blocks/ui/BlockRenderer.tsx`
- Create: `desktop/src/features/blocks/ui/BlockRenderContext.tsx`

- [ ] Add action and receipt kinds to `CHANNEL_AUX_EVENT_KINDS`, not
  `CHANNEL_TIMELINE_CONTENT_KINDS`. Manifest and catalog kinds stay out of
  channel queries.

- [ ] Write failing format tests that attach actions/receipts to their instance
  by `e` markers, choose the newest valid receipt per action, ignore reordered
  foreign receipts, and leave ordinary messages unchanged.

- [ ] Add this timeline field:

```ts
blockState?: {
  actions: RelayEvent[];
  receipts: RelayEvent[];
};
```

- [ ] In `MessageRow.renderBody`, check for a valid kind `9` Block tag before
  Markdown:

```tsx
if (message.kind === KIND_STREAM_MESSAGE && hasBlockInstanceTag(message.tags)) {
  return (
    <React.Suspense fallback={<BlockFallback text={message.body} state="loading" />}>
      <BlockMessage message={message} />
    </React.Suspense>
  );
}
```

The renderer must render nothing partially. Loading, missing, invalid,
untrusted, unsupported, and hash-invalid states all show the original fallback
text and a small explanation. The row remains replyable/reactable.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="block timeline|block fallback"
pnpm typecheck
```

Expected: Block messages take the inline renderer path; ordinary messages'
snapshot output is unchanged.

- [ ] Commit:

```bash
git add desktop/src/features/messages desktop/src/features/blocks desktop/src/shared/constants/kinds.ts
git commit -s -m "feat(blocks): render block instances in chat"
```

## Task 9: Implement layout and information primitives

**Files:**

- Create: `desktop/src/features/blocks/ui/primitives/BlockLayout.tsx`
- Create: `desktop/src/features/blocks/ui/primitives/BlockSection.tsx`
- Create: `desktop/src/features/blocks/ui/primitives/BlockMetric.tsx`
- Create: `desktop/src/features/blocks/ui/primitives/BlockDetails.tsx`
- Create: `desktop/src/features/blocks/ui/primitives/BlockStatus.tsx`
- Create: `desktop/src/features/blocks/ui/primitives/BlockActions.tsx`
- Modify: `desktop/src/features/blocks/ui/BlockRenderer.tsx`

- [ ] Write one node test per primitive resolver and a Playwright component
  fixture covering empty, populated, warning/error, disabled, and completed
  states.

- [ ] Implement Stack/Grid using fixed spacing tokens and responsive
  one-column collapse. Implement Section, Metric, Details, and Status with
  semantic headings, `dl`, `role=status`, and existing `Attachment`, `Card`,
  `Progress`, `Badge`, and `Button` primitives.

- [ ] `BlockActions` may only emit declared Block actions through context. A
  disabled/untrusted renderer must render controls disabled with an accessible
  explanation.

- [ ] Use only stock rem text classes (`text-base`, `text-sm`, `text-xs`,
  `text-2xs`, `text-3xs`); do not add arbitrary text literals.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="block (section|metric|details|status|actions)"
pnpm check:px-text
pnpm typecheck
```

Expected: all primitive tests and text-size guard pass.

- [ ] Commit:

```bash
git add desktop/src/features/blocks
git commit -s -m "feat(blocks): add layout and information primitives"
```

## Task 10: Implement Table, Card, and Card List

**Files:**

- Create: `desktop/src/features/blocks/ui/primitives/BlockTable.tsx`
- Create: `desktop/src/features/blocks/ui/primitives/BlockCard.tsx`
- Create: `desktop/src/features/blocks/ui/primitives/BlockCardList.tsx`
- Modify: `desktop/src/features/blocks/ui/BlockRenderer.tsx`

- [ ] Write failing tests for typed cell formatting, stable sorting, filtering,
  single/multi row selection, declared row actions, empty collections, and Card
  List list/grid/carousel modes.

- [ ] Implement the table with semantic `<table>`, keyboard-sortable headers,
  an explicit accessible caption, bounded client-side filtering, and no
  virtualization until more than 200 rows (the manifest validator already caps
  this release at 200).

- [ ] Build Card on the existing `Attachment` family. Build Card List list/grid
  with CSS and carousel with the existing `shared/ui/carousel.tsx`; keep every
  action routed through `BlockRenderContext`.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="block (table|card)"
pnpm typecheck
```

Expected: data primitive tests pass.

- [ ] Commit:

```bash
git add desktop/src/features/blocks
git commit -s -m "feat(blocks): add table and card primitives"
```

## Task 11: Implement Chart and Media without executable content

**Files:**

- Create: `desktop/src/features/blocks/ui/primitives/BlockChart.tsx`
- Create: `desktop/src/features/blocks/ui/primitives/BlockMedia.tsx`
- Modify: `desktop/src/features/blocks/ui/BlockRenderer.tsx`

- [ ] Write failing tests for bar, line, area, and donut geometry; zero/negative
  data; a visible accessible table fallback; safe image/video/file/gallery
  rendering; and rejection of `javascript:`, `data:text/html`, and hash-invalid
  sources.

- [ ] Implement charts as native SVG with design-token colors. Do not add a
  chart dependency. Every chart renders a visually collapsible semantic table
  containing the same labels and values.

- [ ] Reuse the current media, lightbox, video, and file attachment components.
  Never use `dangerouslySetInnerHTML`, iframe arbitrary origins, or execute
  embedded scripts/documents.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="block (chart|media)"
pnpm typecheck
```

Expected: chart/media tests pass and dependency graph has no new renderer
runtime.

- [ ] Commit:

```bash
git add desktop/src/features/blocks
git commit -s -m "feat(blocks): add chart and media primitives"
```

## Task 12: Implement Question, Approval, safe actions, and receipts

**Files:**

- Create: `desktop/src/features/blocks/ui/primitives/BlockQuestion.tsx`
- Create: `desktop/src/features/blocks/blockActions.ts`
- Create: `desktop/src/features/blocks/blockActionQueue.ts`
- Modify: `desktop/src/features/blocks/ui/BlockRenderContext.tsx`
- Modify: `desktop/src/features/blocks/ui/BlockMessage.tsx`
- Modify: `desktop/src/features/messages/hooks.ts`
- Modify: `desktop/src/features/messages/lib/imetaMediaMarkdown.ts`
- Modify: `desktop/src/shared/api/relayClientSession.ts`
- Modify: `desktop/src-tauri/src/events.rs`
- Modify: `desktop/src-tauri/src/commands/messages.rs`

- [ ] Write failing tests for single-select, multi-select min/max, selectable
  cards, optional “Something else”, required explanation, submitted/expired/
  superseded state, double-click locking, offline Question queue, and offline
  Approval denial.

- [ ] Add a narrowly validated `reference_tags` channel to the Tauri message
  command. It may accept only:

```text
["a","30178:<64-hex-pubkey>:<valid-handle>","","block"]
["block","1",<handle>,<64-hex-manifest>,<uuid>]
["block-data",<bounded canonical JSON>]
["block-data-ref",<https-url>,"application/json",<sha256>,<size>]
["e",<64-hex-manifest>,"","block"]
```

Keep `imeta`, emoji, actor mentions, and Block references in separate validated
arguments so no generic arbitrary-tag injection path is introduced.

- [ ] Implement `submitBlockAction`. It signs kind `40010`, `p`-tags the
  responsible agent from the instance, disables the control until relay
  acknowledgement, and reuses the same signed event on transport retry.
  Reserved catalog actions instead `p`-tag relay self and wait for the broker's
  receipt; desktop never publishes a catalog head itself.

- [ ] Queue only Question input while offline, scoped by relay URL, identity,
  instance, and manifest. Do not queue Approval grants. Clear the queue during
  community reset and after acknowledged replay.

- [ ] For Approval, recompute `proposal_hash`, compare exact destination,
  content, expiry, and manifest declaration, then sign one grant. Any content
  change or expiry disables the control.

- [ ] Overlay pending, succeeded, denied, failed, and timed-out receipts on the
  originating instance. A later unrelated receipt must not change it.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="block (question|approval|action|receipt)"
pnpm typecheck
```

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml block_reference
```

Expected: interactions pass, double-click creates one signed action, safe
offline input replays, and Approval never queues offline.

- [ ] Commit:

```bash
git add desktop
git commit -s -m "feat(blocks): add questions approvals and receipts"
```

## Task 13: Add the visible Blocks catalog and conversational workshop handoff

**Files:**

- Create: `desktop/src/app/routes/blocks.tsx`
- Create: `desktop/src/app/routes/BlocksRouteScreen.tsx`
- Modify: `desktop/src/app/routes.ts`
- Regenerate: `desktop/src/app/routeTree.gen.ts`
- Modify: `desktop/src/app/AppShell.helpers.ts`
- Modify: `desktop/src/app/AppShell.helpers.test.mjs`
- Modify: `desktop/src/app/navigation/useAppNavigation.ts`
- Modify: `desktop/src/app/AppShell.tsx`
- Modify: `desktop/src/features/sidebar/ui/AppSidebar.tsx`
- Modify: `desktop/src/features/sidebar/ui/AppSidebarPinnedHeader.tsx`
- Create: `desktop/src/features/blocks/ui/BlocksCatalogScreen.tsx`
- Create: `desktop/src/features/blocks/ui/BlockCatalogCard.tsx`
- Modify: `desktop/src/app/routes/messages.new.tsx`
- Modify: `desktop/src/features/messages/ui/NewMessageScreen.tsx`

- [ ] Add failing route tests asserting `/blocks` derives `selectedView:
  "blocks"` and sidebar selection works.

- [ ] Build a registry screen showing preview, handle, description, origin,
  trust, active version, publisher, permissions, compatibility, and recent
  usage. Do not put create/edit forms, kanban, pipelines, or operational
  controls on this page.

- [ ] Catalog selection behavior:

  1. If `catalog.workshop` exists, navigate to that channel/thread.
  2. Otherwise navigate to `/messages/new` with validated search fields
     `blockAddress` and `blockHandle`.
  3. Seed the composer with `Work on @handle ` and register the typed Block
     reference so the eventual message has the signed `a` tag.

The user chooses the agent and continues in chat. Activation/deprecation shown
in the catalog is read-only state from signed events.

- [ ] Add a top-level “Blocks” item beside Agents/Projects/Workflows using a
  Lucide Blocks icon and rem-based labels.

- [ ] Regenerate routes with the existing Vite/TanStack build, not by
  hand-editing generated output.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="blocks route|catalog"
pnpm build:e2e
```

Expected: `/blocks` builds, selection goes to a conversation, and no catalog
operation performs work directly.

- [ ] Commit:

```bash
git add desktop
git commit -s -m "feat(blocks): add catalog and workshop handoff"
```

## Task 14: Add typed Block references to the existing `@` picker

**Files:**

- Modify: `desktop/src/features/messages/lib/mentionCandidates.ts`
- Modify: `desktop/src/features/messages/lib/mentionSuggestionMapping.ts`
- Modify: `desktop/src/features/messages/lib/useMentions.ts`
- Modify: `desktop/src/features/messages/ui/MentionAutocomplete.tsx`
- Modify: `desktop/src/features/messages/ui/useMentionSendFlow.ts`
- Modify: `desktop/src/features/messages/lib/useDrafts.ts`
- Modify: `desktop/src/features/messages/lib/draftMentionRefs.ts`

- [ ] Extend the candidate union:

```ts
type MentionKind = "identity" | "persona" | "team" | "block";

type BlockMentionCandidate = {
  kind: "block";
  blockHandle: string;
  blockAddress: string;
  manifestId: string;
  displayName: string;
};
```

- [ ] Write failing tests proving Block candidates search by handle/name, show
  a Block icon and “Block” type label, insert `@handle`, survive draft reload,
  emit exactly one `a` tag, and never enter actor `p` tags, invitations, agent
  startup, or persistent agent audience state.

- [ ] Add a dedicated `blockMentionMapRef`; do not overload the pubkey/persona
  maps. On send, keep only references whose display text still exists in the
  composed content.

- [ ] Preserve Block draft references as `{displayName, blockAddress,
  manifestId}` and restore them without network lookup. Resolve an ordinary
  active-version mention at send time; explicit draft previews retain their
  manifest ID.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="block mention"
pnpm typecheck
```

Expected: actor mention tests remain green and Block references cannot notify
or start an agent.

- [ ] Commit:

```bash
git add desktop/src/features/messages
git commit -s -m "feat(blocks): add typed block references"
```

## Task 15: Prove every starter composite uses only the native grammar

**Files:**

- Modify: `crates/buzz-relay/src/core_blocks/composites/*.json`
- Create: `desktop/src/features/blocks/coreBlockVectors.test.mjs`
- Create: `desktop/src/features/blocks/ui/StarterBlockGallery.tsx` (test-only export)

- [ ] Render Lead Card, Approval, Report, Artifact, Receipt, and Brainstorm from
  the exact bundled manifest JSON, not duplicated TypeScript fixtures.

- [ ] Add assertions:

  - Lead Card: Card + Details + Status + evidence action.
  - Approval: exact proposal Details + expiry Status + declared approve/deny.
  - Report: Metrics + Chart + Table + source Details.
  - Artifact: Media + Status + Actions.
  - Receipt: Status + Details + immutable references.
  - Brainstorm: Section + multi-select Question + selectable cards + custom
    input.

- [ ] Run:

```bash
cd desktop
pnpm test -- --test-name-pattern="starter block"
pnpm build:e2e
```

Expected: all six render from relay assets and no unknown primitive appears.

- [ ] Commit:

```bash
git add crates/buzz-relay/src/core_blocks desktop/src/features/blocks
git commit -s -m "test(blocks): pin starter composite rendering"
```

## Task 16: Pin web and mobile fallback preservation

**Files:**

- Modify: `mobile/test/features/channels/message_content_test.dart`
- Modify: `mobile/test/shared/relay/nostr_models_test.dart`

- [ ] Add a mobile relay-model test that decodes a kind `9` Block instance,
  preserves all unknown Block tags on re-serialization, and renders `content`
  as ordinary text.

- [ ] Add a mobile widget test showing the exact fallback without exposing raw
  `block-data` JSON.

- [ ] Confirm the current `web/` app has no chat timeline. Record that no web
  production change is needed; its generic event tooling already preserves raw
  tags. Do not invent a web chat UI for this gate.

- [ ] Run:

```bash
cd mobile
flutter test test/shared/relay/nostr_models_test.dart
flutter test test/features/channels/message_content_test.dart
flutter analyze
```

Expected: fallback and tag-preservation tests pass.

- [ ] Commit:

```bash
git add mobile
git commit -s -m "test(blocks): preserve mobile fallback messages"
```

## Task 17: Add mocked desktop E2E for visuals, accessibility, and faults

**Files:**

- Create: `desktop/tests/e2e/blocks.spec.ts`
- Create: `desktop/tests/e2e/blocks-faults.spec.ts`
- Modify: `desktop/playwright.config.ts`
- Modify: `desktop/src/testing/e2eBridge.ts`

- [ ] Register both specs in the smoke project and seed manifests/catalog/
  actions/receipts through `installMockBridge`.

- [ ] Cover:

  - all eleven primitives;
  - all six starter composites;
  - Question keyboard selection and custom text;
  - exact Approval display;
  - action pending and receipt completion;
  - catalog-to-conversation handoff;
  - old manifest after active head changes;
  - unknown, missing, invalid, untrusted, unsupported, oversized, hash-invalid,
    timed-out, permission-denied, and offline states;
  - community A → B → A with no cache leakage.

- [ ] Use `waitForAnimations(page)` before every screenshot. Use locator
  screenshots for individual primitives and verify all PNG hashes are distinct.

- [ ] Run:

```bash
cd desktop
pnpm build:e2e
pnpm exec playwright test tests/e2e/blocks.spec.ts tests/e2e/blocks-faults.spec.ts --project=smoke
```

Expected: all tests pass with no console errors or accessibility-name failures.

- [ ] Run:

```bash
shasum -a 256 desktop/test-results/blocks/*.png
```

Expected: every intended distinct state has a distinct hash.

- [ ] Commit:

```bash
git add desktop
git commit -s -m "test(blocks): cover inline rendering and faults"
```

### Gate B proof

- [ ] Run `just desktop-screenshot` or the scoped Playwright specs through the
  E2E mock bridge.
- [ ] Inspect the PNGs at 100% and 125% app zoom and at 1024×720 and 1440×900.
- [ ] Save approved screenshots under `test-results/blocks/gate-b/`.
- [ ] Do not pass the gate on green checks alone: fallback readability,
  hierarchy, density, and inline-chat fit must be visually acceptable.

## Task 18: Add the real relay/CLI/ACP/desktop proof

**Files:**

- Create: `desktop/tests/e2e/blocks-live.spec.ts`
- Create: `scripts/prove-blocks.sh`
- Create: `docs/testing/BLOCKS_E2E.md`

- [ ] Write `prove-blocks.sh` as orchestration only: activate Hermit, verify
  Postgres/Redis, start the real relay, build the real CLI and ACP harness,
  publish test identities/agents, and print the exact command to launch the
  desktop. Do not hide service logs.

- [ ] The live spec must perform the design's eleven steps in order:

  1. Scout posts a persisted Lead Card.
  2. User references Lead Card and asks Developer to modify it.
  3. Developer publishes a tested draft preview in the workshop thread.
  4. User submits multi-select Brainstorm plus custom input.
  5. ACP delivers the signed action to the agent.
  6. User conversationally activates the new Lead Card version.
  7. Desktop fully restarts and old Lead Card still uses its pinned manifest.
  8. New Lead Card uses the active version.
  9. Approval receives deliberate double-click and signed-event retry.
  10. One Receipt updates the original inline experience.
  11. Invalid, unauthorized, missing, hash-invalid, timeout, and offline cases
      show the specified fallback.

- [ ] The Approval processor in this test is a bounded fake Bridge that
  increments a durable counter and publishes a real receipt. Assert the counter
  is `1`; do not send real email, WhatsApp, payments, or credentials.

- [ ] Capture:

  - relay logs with accepted/rejected event IDs;
  - CLI JSON outputs;
  - ACP prompt showing the Block action;
  - database count for the idempotency claim;
  - before/after/restart desktop screenshots.

- [ ] Run:

```bash
./scripts/prove-blocks.sh
```

Then, in `desktop/`:

```bash
pnpm exec playwright test tests/e2e/blocks-live.spec.ts --project=integration
```

Expected: the live spec passes and writes evidence to
`test-results/blocks/gate-c/`.

- [ ] Commit:

```bash
git add desktop/tests/e2e/blocks-live.spec.ts scripts/prove-blocks.sh docs/testing/BLOCKS_E2E.md
git commit -s -m "test(blocks): prove the live conversation loop"
```

## Task 19: Run the repository gate and reconcile documentation

**Files:**

- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `crates/buzz-cli/TESTING.md`
- Modify: `docs/testing/BLOCKS_E2E.md`

- [ ] Run focused formatting first:

```bash
. ./bin/activate-hermit
just fix-all
```

- [ ] Run the full required gate:

```bash
. ./bin/activate-hermit
just ci
```

Expected: formatting, Clippy, desktop checks, unit tests, and builds pass.

- [ ] Because relay/auth/database paths changed, run integration tests with
  Postgres and Redis:

```bash
. ./bin/activate-hermit
just test
```

Expected: full integration suite passes.

- [ ] Run mobile checks:

```bash
cd mobile
dart format --output=none --set-exit-if-changed .
flutter analyze
flutter test
```

- [ ] Re-run Gate C after all formatting/refactoring. A prior live proof is not
  evidence for a changed final tree.

- [ ] Document only what exists. Keep “implemented,” “locally tested,”
  “committed,” “merged,” “deployed,” and “live-proven” as separate states.

- [ ] Commit:

```bash
git add README.md ARCHITECTURE.md crates/buzz-cli/TESTING.md docs/testing/BLOCKS_E2E.md
git commit -s -m "docs(blocks): document contracts and proof runbook"
```

## Final completion checklist

- [ ] `git status --short` is clean except intentional proof artifacts excluded
  by `.gitignore`.
- [ ] Every commit has a `Signed-off-by` trailer.
- [ ] No new production `unwrap()` or `expect()`.
- [ ] No arbitrary HTML, JavaScript, CSS, iframe, filesystem, network, secret,
  or Tauri access is exposed to manifests.
- [ ] All module-level community state has an explicit reset.
- [ ] Every Block has readable fallback text.
- [ ] Every rendered action is declared by the pinned manifest.
- [ ] Approval authorization is exact, expiring, hashed, and one-time.
- [ ] The original message still renders its old pinned version after restart.
- [ ] Gate A, Gate B, and Gate C evidence references the final commit SHA.
