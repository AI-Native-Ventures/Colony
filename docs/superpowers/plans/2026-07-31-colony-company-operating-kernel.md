# Colony Company Operating Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smallest durable company/work kernel that lets Colony identify
agents by personal name or role, group one agent into multiple teams, represent
single-team Tasks inside cross-team Initiatives, and attribute every paid agent
turn to a deterministic work and accounting context.

**Architecture:** Model Company, Initiative, and Task as company-owner-authored
Nostr parameterized-replaceable events. One author is required because the
author pubkey is part of every NIP-33 coordinate; allowing agents or admins to
write the same logical ID directly would create competing heads. Agents and
other humans read the records and request mutations through chat; the owner
desktop signs the authoritative replacement. Extend the existing NIP-AP Persona and
Team projections rather than creating a second employee directory. Put work
context identifiers on the triggering chat event, hydrate the canonical records
before an ACP turn, and snapshot the result into the owner-encrypted NIP-AM turn
metric. Expose the contracts through `buzz-cli` first and build only chat
autocomplete/status integration in desktop—no Company, Task, or Initiative page.

**Tech Stack:** Rust, Nostr/NIP-33, serde, clap, `buzz-core`, `buzz-sdk`,
`buzz-relay`, `buzz-cli`, `buzz-acp`, Tauri 2, React 19, TypeScript, TanStack
Query, node:test, Playwright.

---

## Scope guardrails

- Do not add Company, Task, Initiative, department, accounting, or dashboard
  pages.
- Do not replace identity/community onboarding in this plan.
- Do not create a second agent, persona, or team store.
- Preserve `ManagedAgentRecord.name` as the personal instance name.
- Add role identity to `PersonaRecord`; do not overload display name with role.
- Preserve multi-team membership through `TeamRecord.persona_ids`.
- Treat `ManagedAgentRecord.team_id` as a legacy deployment/source-team hint,
  not the authoritative membership list.
- Every Task has exactly one `owning_team_id`.
- Cross-team work is one Initiative with multiple single-team Tasks.
- Do not store prompts, message text, client names, or monetary context in
  public NIP-AM tags. Work and cost context stays in encrypted metric content.
- Keep new fields backward-compatible with existing persona, team, and metric
  events.
- Do not classify costs with an LLM. Classification comes from the Task's
  explicit commercial purpose and deterministic rule.
- Do not allow multiple authors to create competing NIP-33 heads for one
  Company, Initiative, or Task ID. This phase uses the company owner as the
  single canonical author.

## Acceptance gates

### Gate A — Protocol and authorization

Pass only when Company, Initiative, and Task builders round-trip across core,
SDK, relay, and CLI; malformed content, unknown fields, missing `d` tags,
duplicate identity tags, invalid status transitions, invalid team ownership,
and Task/Initiative coordinate mismatches are rejected.

### Gate B — Identity and team semantics

Pass only when:

- one managed agent has a personal name and a stable role ID/title;
- `@personal-name` and `@role` resolve to the same pubkey;
- a role rename does not rewrite historical references;
- one persona belongs to multiple teams;
- every team lead is also a member;
- `@team` expands to each currently resolvable team member once.

### Gate C — Work and cost attribution

Pass only when one real agent turn triggered from chat produces exactly one
decryptable NIP-AM metric with:

- `taskId`;
- `initiativeId` when present;
- `owningTeamId`;
- `costCentreId`;
- `commercialPurpose`;
- deterministic `costClassification`;
- `attributionState`;

and when an untagged informal agent instruction receives an idempotent
background Task before the paid turn starts.

---

## Wire contracts

Reserve the adjacent NIP-33 kinds:

| Entity | Kind | Coordinate | Required tags |
|---|---:|---|---|
| Company | `30179` | owner + kind + `company_id` | `d`, `company` |
| Initiative | `30180` | owner + kind + `initiative_id` | `d`, `company`, optional `cost-centre`, optional `client` |
| Task | `30181` | owner + kind + `task_id` | `d`, `company`, `team`, optional `initiative`, `cost-centre`, optional `client` |

The content schema names are:

- `colony.company/v1`;
- `colony.initiative/v1`;
- `colony.task/v1`.

IDs use stable lowercase slugs or UUIDs matching
`^[a-z0-9][a-z0-9._:-]{0,127}$`. Human titles are never used as coordinates.

### Company

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanyProfile {
    pub schema: String,
    pub id: String,
    pub trading_name: String,
    pub legal_name: Option<String>,
    pub website: Option<String>,
    pub summary: String,
    pub business_type: String,
    pub services: Vec<CompanyService>,
    pub customer_segments: Vec<String>,
    pub cost_centres: Vec<CostCentre>,
    pub source_report_event_id: Option<String>,
    pub onboarding_status: CompanyOnboardingStatus,
    pub created_at: i64,
    pub updated_at: i64,
}
```

### Initiative

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Initiative {
    pub schema: String,
    pub id: String,
    pub company_id: String,
    pub title: String,
    pub summary: String,
    pub status: InitiativeStatus,
    pub owner_persona_id: String,
    pub cost_centre_id: String,
    pub commercial_purpose: CommercialPurpose,
    pub client_organization_id: Option<String>,
    pub expected_cost_usd: Option<f64>,
    pub source_channel_id: String,
    pub source_event_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
```

### Task

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanyTask {
    pub schema: String,
    pub id: String,
    pub company_id: String,
    pub initiative_id: Option<String>,
    pub title: String,
    pub status: TaskStatus,
    pub owning_team_id: String,
    pub assignee_persona_ids: Vec<String>,
    pub qa_persona_id: String,
    pub cost_centre_id: String,
    pub commercial_purpose: CommercialPurpose,
    pub client_organization_id: Option<String>,
    pub source_channel_id: String,
    pub source_event_id: Option<String>,
    pub implicit: bool,
    pub created_at: i64,
    pub updated_at: i64,
}
```

`CommercialPurpose` is:

```rust
pub enum CommercialPurpose {
    ClientDelivery,
    Sales,
    Marketing,
    Administration,
    InternalProduct,
    Uncertain,
}
```

The deterministic mapping is:

| Purpose | Classification |
|---|---|
| `clientDelivery` with a client organization | `cogs` |
| `sales`, `marketing`, `administration`, `internalProduct` | `opex` |
| missing client on `clientDelivery`, or `uncertain` | `needsReview` |

The encrypted metric snapshot is:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkContext {
    pub company_id: String,
    pub task_id: String,
    pub initiative_id: Option<String>,
    pub owning_team_id: String,
    pub cost_centre_id: String,
    pub commercial_purpose: CommercialPurpose,
    pub cost_classification: CostClassification,
    pub attribution_state: AttributionState,
    pub client_organization_id: Option<String>,
}
```

`attributionState` is `explicit`, `inherited`, or `implicitTask`.

The validation-only team projection is:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyTeamRef {
    pub id: String,
    pub lead_persona_id: String,
    pub persona_ids: Vec<String>,
}
```

---

## Task 1: Add failing core contract tests

**Files:**

- Modify: `crates/buzz-core/src/kind.rs`
- Create: `crates/buzz-core/src/company.rs`
- Modify: `crates/buzz-core/src/lib.rs`
- Modify: `crates/buzz-core/src/agent_turn_metric.rs`

### Step 1: Pin the new kind numbers

- [ ] Add failing tests in `crates/buzz-core/src/kind.rs` asserting:
  - `30179`, `30180`, and `30181` are parameterized replaceable;
  - none are ephemeral;
  - all fit in `u16`;
  - the three numbers are distinct from Persona, Team, Managed Agent, and Block
    catalog kinds.

Use:

```rust
#[test]
fn company_work_kinds_are_addressable_and_distinct() {
    let kinds = [KIND_COMPANY_PROFILE, KIND_INITIATIVE, KIND_TASK];
    assert_eq!(kinds, [30179, 30180, 30181]);
    for kind in kinds {
        assert!(is_parameterized_replaceable(kind));
        assert!(!is_ephemeral(kind));
        assert!(kind <= u16::MAX as u32);
    }
    let unique = kinds.into_iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), 3);
}
```

### Step 2: Write red schema/validation tests

- [ ] Create `crates/buzz-core/src/company.rs` with only a `#[cfg(test)]` module
  first.
- [ ] Add fixtures for one Company, two teams, one Initiative, and two Tasks.
- [ ] Assert:
  - exact-schema JSON round-trips;
  - unknown fields fail;
  - blank IDs/titles fail;
  - duplicate service and cost-centre IDs fail;
  - Initiative cost centre exists in Company;
  - Task company matches Initiative company;
  - Task owning team exists;
  - Task QA persona is a member of its owning team;
  - Task assignees are unique;
  - a direct specialist Task may include an assignee from another team while
    retaining one owning team;
  - `clientDelivery` without `clientOrganizationId` becomes `needsReview`;
  - `clientDelivery` with a client becomes `cogs`;
  - all other known purposes become `opex`.

### Step 3: Add red metric compatibility tests

- [ ] Extend `sample_payload()` in
  `crates/buzz-core/src/agent_turn_metric.rs` with `work_context`.
- [ ] Add a test proving a legacy payload without `workContext` still parses.
- [ ] Add a test proving unknown fields inside `workContext` fail.
- [ ] Add a test proving work context is preserved by NIP-44 encryption.

### Step 4: Run the red state

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-core company --no-fail-fast
cargo test -p buzz-core agent_turn_metric --no-fail-fast
```

Expected: compile failures for the missing constants, module, types, and metric
field.

### Step 5: Commit the red tests

- [ ] Commit only the test scaffolding:

```bash
git add crates/buzz-core/src/kind.rs crates/buzz-core/src/company.rs \
  crates/buzz-core/src/lib.rs crates/buzz-core/src/agent_turn_metric.rs
git commit -s -m "test(core): pin Colony company work contracts"
```

---

## Task 2: Implement and validate the core company/work model

**Files:**

- Modify: `crates/buzz-core/src/kind.rs`
- Modify: `crates/buzz-core/src/company.rs`
- Modify: `crates/buzz-core/src/lib.rs`
- Modify: `crates/buzz-core/src/agent_turn_metric.rs`

### Step 1: Add constants and exports

- [ ] Add:

```rust
pub const KIND_COMPANY_PROFILE: u32 = 30179;
pub const KIND_INITIATIVE: u32 = 30180;
pub const KIND_TASK: u32 = 30181;
```

- [ ] Export `pub mod company;` from `crates/buzz-core/src/lib.rs`.

### Step 2: Implement exact serde contracts

- [ ] Implement the wire structs above plus:
  - `CompanyService { id, name, description }`;
  - `CostCentre { id, name, kind, service_id }`;
  - `CostCentreKind::{Service, Internal}`;
  - `CompanyOnboardingStatus::{Draft, Approved}`;
  - `InitiativeStatus::{Proposed, Approved, Active, Blocked, Completed, Cancelled}`;
  - `TaskStatus::{Proposed, Ready, InProgress, InReview, Blocked, Completed, Cancelled}`;
  - `CostClassification::{Cogs, Opex, NeedsReview}`;
  - `AttributionState::{Explicit, Inherited, ImplicitTask}`.

- [ ] Put `#[serde(deny_unknown_fields)]` on every externally parsed object.
- [ ] Enforce 128-character IDs, 200-character titles/names, 4,000-character
  summaries, 100 services/cost centres, and 100 assignees.
- [ ] Reject non-finite or negative `expected_cost_usd`.

### Step 3: Implement cross-record validation

- [ ] Add:

```rust
pub fn validate_company(profile: &CompanyProfile) -> Result<(), CompanyContractError>;
pub fn validate_initiative(
    initiative: &Initiative,
    company: &CompanyProfile,
) -> Result<(), CompanyContractError>;
pub fn validate_task(
    task: &CompanyTask,
    company: &CompanyProfile,
    initiative: Option<&Initiative>,
    teams: &[CompanyTeamRef],
) -> Result<(), CompanyContractError>;
pub fn classify_cost(
    purpose: CommercialPurpose,
    client_organization_id: Option<&str>,
) -> CostClassification;
```

- [ ] Return typed, display-safe validation errors without echoing full
  confidential content.

### Step 4: Extend NIP-AM

- [ ] Add `pub work_context: Option<AgentWorkContext>` to
  `AgentTurnMetricPayload` with `#[serde(default)]`.
- [ ] Call `work_context.validate()` from `AgentTurnMetricPayload::validate()`.
- [ ] Keep the existing public tags unchanged: exactly `p` and `agent`.

### Step 5: Prove green

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test -p buzz-core company --no-fail-fast
cargo test -p buzz-core agent_turn_metric --no-fail-fast
```

Expected: all selected tests pass.

### Step 6: Commit

- [ ] Commit:

```bash
git add crates/buzz-core/src/kind.rs crates/buzz-core/src/company.rs \
  crates/buzz-core/src/lib.rs crates/buzz-core/src/agent_turn_metric.rs
git commit -s -m "feat(core): add Colony company work contracts"
```

---

## Task 3: Add SDK builders and parser vectors

**Files:**

- Create: `crates/buzz-sdk/src/company.rs`
- Modify: `crates/buzz-sdk/src/lib.rs`

### Step 1: Write failing builder tests

- [ ] Add tests for:
  - Company event tags: one `d`, one `company`;
  - Initiative tags: one `d`, one `company`, one `cost-centre`, optional
    `client`;
  - Task tags: one `d`, one `company`, one `team`, optional `initiative`,
    `cost-centre`, and `client`;
  - canonical JSON content;
  - duplicate/stray contract tags rejected by parsers;
  - coordinate ID equals content ID;
  - Task tag values equal content values.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-sdk company --no-fail-fast
```

Expected: module/builders are missing.

### Step 3: Implement builders

- [ ] Add:

```rust
pub fn build_company_profile(profile: &CompanyProfile) -> Result<EventBuilder, CompanySdkError>;
pub fn build_initiative(initiative: &Initiative) -> Result<EventBuilder, CompanySdkError>;
pub fn build_task(task: &CompanyTask) -> Result<EventBuilder, CompanySdkError>;
pub fn parse_company_event(event: &Event) -> Result<CompanyProfile, CompanySdkError>;
pub fn parse_initiative_event(event: &Event) -> Result<Initiative, CompanySdkError>;
pub fn parse_task_event(event: &Event) -> Result<CompanyTask, CompanySdkError>;
```

- [ ] Reuse one strict helper for exact tag cardinality.
- [ ] Do not add an `h` tag; these definitions are community-global.

### Step 4: Prove and commit

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test -p buzz-sdk company --no-fail-fast
```

- [ ] Commit:

```bash
git add crates/buzz-sdk/src/company.rs crates/buzz-sdk/src/lib.rs
git commit -s -m "feat(sdk): build Colony company work events"
```

---

## Task 4: Admit and validate company/work events at the relay

**Files:**

- Modify: `crates/buzz-relay/src/handlers/ingest.rs`
- Create: `crates/buzz-relay/src/company_events.rs`
- Modify: `crates/buzz-relay/src/lib.rs`
- Modify: `crates/buzz-search/tests/fts_integration.rs`

### Step 1: Write failing relay tests

- [ ] Add unit tests proving the three kinds:
  - require `UsersWrite`;
  - are global-only;
  - never require `h`;
  - reject malformed JSON and tag/content mismatches;
  - allow all three writes only when the event author is the current company
    owner;
  - reject admins, ordinary members, owned managed agents, unmanaged bots, and
    foreign managed agents as direct head authors.

- [ ] Add an integration test proving replacing Task `task-1` does not replace
  `task-2` and an older `task-1` event cannot win.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-relay company_events --no-fail-fast
```

Expected: kinds are unknown/rejected.

### Step 3: Add scope/routing entries

- [ ] Import the new constants into `ingest.rs`.
- [ ] Add them to `required_scope_for_kind` as `Scope::UsersWrite`.
- [ ] Add them to `is_global_only_kind`.
- [ ] Do not add them to `requires_h_channel_scope`.

### Step 4: Add semantic authorization

- [ ] In `company_events.rs`, validate:
  - signature and exact SDK envelope;
  - current tenant membership;
  - current company owner for Company, Initiative, and Task;
  - Initiative/Task author matches the author of the referenced Company;
  - the author cannot claim a different owner or create a second head under a
    different author.
- [ ] Call the validator before the generic insert/replace path.
- [ ] Keep rejection messages generic enough not to reveal private company
  state.

### Step 5: Protect search behavior

- [ ] Keep these events out of NIP-50 full-text indexing by writing
  `search_tsv = NULL` for the three kinds.
- [ ] Add a dedicated `company_work_kinds_have_storage_null_tsvector` drift
  test so the company contract is not hidden behind unrelated p-gated naming.

### Step 6: Prove and commit

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test -p buzz-relay company_events --no-fail-fast
cargo test -p buzz-search company_work_kinds_have_storage_null_tsvector --no-fail-fast
```

- [ ] Commit:

```bash
git add crates/buzz-relay/src/handlers/ingest.rs \
  crates/buzz-relay/src/company_events.rs crates/buzz-relay/src/lib.rs \
  crates/buzz-search/tests/fts_integration.rs
git commit -s -m "feat(relay): validate Colony company work events"
```

---

## Task 5: Add agent-first Company, Initiative, and Task CLI commands

**Files:**

- Modify: `crates/buzz-cli/src/lib.rs`
- Modify: `crates/buzz-cli/src/commands/mod.rs`
- Create: `crates/buzz-cli/src/commands/company.rs`
- Create: `crates/buzz-cli/src/commands/initiatives.rs`
- Create: `crates/buzz-cli/src/commands/tasks.rs`
- Modify: `crates/buzz-cli/TESTING.md`

### Step 1: Pin the command surface with parser tests

- [ ] Add parse tests for:

```text
buzz company get --id horizon-labs
buzz company put --file company.json
buzz initiatives list --company horizon-labs
buzz initiatives get --id init-homepage
buzz initiatives put --file initiative.json
buzz tasks list --company horizon-labs
buzz tasks list --initiative init-homepage
buzz tasks get --id task-copy
buzz tasks put --file task.json
buzz tasks complete --id task-copy
```

- [ ] Preserve the global `--format compact` position.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-cli company_command_surface_parses --no-fail-fast
```

Expected: subcommands do not exist.

### Step 3: Implement reads and writes

- [ ] Use the SDK builders and `BuzzClient::query_paginated`.
- [ ] Require explicit kinds on every query.
- [ ] Resolve the company owner from the current NIP-OA auth tag for reads.
- [ ] Permit `put`/`complete` only when the CLI signing key is the company
  owner. Managed agents may `list`/`get`; mutations must be requested through
  chat for the owner desktop to sign.
- [ ] Return one stable JSON envelope:

```json
{
  "event_id": "hex",
  "accepted": true,
  "message": "saved",
  "entity_id": "task-copy"
}
```

- [ ] `complete` must first read the current Task, preserve all immutable
  identity/ownership fields, set `status=completed`, set `updatedAt`, and publish
  a replacement.
- [ ] Exit with write-conflict code `5` if a newer head wins.

### Step 4: Add the live runbook

- [ ] Document creating one Company, two teams, one Initiative, and two Tasks.
- [ ] Document exact query filters and expected compact output.
- [ ] Do not include private keys or real client data.

### Step 5: Prove and commit

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test -p buzz-cli --lib --no-fail-fast
cargo build -p buzz-cli
```

- [ ] Commit:

```bash
git add crates/buzz-cli/src/lib.rs crates/buzz-cli/src/commands/mod.rs \
  crates/buzz-cli/src/commands/company.rs \
  crates/buzz-cli/src/commands/initiatives.rs \
  crates/buzz-cli/src/commands/tasks.rs crates/buzz-cli/TESTING.md
git commit -s -m "feat(cli): operate Colony company work records"
```

---

## Task 6: Separate personal name from stable role identity

**Files:**

- Modify: `desktop/src-tauri/src/managed_agents/types.rs`
- Modify: `desktop/src-tauri/src/managed_agents/personas.rs`
- Modify: `desktop/src-tauri/src/managed_agents/persona_events.rs`
- Modify: `desktop/src-tauri/src/commands/personas/create.rs`
- Modify: `desktop/src-tauri/src/commands/personas/update.rs`
- Modify: `desktop/src-tauri/src/commands/personas/inbound.rs`
- Modify: `desktop/src/shared/api/types.ts`
- Modify: `desktop/src/shared/api/tauriPersonas.ts`
- Modify: `desktop/src/testing/e2eBridge.ts`
- Modify: `desktop/src-tauri/src/managed_agents/personas/tests.rs`
- Modify: `desktop/src/features/agents/lib/usePersonaSync.test.mjs`

### Step 1: Add failing compatibility tests

- [ ] Assert old Persona JSON with no role fields still parses with both fields
  `None`.
- [ ] Assert a role-bearing Persona event round-trips:

```json
{
  "role_id": "chief-of-staff",
  "role_title": "Chief of Staff"
}
```

- [ ] Assert `role_id` is a lowercase slug, `role_title` is nonblank, and the
  pair must be both present or both absent.
- [ ] Assert role changes participate in persona content hashing/source version.
- [ ] Assert secrets remain excluded from the projection.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml managed_agents::personas --no-fail-fast
cd desktop && pnpm exec tsx --test src/features/agents/lib/usePersonaSync.test.mjs
```

Expected: missing fields.

### Step 3: Add the fields end-to-end

- [ ] Add optional `role_id`/`role_title` to Rust Persona records, event content,
  create request, and update request.
- [ ] Add optional `roleId`/`roleTitle` to TypeScript `AgentPersona`,
  `CreatePersonaInput`, and `UpdatePersonaInput`.
- [ ] Validate the pair at the Tauri command boundary.
- [ ] Preserve personal identity:
  - `AgentPersona.displayName` remains the default personal name for an
    undeployed persona;
  - `ManagedAgent.name` remains the deployed employee's personal name;
  - role fields never overwrite either.

### Step 4: Give Fizz the Chief of Staff role without changing identity

- [ ] Update the built-in Fizz definition:

```rust
role_id: Some("chief-of-staff"),
role_title: Some("Chief of Staff"),
```

- [ ] Replace the maker prompt with a Chief of Staff prompt covering company
  understanding, delegation, cross-team coordination, evidence review, and
  explicit approval before external effects.
- [ ] Keep `id = "builtin:fizz"` and `display_name = "Fizz"` for migration and
  historical mention stability.

### Step 5: Prove and commit

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test --manifest-path desktop/src-tauri/Cargo.toml managed_agents::personas --no-fail-fast
cd desktop && pnpm exec tsx --test src/features/agents/lib/usePersonaSync.test.mjs
```

- [ ] Commit:

```bash
git add desktop/src-tauri/src/managed_agents/types.rs \
  desktop/src-tauri/src/managed_agents/personas.rs \
  desktop/src-tauri/src/managed_agents/persona_events.rs \
  desktop/src-tauri/src/commands/personas/create.rs \
  desktop/src-tauri/src/commands/personas/update.rs \
  desktop/src-tauri/src/commands/personas/inbound.rs \
  desktop/src/shared/api/types.ts desktop/src/shared/api/tauriPersonas.ts \
  desktop/src/testing/e2eBridge.ts \
  desktop/src-tauri/src/managed_agents/personas/tests.rs \
  desktop/src/features/agents/lib/usePersonaSync.test.mjs
git commit -s -m "feat(agents): separate employee name from role"
```

---

## Task 7: Add team leads while preserving multi-team membership

**Files:**

- Modify: `desktop/src-tauri/src/managed_agents/types.rs`
- Modify: `desktop/src-tauri/src/managed_agents/teams.rs`
- Modify: `desktop/src-tauri/src/managed_agents/team_events.rs`
- Modify: `desktop/src-tauri/src/commands/teams.rs`
- Modify: `desktop/src/shared/api/types.ts`
- Modify: `desktop/src/shared/api/tauriTeams.ts`
- Modify: `desktop/src/features/agents/teamHooks.ts`
- Modify: `desktop/src/features/agents/lib/teamPersonas.ts`
- Modify: `desktop/src/testing/e2eBridge.ts`
- Modify: `desktop/src-tauri/src/managed_agents/teams_tests.rs`
- Create: `desktop/src/features/agents/lib/teamLead.test.mjs`

### Step 1: Add failing tests

- [ ] Assert old Team JSON without a lead parses with `None`.
- [ ] Assert a team with `leadPersonaId` requires that persona in
  `personaIds`.
- [ ] Assert the same persona ID may occur in multiple distinct teams.
- [ ] Assert duplicate persona IDs inside one team are rejected.
- [ ] Assert deleting a lead persona is blocked until affected teams are
  updated.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test --manifest-path desktop/src-tauri/Cargo.toml managed_agents::teams --no-fail-fast
cd desktop && pnpm exec tsx --test src/features/agents/lib/teamLead.test.mjs
```

### Step 3: Implement the field

- [ ] Add optional `lead_persona_id` / `leadPersonaId` to Team records,
  projections, create/update inputs, sync, and mock bridge.
- [ ] Validate membership atomically in create/update commands.
- [ ] Do not add a `department` field.
- [ ] Do not change `ManagedAgentRecord.team_id`; document it as a deployment
  hint and migrate runtime ownership toward Task context.

### Step 4: Prove and commit

- [ ] Run the focused Rust and TypeScript tests, then:

```bash
cd desktop && pnpm lint
```

- [ ] Commit:

```bash
git add desktop/src-tauri/src/managed_agents/types.rs \
  desktop/src-tauri/src/managed_agents/teams.rs \
  desktop/src-tauri/src/managed_agents/team_events.rs \
  desktop/src-tauri/src/commands/teams.rs \
  desktop/src/shared/api/types.ts desktop/src/shared/api/tauriTeams.ts \
  desktop/src/features/agents/teamHooks.ts \
  desktop/src/features/agents/lib/teamPersonas.ts \
  desktop/src/testing/e2eBridge.ts \
  desktop/src-tauri/src/managed_agents/teams_tests.rs \
  desktop/src/features/agents/lib/teamLead.test.mjs
git commit -s -m "feat(teams): add lead identity and multi-team invariants"
```

---

## Task 8: Resolve mentions by personal name, role, or team

**Files:**

- Modify: `desktop/src/features/messages/lib/mentionCandidates.ts`
- Modify: `desktop/src/features/messages/lib/mentionRanking.ts`
- Modify: `desktop/src/features/messages/lib/mentionSuggestionMapping.ts`
- Modify: `desktop/src/features/messages/lib/useMentions.ts`
- Modify: `desktop/src/features/messages/ui/MentionAutocomplete.tsx`
- Modify: `desktop/src/features/messages/lib/mentionRanking.test.mjs`
- Create: `desktop/src/features/messages/lib/roleMentions.test.mjs`
- Modify: `desktop/tests/e2e/mentions.spec.ts`

### Step 1: Write failing mention tests

- [ ] Use one agent:
  - personal name `Jason`;
  - persona `builtin:cto`;
  - role ID `cto`;
  - role title `CTO`.
- [ ] Assert `jas`, `cto`, and `chief technology` all rank the same agent.
- [ ] Assert selecting after a role query inserts `@CTO` but stores the same
  pubkey reference as selecting `@Jason`.
- [ ] Assert a collision between a person's name and a role shows both personal
  name and role title and never silently targets by text alone.
- [ ] Assert `@marketing-team` still expands each unique member once even when
  one person belongs to Engineering too.

### Step 2: Run red

- [ ] Run:

```bash
cd desktop
pnpm exec tsx --test \
  src/features/messages/lib/mentionRanking.test.mjs \
  src/features/messages/lib/roleMentions.test.mjs
```

### Step 3: Add alias-aware candidate fields

- [ ] Add to actor mention candidates/suggestions:

```ts
roleId?: string | null;
roleTitle?: string | null;
insertLabel?: string;
matchLabels?: string[];
```

- [ ] Build role fields by joining managed agents to their Persona.
- [ ] Rank across personal name, role ID, role title, persona name, and existing
  secondary label.
- [ ] When the best score came from role ID/title, set `insertLabel` to the
  role title; otherwise use personal name.
- [ ] Keep the pubkey/persona reference authoritative.
- [ ] Render `Personal name · Role title` in autocomplete.

### Step 4: Prove in real desktop E2E

- [ ] Add a test that types `@cto`, selects `Jason · CTO`, sends the message,
  and asserts:
  - visible content includes `@CTO`;
  - outgoing `p`/mention reference targets Jason's pubkey;
  - no second agent is created;
  - the mentioned managed agent is prepared exactly once.

- [ ] Run:

```bash
cd desktop
pnpm test:e2e:integration -- --grep "role mention"
```

### Step 5: Commit

- [ ] Commit:

```bash
git add desktop/src/features/messages/lib/mentionCandidates.ts \
  desktop/src/features/messages/lib/mentionRanking.ts \
  desktop/src/features/messages/lib/mentionSuggestionMapping.ts \
  desktop/src/features/messages/lib/useMentions.ts \
  desktop/src/features/messages/ui/MentionAutocomplete.tsx \
  desktop/src/features/messages/lib/mentionRanking.test.mjs \
  desktop/src/features/messages/lib/roleMentions.test.mjs \
  desktop/tests/e2e/mentions.spec.ts
git commit -s -m "feat(chat): mention agents by name role or team"
```

---

## Task 9: Add desktop relay repositories for Company, Initiative, and Task

**Files:**

- Modify: `desktop/src/shared/constants/kinds.ts`
- Modify: `mobile/lib/shared/relay/nostr_models.dart`
- Modify: `mobile/test/shared/relay/nostr_models_test.dart`
- Create: `desktop/src/features/company/contracts.ts`
- Create: `desktop/src/features/company/companyRepository.ts`
- Create: `desktop/src/features/company/workRepository.ts`
- Create: `desktop/src/features/company/hooks.ts`
- Create: `desktop/src/features/company/companyRepository.test.mjs`
- Modify: `desktop/src/features/communities/useCommunityInit.ts`

### Step 1: Write failing repository tests

- [ ] Pin TypeScript mirror constants `30179`, `30180`, `30181`.
- [ ] Pin the same three constants in Flutter `EventKind`; mobile remains
  fallback-only and does not gain company UI in this phase.
- [ ] Test strict parsing, exact tags, newest-head selection, stale replacement,
  relay failure, empty results, and community-switch cancellation.
- [ ] Test that no Task content is placed in localStorage.

### Step 2: Run red

- [ ] Run:

```bash
cd desktop
pnpm exec tsx --test src/features/company/companyRepository.test.mjs
cd ../mobile && flutter test test/shared/relay/nostr_models_test.dart
```

### Step 3: Implement relay-only repositories

- [ ] Query with explicit kinds and `#d`.
- [ ] Sign writes with the current identity through `signRelayEvent`.
- [ ] Validate the same exact wire shapes before returning records.
- [ ] Add React Query keys that include the active community ID.
- [ ] Add `resetCompanyRepositoryState()` only if a module-level cache is
  introduced; wire it into `resetCommunityState()`.

### Step 4: Prove and commit

- [ ] Run:

```bash
cd desktop
pnpm exec tsx --test src/features/company/companyRepository.test.mjs
pnpm lint
```

- [ ] Commit:

```bash
git add desktop/src/shared/constants/kinds.ts \
  mobile/lib/shared/relay/nostr_models.dart \
  mobile/test/shared/relay/nostr_models_test.dart \
  desktop/src/features/company/contracts.ts \
  desktop/src/features/company/companyRepository.ts \
  desktop/src/features/company/workRepository.ts \
  desktop/src/features/company/hooks.ts \
  desktop/src/features/company/companyRepository.test.mjs \
  desktop/src/features/communities/useCommunityInit.ts
git commit -s -m "feat(desktop): sync Colony company work context"
```

---

## Task 10: Attach explicit and implicit work context before agent spend

**Files:**

- Create: `desktop/src/features/company/workContext.ts`
- Create: `desktop/src/features/company/implicitTask.ts`
- Modify: `desktop/src/features/messages/ui/useMentionSendFlow.ts`
- Modify: `desktop/src/features/messages/lib/imetaMediaMarkdown.ts`
- Create: `desktop/src/features/company/workContext.test.mjs`
- Modify: `desktop/tests/e2e/mentions.spec.ts`

### Step 1: Pin the outgoing tag contract

- [ ] Add tests for exact optional tags:

```text
["task", task_id]
["initiative", initiative_id]
["team", owning_team_id]
```

- [ ] Do not put cost centre, client, commercial purpose, or classification in
  chat tags; ACP resolves those from the Task.
- [ ] Reject duplicate Task/Initiative/team tags.

### Step 2: Pin implicit Task resolution

- [ ] For an agent-directed message without a Task:
  - use the only team containing the agent Persona when exactly one exists;
  - otherwise use the Company Coordination team;
  - use that team's lead as QA;
  - use the company's internal coordination cost centre;
  - set purpose `administration` unless the composer carries explicit client
    delivery context;
  - derive the Task ID as UUID v5 from
    `(company_id, channel_id, root_event_or_local_send_id)`;
  - publish the Task once before sending the paid instruction.
- [ ] On retry, reuse the same Task ID and replacement coordinate.

### Step 3: Run red

- [ ] Run:

```bash
cd desktop
pnpm exec tsx --test src/features/company/workContext.test.mjs
```

### Step 4: Implement send ordering

- [ ] Extend the mention send flow:
  1. resolve/provision the target managed agents;
  2. resolve or create work context;
  3. wait for accepted Task write;
  4. merge the three reference tags;
  5. send the message;
  6. start the agent only after the message is accepted.
- [ ] If Task creation fails, do not start the agent and show a retryable
  error preserving the draft.
- [ ] Do not create Tasks for ordinary human-only chat.

### Step 5: Prove and commit

- [ ] Run the unit test and a focused E2E that asserts Task publication precedes
  managed-agent start.
- [ ] Commit:

```bash
git add desktop/src/features/company/workContext.ts \
  desktop/src/features/company/implicitTask.ts \
  desktop/src/features/messages/ui/useMentionSendFlow.ts \
  desktop/src/features/messages/lib/imetaMediaMarkdown.ts \
  desktop/src/features/company/workContext.test.mjs \
  desktop/tests/e2e/mentions.spec.ts
git commit -s -m "feat(chat): establish work context before agent spend"
```

---

## Task 11: Hydrate work context in ACP and publish attributed metrics

**Files:**

- Modify: `crates/buzz-acp/src/queue.rs`
- Modify: `crates/buzz-acp/src/pool.rs`
- Modify: `crates/buzz-acp/src/relay.rs`
- Modify: `crates/buzz-acp/src/base_prompt.md`
- Modify: `crates/buzz-acp/src/lib.rs`

### Step 1: Write failing hydration tests

- [ ] Add tests for:
  - extracting exact Task/Initiative/team tags;
  - rejecting duplicates/malformed IDs;
  - querying the Task by `kind=30181` and `#d`;
  - querying the optional Initiative by `kind=30180` and `#d`;
  - Task team tag equals content;
  - Initiative and Task company IDs agree;
  - Company cost centre exists;
  - cost classification is recalculated, never trusted from a prompt;
  - no LLM call occurs when context cannot be established;
  - retrying one event does not publish duplicate implicit Tasks.

### Step 2: Run red

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-acp work_context --no-fail-fast
```

### Step 3: Extend queued work

- [ ] Add:

```rust
pub struct HydratedWorkContext {
    pub task: CompanyTask,
    pub initiative: Option<Initiative>,
    pub company: CompanyProfile,
    pub metric: AgentWorkContext,
}
```

- [ ] Store it with the queued event/session turn, not in a module-global map.
- [ ] Fetch with explicit kinds through the existing relay client.
- [ ] Inject a compact, machine-labelled work section into the turn prompt:

```text
<colony-work-context>
Task: ...
Owning team: ...
Initiative: ...
Commercial purpose: ...
</colony-work-context>
```

- [ ] Tell agents not to reinterpret accounting classification and to report
  missing/contradictory context.

### Step 4: Publish metric snapshot

- [ ] Pass `AgentWorkContext` into every
  `publish_agent_turn_metric(...)` call path.
- [ ] Set `AgentTurnMetricPayload.work_context`.
- [ ] Ensure cancellation, error, max-token, and normal end-turn metrics all
  retain the same work context.

### Step 5: Prove and commit

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo fmt --all -- --check
cargo test -p buzz-acp work_context --no-fail-fast
cargo test -p buzz-acp usage --no-fail-fast
```

- [ ] Commit:

```bash
git add crates/buzz-acp/src/queue.rs crates/buzz-acp/src/pool.rs \
  crates/buzz-acp/src/relay.rs crates/buzz-acp/src/base_prompt.md \
  crates/buzz-acp/src/lib.rs
git commit -s -m "feat(acp): attribute every Colony agent turn"
```

---

## Task 12: Run the kernel proof gate

**Files:**

- Create: `crates/buzz-test-client/tests/e2e_company_work.rs`
- Modify: `crates/buzz-test-client/Cargo.toml`
- Create: `desktop/tests/e2e/company-work-context.spec.ts`
- Modify: `desktop/playwright.config.ts`
- Modify: `TESTING.md`

### Step 1: Add real relay protocol proof

- [ ] Start Postgres, Redis, and relay using the repository test harness.
- [ ] Publish a Company, Initiative, and two Tasks.
- [ ] Replace one Task and prove the other remains.
- [ ] Prove a non-owner cannot replace Company, Initiative, or Task.
- [ ] Prove owner replacement succeeds and an owned managed agent reads the
  resulting Task but cannot create a competing head.

### Step 2: Add real desktop interaction proof

- [ ] In E2E mode seed:
  - Fizz/Chief of Staff;
  - Jason/CTO;
  - Engineering and Company Coordination teams;
  - one Company and Initiative.
- [ ] Type `@cto`, select `Jason · CTO`, send an instruction, and prove:
  - one implicit Task is created;
  - Company Coordination owns ambiguous multi-team work;
  - Fizz is QA;
  - the message includes task/initiative/team tags;
  - Jason starts after Task acceptance.

### Step 3: Add live NIP-AM proof

- [ ] Against a local real relay and real test agent:
  - create explicit Task context with CLI;
  - send an agent instruction carrying the Task;
  - wait for the response;
  - query `kind:44200` as owner;
  - decrypt the newest metric;
  - assert all work-context fields and cost classification.
- [ ] Capture IDs and assertions, not private keys or decrypted prompts.

### Step 4: Run the full local gate

- [ ] Run:

```bash
. ./bin/activate-hermit
cargo test -p buzz-core -p buzz-sdk -p buzz-cli --no-fail-fast
cargo test -p buzz-relay company_work --no-fail-fast
cargo test -p buzz-acp work_context --no-fail-fast
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-fail-fast
cd desktop && pnpm test:e2e:integration -- --grep "company work context"
cd .. && just ci
```

Expected: all pass. If infrastructure-dependent tests are unavailable, report
the missing gate as unproven; do not substitute mock success.

### Step 5: Commit proof assets

- [ ] Commit:

```bash
git add crates/buzz-test-client/tests/e2e_company_work.rs \
  crates/buzz-test-client/Cargo.toml \
  desktop/tests/e2e/company-work-context.spec.ts \
  desktop/playwright.config.ts TESTING.md
git commit -s -m "test: prove Colony company work attribution"
```

---

## Plan self-review checklist

- [ ] Every new Nostr query specifies `kinds`.
- [ ] Every addressable event has one exact `d` tag matching content.
- [ ] No Company/Task/Initiative page was added.
- [ ] No department field was added.
- [ ] Personal name and role are separate.
- [ ] Multi-team membership is represented once through Team membership.
- [ ] Every Task has one owning team and one QA persona.
- [ ] Every paid turn either has explicit context or creates one implicit Task.
- [ ] Cost classification is deterministic and snapshotted in encrypted content.
- [ ] Existing public NIP-AM tags remain unchanged.
- [ ] Legacy Persona, Team, and NIP-AM JSON still parses.
- [ ] Community-switch state is reset or scoped.
- [ ] All commits use `-s`.
- [ ] Implemented, tested, committed, pushed, merged, deployed, and live-proven
  are reported separately.
