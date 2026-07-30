# Chat-Native Blocks Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat the operating canvas by letting agents publish safe,
versioned, interactive Blocks inside ordinary message threads, including
persistent Agent Proposals that can always be reopened and resolved.

**Architecture:** Keep every Block instance as a normal kind `9` message with
readable fallback text. Add immutable manifest, replaceable catalog-head,
action, receipt, and attention-projection contracts around that message. The
relay validates public envelopes, is the sole signer of the authoritative
catalog head per handle, brokers owner/admin-signed catalog actions, and
enforces action idempotency. The SDK and CLI own canonical creation; the
desktop resolves and validates manifests, renders a closed native primitive
grammar, signs interactions, executes trusted Core actions through bounded
brokers, and overlays receipts. Web and mobile remain fallback-only.

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
- the eleven native primitives and seven starter composites;
- persisted `@agent-proposal` create/update requests, explicit resolution, and
  Inbox Needs action projection;
- a catalog that returns the user to a conversation rather than becoming a
  workflow UI;
- typed Block references in the existing `@` picker;
- ACP delivery of Block actions to the responsible agent;
- desktop rich rendering and web/mobile fallback preservation;
- mocked renderer proof and real relay/CLI/ACP/desktop proof.

This plan does not implement Company storage, Lead/Client lifecycle, Plugin
credentials, outbound email or WhatsApp, payments, accounting connectors,
arbitrary code-backed Blocks, a marketplace, or a technical rename of Buzz
crate/protocol identifiers. It does not add a separate agent-request page or
duplicate request store.

## Acceptance gates

### Gate A — Protocol is proven

Pass only when canonical manifest/instance/action/receipt vectors round-trip
through core, SDK, relay, and CLI; malformed envelopes are rejected; and two
different signed actions with the same `(community, instance, idempotency_key)`
resolve to one stored action. Attention markers must be accepted only for
trusted actionable manifests, and only authorized resolving receipts may clear
them.

### Gate B — Desktop experience is proven

Pass only when every native primitive renders in the real desktop build with
loading, empty, populated, error, disabled, and completed states; unknown or
invalid Blocks show their fallback; keyboard and screen-reader checks pass; and
community switching leaks no manifest, payload, action, receipt, pending
proposal, or Core-broker state. Multiple Agent Proposals must remain
independently reviewable, and closing review must not resolve one.

### Gate C — Conversation loop is proven

Pass only when the real relay, CLI, ACP harness, and desktop complete the
fifteen-step proof from the design spec, including a restarted desktop rendering
an old pinned manifest, a multi-select Brainstorm submission reaching an agent,
one Approval result under deliberate double-click/retry, and an Agent Proposal
that survives close/restart and creates exactly one agent under replay and
post-create recovery.

## Wire contract to pin before UI work

| Event | Kind | Required public tags | Content |
|---|---:|---|---|
| Manifest | `40012` | `["block","1",handle,version]` | Canonical `BlockManifest` JSON |
| Catalog head | `30178` | `["d",handle]`, `["e",manifest_id,"","block-manifest"]`, `["block-state","active"|"deprecated"]` | Canonical `BlockCatalogEntry` JSON; relay-signed only |
| Instance | `9` | normal `h/e/p`, `["e",manifest_id,"","block"]`, `["block","1",handle,manifest_id,instance_id]`, exactly one data tag; actionable instances add `["block-attention","1","required"]` | Human-readable fallback |
| Action | `40010` | `h`, `p` for the processor (owner for Core agent management), `["e",instance_event_id,"","block-instance"]`, `["e",manifest_id,"","block-manifest"]`, `["block-action","1",action_id,instance_id,idempotency_key]` | Canonical non-secret action input JSON |
| Receipt | `40011` | `h`, `["e",action_event_id,"","block-action"]`, `["e",instance_event_id,"","block-instance"]`, `["block-receipt","1",instance_id,idempotency_key,status]`; resolving receipts add `["block-attention","1","resolved"]` | Canonical safe result JSON |
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

`block-attention` has exact cardinality. An instance may request attention only
when its trusted pinned manifest declares at least one resolving signed action
and the instance `p`-tags the decision maker. A receipt may resolve attention
only when it references that instance and a manifest-declared resolving action,
has an authorized processor signature, and is not failed or timed out. Read
markers, dialog dismissal, and presentation-only controls never resolve it.

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
- Modify `crates/buzz-db/src/feed.rs`
- Create `crates/buzz-relay/src/blocks.rs`
- Create `crates/buzz-relay/src/core_blocks.rs`
- Create `crates/buzz-relay/src/block_broker.rs`
- Create `crates/buzz-relay/src/core_blocks/primitives/*.json`
- Create `crates/buzz-relay/src/core_blocks/composites/*.json`
- Modify `crates/buzz-relay/src/lib.rs`
- Modify `crates/buzz-relay/src/main.rs`
- Modify `crates/buzz-relay/src/handlers/ingest.rs`
- Modify `crates/buzz-relay/src/handlers/community_provisioning.rs`
- Create `crates/buzz-relay/tests/block_attention_feed.rs`
- Modify `crates/buzz-acp/src/config.rs`
- Modify `crates/buzz-acp/src/setup_mode.rs`
- Modify `crates/buzz-acp/src/queue.rs`
- Modify `crates/buzz-acp/src/base_prompt.md`

### Agent-first CLI

- Modify `crates/buzz-cli/src/lib.rs`
- Modify `crates/buzz-cli/src/agent_management.rs`
- Modify `crates/buzz-cli/src/commands/mod.rs`
- Modify `crates/buzz-cli/src/commands/agents.rs`
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
- Create `desktop/src/features/blocks/agentProposal.ts`
- Create `desktop/src/features/blocks/useAgentProposalReview.ts`
- Create `desktop/src/features/blocks/useAgentProposalBroker.ts`
- Create `desktop/src/features/blocks/agentProposal.test.mjs`
- Delete `desktop/src/features/agents/agentManagement.ts`
- Delete `desktop/src/features/agents/useAgentManagement.ts`
- Modify `desktop/src/features/agents/observerRelayStore.ts`
- Modify `desktop/src/features/agents/ui/AgentManagementDialogs.tsx`
- Modify `desktop/src/features/home/lib/inbox.test.mjs`
- Modify `desktop/src/features/messages/types.ts`
- Modify `desktop/src/features/messages/lib/formatTimelineMessages.ts`
- Modify `desktop/src/features/messages/ui/MessageRow.tsx`
- Modify `desktop/src/features/messages/hooks.ts`
- Modify `desktop/src/features/messages/lib/imetaMediaMarkdown.ts`
- Modify `desktop/src/shared/api/relayClientSession.ts`
- Modify `desktop/src-tauri/src/events.rs`
- Modify `desktop/src-tauri/src/commands/messages.rs`
- Create `desktop/src-tauri/src/commands/agent_proposals.rs`
- Create `desktop/src-tauri/src/commands/agent_proposals_tests.rs`
- Modify `desktop/src-tauri/src/commands/personas/create.rs`
- Modify `desktop/src-tauri/src/commands/agents.rs`
- Modify `desktop/src-tauri/src/managed_agents/types.rs`
- Modify `desktop/src-tauri/src/managed_agents/persona_events.rs`
- Modify `desktop/src-tauri/src/managed_agents/agent_events.rs`
- Create `desktop/src/shared/api/agentProposals.ts`

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

Action controls use one closed interaction contract:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BlockInteraction {
    Presentation { surface: CorePresentationSurface },
    Signed {
        action_id: String,
        #[serde(default)]
        resolves_attention: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CorePresentationSurface {
    AgentReview,
}
```

`Presentation` is valid only in a relay-bundled Core manifest and can only open
the named local surface. It never produces an event. `Signed` must name one
entry in `manifest.actions`; only `resolves_attention: true` actions may
produce a resolving receipt.

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
bounds are impossible. Also reject a presentation surface in a non-Core
manifest, attention with no resolving action, a resolving action with no
schema, and any Agent Proposal schema that permits private keys, `envVars`,
provider credentials, or backend configuration secrets.

The primitive manifest handles are exactly `@section`, `@metric`, `@details`,
`@table`, `@card`, `@card-list`, `@chart`, `@media`, `@status`, `@actions`, and
`@question`. The starter composite handles are exactly `@lead-card`,
`@approval`, `@agent-proposal`, `@report`, `@artifact`, `@receipt`, and
`@brainstorm`.

- [ ] Add golden vectors in the test module for canonical key ordering,
  Question single-select/multi-select/custom input, Approval hash stability,
  Agent Proposal create/update data, required/resolved attention tags, and
  rejection of secret-looking Agent Proposal fields.

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
responsible processor when the manifest declares signed actions. Add:

```rust
pub enum BlockAttention {
    None,
    Required { decision_maker: PublicKey },
}
```

`BlockInstanceInput` carries `attention`. `Required` emits exactly one
`["block-attention","1","required"]` and one matching `p` tag and is rejected
unless the pinned manifest declares a resolving signed action.
`build_block_action` must derive a UUID idempotency key when none is supplied
and return it to the caller with the builder. `BlockReceiptInput` carries
`resolves_attention`; it may emit
`["block-attention","1","resolved"]` only for a compatible succeeded or denied
result whose referenced manifest action declares `resolves_attention`.

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
  state. For `block-attention`, fetch only the already-stored pinned manifest:
  require trusted status, a resolving action, and a single decision-maker `p`
  tag. A resolving receipt must reference that instance and action, be signed
  by the declared processor, and have a compatible non-failure status. These
  validators never fetch external URLs or execute Block data.

- [ ] Add the Core Agent Proposal signer gate. For handle `agent-proposal`, the
  instance signer must be a relay-verified agent whose NIP-OA owner equals the
  attention `p` tag, and both signer and owner must belong to the `h` channel.
  A human-authored preview may render but may not carry `block-attention`.

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
  no action reference, an action ID absent from the manifest, attention on an
  untrusted or non-resolving manifest, an unowned Agent Proposal, a
  target-channel mismatch, and a failed receipt that claims to resolve
  attention.

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
- Create: `crates/buzz-relay/src/core_blocks/composites/agent-proposal.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/report.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/artifact.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/receipt.json`
- Create: `crates/buzz-relay/src/core_blocks/composites/brainstorm.json`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-relay/src/main.rs`
- Modify: `crates/buzz-relay/src/handlers/community_provisioning.rs`
- Modify: `crates/buzz-db/src/lib.rs`

- [ ] Write failing tests that load all eighteen JSON assets, validate every
  example, assert the handles are unique, prove each primitive asset has its
  matching root node, and prove `brainstorm` contains a multi-select Question
  with optional custom input. Prove `agent-proposal` uses only Card, Details,
  Status, and Actions; contains Core `agent-review` presentation; declares
  `agent.create`, `agent.update`, and `agent.decline` as resolving signed
  actions; and has no secret-bearing schema fields.

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

Expected: eighteen valid manifests and eighteen catalog heads; a second seed
inserts zero; a newer broker-selected head remains untouched.

- [ ] Commit:

```bash
git add crates/buzz-relay crates/buzz-db
git commit -s -m "feat(blocks): seed native composite catalog"
```

## Task 5: Add the complete agent-first CLI surface

**Files:**

- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/agent_management.rs`
- Modify: `crates/buzz-cli/src/commands/mod.rs`
- Modify: `crates/buzz-cli/src/commands/agents.rs`
- Create: `crates/buzz-cli/src/commands/blocks.rs`
- Modify: `crates/buzz-cli/TESTING.md`
- Modify: `crates/buzz-acp/src/base_prompt.md`

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

- [ ] Replace the observer-frame transport behind the existing
  `buzz agents draft-create` and `draft-update` commands. Keep their command
  names and arguments stable, but make `agent_management.rs` build validated
  `agent-proposal` data, resolve the active Core manifest, and publish a normal
  kind `9` Block instance with:

```text
["h",<channel-uuid>]
["p",<owner-pubkey>]
["e",<manifest-id>,"","block"]
["block","1","agent-proposal",<manifest-id>,<request-uuid>]
["block-attention","1","required"]
["block-data",<canonical-no-secret-json>]
```

Use a readable fallback such as
`Developer proposed hiring Researcher. Review the Agent Proposal in AI Native Office.`
Publish through the normal stored-event path, never
`publish_ephemeral_event`. Output stable JSON with `proposal_saved: true`,
`agent_changed: false`, the instance event ID, and request UUID. If the Core
manifest cannot be resolved or validated, fail visibly; do not fall back to an
observer frame.

- [ ] Add CLI tests decrypting/parsing the old fixture inputs and asserting the
  new events are kind `9`, owner-addressed, channel-scoped, attention-marked,
  schema-valid, and contain none of `privateKey`, `envVars`, `credentials`, or
  backend config. Assert no draft-create/update path calls
  `publish_ephemeral_event`.

- [ ] Update `base_prompt.md` to say these commands post persistent owner-review
  cards in the current thread. Preserve the rule that no agent is created or
  changed until the owner explicitly resolves the card.

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
git add crates/buzz-cli crates/buzz-acp/src/base_prompt.md
git commit -s -m "feat(blocks): add agent-first block commands"
```

## Task 6: Deliver signed Block actions to ACP agents

**Files:**

- Modify: `crates/buzz-acp/src/config.rs`
- Modify: `crates/buzz-acp/src/setup_mode.rs`
- Modify: `crates/buzz-acp/src/queue.rs`

- [ ] Add failing tests proving default Mention-mode filters subscribe to both
  kind `9` and `KIND_BLOCK_ACTION`, and that an action only matches the agent
  named by its `p` tag. An `agent-proposal` action `p`-tagged to the human
  owner must not enter any managed agent's ACP queue; the desktop Core broker
  owns it.

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
- [ ] Publish one valid owned-agent Agent Proposal plus forged, wrong-owner,
  and wrong-channel variants. Resolve the valid one once and query the stored
  instance, action, and receipt.
- [ ] Save the command/output transcript under
  `test-results/blocks/gate-a.txt`.
- [ ] Do not continue until the second submission returns the first action ID,
  exactly one action is stored, every malformed fixture is rejected, and only
  the authorized processor can publish the resolving receipt.

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
  approval hash, presentation-vs-signed interaction model, attention
  required/resolved markers, Agent Proposal no-secret contract, and tag
  extraction.

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

`BlockInstanceRef` includes `attentionRequired` and `decisionMakerPubkey`.
Receipt parsing includes `resolvesAttention`. Reject duplicate attention tags,
required attention without exactly one decision-maker `p` tag, a presentation
surface in a non-Core manifest, and failed/timed-out receipts that claim to
resolve attention.

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

- [ ] `BlockActions` may only invoke interactions declared by the pinned
  manifest through context. Signed interactions use `submitBlockAction`.
  Presentation interactions use a closed Core-surface registry and may only
  reveal local detail; the first registered surface is `agent-review`.
  Non-Core presentation controls and disabled/untrusted controls render
  disabled with an accessible explanation.

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
["block-attention","1","required"]
["e",<64-hex-manifest>,"","block"]
```

Keep `imeta`, emoji, actor mentions, and Block references in separate validated
arguments so no generic arbitrary-tag injection path is introduced.

- [ ] Implement `submitBlockAction`. It signs kind `40010`, `p`-tags the
  responsible agent from the instance, disables the control until relay
  acknowledgement, and reuses the same signed event on transport retry.
  Reserved catalog actions instead `p`-tag relay self and wait for the broker's
  receipt; Core Agent Proposal actions `p`-tag the current owner identity and
  are delivered to the desktop Core broker. Desktop never publishes a catalog
  head itself.

- [ ] Queue only Question input while offline, scoped by relay URL, identity,
  instance, and manifest. Do not queue Approval grants. Clear the queue during
  community reset and after acknowledged replay.

- [ ] For Approval, recompute `proposal_hash`, compare exact destination,
  content, expiry, and manifest declaration, then sign one grant. Any content
  change or expiry disables the control.

- [ ] Overlay pending, succeeded, denied, failed, and timed-out receipts on the
  originating instance. A later unrelated receipt must not change it.
  `resolvesAttention` becomes true only for a validated authorized receipt
  carrying `["block-attention","1","resolved"]`; failed and timed-out receipts
  keep the instance actionable.

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

## Task 13: Project unresolved actionable Blocks into Inbox

**Files:**

- Modify: `crates/buzz-db/src/feed.rs`
- Modify: `crates/buzz-db/src/lib.rs`
- Create: `crates/buzz-relay/tests/block_attention_feed.rs`

- [ ] Write failing feed tests for the durable attention lifecycle. Use a
  persisted kind `9` Agent Proposal `p`-tagged to the owner and assert:

```text
unresolved proposal                         -> Needs action
ordinary mentioned kind 9                   -> Mentions only
failed/timed-out receipt                     -> still Needs action
authorized resolving receipt                -> no longer Needs action
resolving receipt from another community    -> still Needs action
resolving receipt from an inaccessible room -> cannot affect visible result
```

Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-db block_attention
cargo test -p buzz-relay --test block_attention_feed
```

Expected: fail because Needs action only includes kinds `46010` and `40007`.

- [ ] Extend `build_needs_action_query` without adding another request table.
  Continue using the indexed `event_mentions` owner lookup. Include a kind `9`
  event only when it contains the exact required-attention tag and no same-
  community kind `40011` references its event ID with both
  `block-instance` and resolved-attention tags:

```sql
(
  e.kind IN (46010, 40007)
  OR (
    e.kind = 9
    AND e.tags @> '[["block-attention","1","required"]]'::jsonb
    AND NOT EXISTS (
      SELECT 1
      FROM events receipt
      WHERE receipt.community_id = e.community_id
        AND receipt.deleted_at IS NULL
        AND receipt.kind = 40011
        AND receipt.tags @> jsonb_build_array(
          jsonb_build_array(
            'e',
            encode(e.id, 'hex'),
            '',
            'block-instance'
          )
        )
        AND receipt.tags @>
          '[["block-attention","1","resolved"]]'::jsonb
    )
  )
)
```

Keep the existing accessible-channel predicate, limit, ordering, and composite
tenant join. Add SQL-shape and integration tests proving the GIN-backed
containment predicates and community keys remain present.

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-db block_attention
cargo test -p buzz-relay --test block_attention_feed
```

Expected: unresolved actionable Blocks enter Needs action, failed attempts stay,
authorized resolution clears them, and cross-community or inaccessible-channel
receipts cannot affect the result.

- [ ] Commit:

```bash
git add crates/buzz-db crates/buzz-relay/tests/block_attention_feed.rs
git commit -s -m "feat(blocks): project unresolved actions into inbox"
```

## Task 14: Replace ephemeral agent-management popups with Agent Proposals

**Files:**

- Create: `desktop/src/features/blocks/agentProposal.ts`
- Create: `desktop/src/features/blocks/useAgentProposalReview.ts`
- Create: `desktop/src/features/blocks/useAgentProposalBroker.ts`
- Delete: `desktop/src/features/agents/agentManagement.ts`
- Delete: `desktop/src/features/agents/useAgentManagement.ts`
- Modify: `desktop/src/features/agents/observerRelayStore.ts`
- Modify: `desktop/src/features/agents/ui/AgentManagementDialogs.tsx`
- Modify: `desktop/src/features/home/lib/inbox.test.mjs`
- Modify: `desktop/src/app/AppShell.tsx`
- Create: `desktop/src/shared/api/agentProposals.ts`
- Create: `desktop/src-tauri/src/commands/agent_proposals.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/src/commands/personas/create.rs`
- Modify: `desktop/src-tauri/src/commands/agents.rs`
- Modify: `desktop/src-tauri/src/managed_agents/types.rs`
- Modify: `desktop/src-tauri/src/managed_agents/persona_events.rs`
- Modify: `desktop/src-tauri/src/managed_agents/agent_events.rs`
- Modify: `desktop/src/features/agents/AGENTS.md`
- Create: `desktop/src/features/blocks/agentProposal.test.mjs`
- Create: `desktop/src-tauri/src/commands/agent_proposals_tests.rs`

- [ ] Define the strict desktop proposal contract in `agentProposal.ts`:

```ts
export type AgentProposalData =
  | {
      mode: "create";
      requestId: string;
      channelId: string;
      displayName: string;
      systemPrompt: string;
    }
  | {
      mode: "update";
      requestId: string;
      channelId: string;
      agentName: string;
      displayName?: string;
      systemPrompt?: string;
      runtime?: string;
      provider?: string;
      model?: string;
      respondTo?: "owner-only" | "anyone";
    };

export type AgentProposalSafeAction = {
  requestId: string;
  definition: {
    id?: string;
    displayName: string;
    avatarUrl?: string;
    systemPrompt: string;
    runtime?: string;
    provider?: string;
    model?: string;
    behavior?: {
      respondTo?: "owner-only" | "allowlist" | "anyone";
      respondToAllowlist?: string[];
      parallelism?: number;
    };
  };
  runOn:
    | { type: "local" }
    | { type: "provider"; id: string };
};
```

The parser uses `hasOnlyKeys` at every object level and rejects `envVars`,
`privateKey`, credentials, provider backend config, unknown keys, create with
an ID, update without exactly one editable target, and action `requestId`
mismatch. Proposal data `requestId` must equal the Block instance UUID. Avatar
input must already be an uploaded HTTP(S) URL or absent; data URIs never enter
the signed action. Provider ID is safe to sign; provider `config` is not. The
review controller keeps `BackendIntent.config` only in the existing local
dialog/IPC path and passes it separately to the Tauri execution command. It
never enters the action or receipt.

- [ ] Refactor, do not duplicate, the existing proposal logic. Move
  `createInputFromRequest`, `updateInputFromRequest`, editable-persona
  resolution, origin checks, runtime checks, avatar resolution, and
  definition/instance input construction behind `useAgentProposalReview`.
  `AgentManagementDialogs` receives the selected persisted Block instance and
  exact signer/channel metadata. Closing it only clears the local selected
  instance:

```ts
function closeReview() {
  setSelectedProposal(null);
  setError(null);
}
```

It must not mark the request seen, publish an action, publish a receipt, or
change Inbox state. The generic `BlockActions` renderer calls the closed Core
presentation registry entry `agent-review`; no Agent Proposal-specific renderer
is allowed. The Inbox detail pane renders the same `MessageRow`, so its Review
control uses the identical path.

- [ ] Delete the live request trigger after the persisted path is covered.
  Remove `agentManagementListeners`,
  `subscribeAgentManagementRequests`, and management-request dispatch from
  `observerRelayStore.ts`; remove the one-item `request` state,
  `seenRequestIds`, `pendingRequestId`, and 100-entry startup buffer from
  `useAgentManagement.ts`. Keep observer telemetry, transcript, control-result,
  and archive behavior unchanged. Add a static test proving no production
  agent-management request depends on kind `24200`.

- [ ] Make Core Agent Proposal creation crash-recoverable in Tauri. Add this
  backward-compatible field only to the local managed-agent record:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub creation_request_id: Option<String>,
```

Add it to every `ManagedAgentRecord` constructor with `None`; do not add it to
`AgentDefinition`, persona event content, public agent events, snapshots, or
ACP environment. The broker uses the proposal `requestId` as the deterministic
new definition ID, and passes the same value as `creation_request_id` when
creating the managed instance. Refactor private helpers so retries behave:

```rust
pub enum AgentProposalExecutionOutcome {
    Applied {
        definition_id: String,
        agent_pubkey: String,
        recovered: bool,
    },
    Failed { safe_message: String },
}
```

On create: first load definitions and records under
`managed_agents_store_lock`; if both deterministic definition ID and a record
with matching `creation_request_id` exist, return them with `recovered: true`.
If only the definition exists, resume instance creation. If neither exists,
create the definition with `id = request_id`, save it, then create the instance
with `creation_request_id = request_id`. A crash after either durable write
therefore converges on the same definition and pubkey. Hydrate the existing
record's key through the current secure storage path; never put it in the
Block receipt.

On update: resolve the exact editable definition ID from the accepted action
and apply the complete canonical non-secret state. Replaying the same state is
convergent. Reject built-ins, team definitions, missing IDs, request/data
mismatch, or any secret-bearing action field before touching the store.

For provider execution, accept `backend_config` only as a separate Tauri IPC
argument supplied by the currently open trusted review dialog. If replay finds
an existing record with the same `creation_request_id`, recover it without
needing config. If no record exists and the provider config is unavailable
after restart, return a safe failure so the proposal stays pending and the user
can reopen and retry; never persist the secret in a Block action or broker
ledger.

- [ ] Implement the owner-side Core broker in `useAgentProposalBroker.ts`.
  Mount it once in `AppShell`. It accepts only verified kind `40010` events
  `p`-tagged to the current owner, referencing a valid pending Core
  `agent-proposal` instance in a channel shared with its owned signer.
  Immediately after the relay acknowledges `agent.create` or `agent.update`,
  call `execute_agent_proposal`; on app start/reconnect, query explicit kind
  `40010` with `#p = self` and replay any accepted action whose proposal still
  lacks a resolving receipt.

  Publish one receipt:

```ts
type AgentProposalReceiptResult =
  | {
      outcome: "created" | "updated";
      definitionId: string;
      agentPubkey?: string;
      recovered: boolean;
    }
  | { outcome: "declined" }
  | { outcome: "failed"; message: string };
```

`created`, `updated`, and `declined` receipts carry resolved attention.
`failed` does not, so Review and retry remain available. `agent.decline` never
calls Tauri. Before publishing any receipt, query by action event ID and return
the existing receipt if present.

- [ ] Wire the compact UI and Inbox projection. Pending cards show proposed
  name, create/update label, requester, role summary, and **Review agent**.
  Approved/declined cards remain in the thread with their receipt state.
  Failed cards show a safe message plus **Review and retry**. Multiple cards
  have state keyed by instance event ID, never a global single slot. Inbox
  Needs action uses the existing feed row and detail pane; selecting a row
  returns to the exact thread/message and does not invent an Agent Requests
  route.

- [ ] Add focused tests:

```bash
cd desktop
pnpm test -- --test-name-pattern="agent proposal|block attention"
pnpm typecheck
```

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml agent_proposal
cargo test -p buzz-db block_attention
cargo test -p buzz-relay --test block_attention_feed
```

Cover two simultaneous proposals, close/reopen, Escape, channel navigation,
restart hydration, owner/channel forgery, built-in update rejection,
double-click, duplicate signed action, crash after definition save, crash after
managed-agent save but before receipt, failed receipt staying in Needs action,
provider config absent from every signed event, provider replay recovery when a
record exists, provider replay failure-before-create staying pending, decline
without creation, community reset, and no secret in any event/receipt.

- [ ] Update `desktop/src/features/agents/AGENTS.md` with the durable invariant:
  Agent Proposals are kind `9` Blocks; observer frames are never an
  authorization or persistence surface; closing review does not resolve; and
  `creation_request_id` is local idempotency metadata excluded from public
  events and snapshots.

- [ ] Commit:

```bash
git add desktop
git commit -s -m "feat(blocks): persist and resolve agent proposals"
```

## Task 15: Add the visible Blocks catalog and conversational workshop handoff

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

## Task 16: Add typed Block references to the existing `@` picker

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

## Task 17: Prove every starter composite uses only the native grammar

**Files:**

- Modify: `crates/buzz-relay/src/core_blocks/composites/*.json`
- Create: `desktop/src/features/blocks/coreBlockVectors.test.mjs`
- Create: `desktop/src/features/blocks/ui/StarterBlockGallery.tsx` (test-only export)

- [ ] Render Lead Card, Approval, Agent Proposal, Report, Artifact, Receipt, and
  Brainstorm from the exact bundled manifest JSON, not duplicated TypeScript
  fixtures.

- [ ] Add assertions:

  - Lead Card: Card + Details + Status + evidence action.
  - Approval: exact proposal Details + expiry Status + declared approve/deny.
  - Agent Proposal: Card + Details + Status + Core agent-review presentation +
    declared create/update/decline actions, with no secret-bearing fields.
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

Expected: all seven render from relay assets and no unknown primitive appears.

- [ ] Commit:

```bash
git add crates/buzz-relay/src/core_blocks desktop/src/features/blocks
git commit -s -m "test(blocks): pin starter composite rendering"
```

## Task 18: Pin web and mobile fallback preservation

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

## Task 19: Add mocked desktop E2E for visuals, accessibility, and faults

**Files:**

- Create: `desktop/tests/e2e/blocks.spec.ts`
- Create: `desktop/tests/e2e/blocks-faults.spec.ts`
- Modify: `desktop/playwright.config.ts`
- Modify: `desktop/src/testing/e2eBridge.ts`

- [ ] Register both specs in the smoke project and seed manifests/catalog/
  actions/receipts through `installMockBridge`.

- [ ] Cover:

  - all eleven primitives;
  - all seven starter composites;
  - Question keyboard selection and custom text;
  - exact Approval display;
  - two pending Agent Proposals, close/reopen review, failed retry, decline, and
    resolved Inbox removal;
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
- [ ] Inspect pending, failed/retry, approved, and declined Agent Proposal
  states inline and through Inbox detail. Reject any result that behaves like a
  separate Agent Requests product surface.

## Task 20: Add the real relay/CLI/ACP/desktop proof

**Files:**

- Create: `desktop/tests/e2e/blocks-live.spec.ts`
- Create: `scripts/prove-blocks.sh`
- Create: `docs/testing/BLOCKS_E2E.md`

- [ ] Write `prove-blocks.sh` as orchestration only: activate Hermit, verify
  Postgres/Redis, start the real relay, build the real CLI and ACP harness,
  publish test identities/agents, and print the exact command to launch the
  desktop. Do not hide service logs.

- [ ] The live spec must perform the design's fifteen steps in order:

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
  11. An owned agent posts two persisted Agent Proposals in the same thread.
  12. User opens one, closes it, restarts desktop, and recovers it inline and
      in Inbox → Needs action.
  13. User edits safe config and creates exactly one local agent under
      double-click, signed-action replay, and post-create/pre-receipt recovery.
  14. Its receipt clears Needs action; declining the second creates no agent.
  15. Invalid, unauthorized, missing, hash-invalid, timeout, and offline cases
      show the specified fallback.

- [ ] The Approval processor in this test is a bounded fake Bridge that
  increments a durable counter and publishes a real receipt. Assert the counter
  is `1`; do not send real email, WhatsApp, payments, or credentials.

- [ ] Capture:

  - relay logs with accepted/rejected event IDs;
  - CLI JSON outputs;
  - ACP prompt showing the Block action;
  - database count for the idempotency claim;
  - Needs action query before/after Agent Proposal resolution;
  - managed-agent count and stable pubkey across replay/recovery;
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

## Task 21: Run the repository gate and reconcile documentation

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
- [ ] Agent Proposal review survives dismissal and restart; two simultaneous
  proposals never overwrite each other.
- [ ] Agent Proposal replay/recovery creates one definition and one managed
  agent, and no Block payload/action/receipt contains a secret.
- [ ] Needs action is a derived index that clears only on an authorized
  resolving receipt.
- [ ] The original message still renders its old pinned version after restart.
- [ ] Gate A, Gate B, and Gate C evidence references the final commit SHA.
