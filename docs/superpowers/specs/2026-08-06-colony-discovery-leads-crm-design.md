# Colony Discovery Leads, CRM, and mentionable Leads design

Date: 2026-08-06
Branch: `codex/discovery-leads-crm`
Worktree: `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-leads-crm`

## Outcome

Make Leads a first-class Colony surface: a Leads tab is the default view of
Discovery, the numbers shown on industry/vertical cards are the real counts
from the workspace, a Lead can be opened, edited, moved through the company's
relationship lifecycle, and mentioned in a chat message as the existing
`lead-card` Block.

This phase deliberately builds on Colony primitives that already exist. It
adds no new identity, no new CRM kind, no new mention tag family, and no new
storage technology. Every requirement below names the primitive it reuses.

## Product boundary

- Discovery has two top-level tabs: **Leads** (default) and **Discover**.
- Leads tab shows every retained Lead in the workspace, with an empty state
  and a **Discover more** action that opens the Discover tab.
- Industry and vertical cards sort by real retained-Lead counts, highest
  first, and display those counts instead of fixture or hardcoded numbers.
- A Lead row/card is clickable and opens a detail view with an edit form.
- Lead status uses the Party relationship lifecycle: `candidate`,
  `accepted`, `qualified`, `dormant`, `disqualified`. A won deal is a
  conversion to a Client relationship (`active`), which the Party primitive
  already models as a separate view.
- A new **Pipeline** tab shows Leads grouped by relationship status with
  counts, and lets a user move a Lead between allowed states.
- A Lead is mentionable in a chat message by attaching the existing
  `lead-card` Block, the same primitive used for other rich cards.
- People discovery remains preview-only; this phase's live operations are
  Businesses Leads. The UI work applies to both tables where free.

## Reused primitives

| Requirement | Primitive | Where it lives |
| --- | --- | --- |
| Lead identity and history | Colony Party (`KIND_PARTY` 30182, party actions 40015/40016) | `crates/buzz-core/src/party.rs`, `crates/buzz-relay/src/party_broker.rs`, `migrations/0030_party_action_claims.sql` |
| CRM lifecycle and owner | Party Relationship (`KIND_PARTY_RELATIONSHIP` 30183): `RelationshipKind::Lead` statuses `candidate/accepted/qualified/dormant/disqualified`, Client `active/paused/former`, validated transitions | `crates/buzz-core/src/party.rs`, `crates/buzz-sdk/src/party.rs`, `crates/buzz-relay/src/party_broker.rs` |
| Workspace reads/writes | Discovery workspace action/receipt 40021/40022 with the existing `DiscoveryWorkspaceOperation` enum | `crates/buzz-core/src/discovery_workspace.rs`, `crates/buzz-relay/src/discovery_workspace_broker.rs`, `crates/buzz-db/src/discovery_workspace.rs` |
| Lead card in chat | `lead-card` composite Block (30178 catalog, block actions 40010/40011) | `crates/buzz-relay/src/core_blocks/composites/lead-card.json`, `desktop/src/app/routes/newMessageRouteSearch.*` |
| Agent parity | `buzz discovery` CLI subcommands and the `discovery.run` capability | `crates/buzz-cli/src/commands/discovery.rs`, `crates/buzz-cli/src/lib.rs` |
| UI contract | `DiscoveryDataSource`, `LeadsWorkspace`, `LeadTable`, `IndustryGrid`, `VerticalGrid`, discovery route/search surfaces | `desktop/src/features/discovery/*` |

## Phase A: Leads as the default Discovery surface

### A1. Two tabs, empty state, Discover more

`DiscoveryRouteScreen` hosts a top-level tab bar: **Leads** and **Discover**.

- Default search state becomes `surface=leads` (or a new explicit tab value)
  so opening Discovery lands on Leads.
- **Discover** is the existing industries/verticals/campaigns flow; it is
  reachable from the tab and keeps every current addressable surface.
- The Leads tab renders the existing `LeadsWorkspace` global surface. When
  the workspace has zero Leads, it shows an empty state ("No leads yet") with
  a **Discover more** button that routes to `surface=industries`.
- The sidebar Discovery entry still opens Discovery; the two tabs live on the
  Discovery screen itself rather than new sidebar entries, matching the
  requested "2 tabs in discovery".

### A2. Real counts and sorting

Today `RelayDiscoveryDataSource.getIndustries()` returns fixture taxonomy with
fixture counts even in live mode; only campaign `lead_count` is computed from
the database (`list_leads_tx`/`list_campaigns_tx`).

Add one signed workspace operation, `list_lead_counts`, to the existing
`DiscoveryWorkspaceOperation` enum:

- Request: no input beyond the standard request/idempotency envelope, or an
  optional `target_type` (`business`/`individual`) discriminator.
- Receipt: counts per `industry_id`, per `vertical_id`, and per
  `field_id`/`role_id` (People), derived from the retained observation store
  with the same workspace/community scope and entitlement gate as
  `list_leads`.
- Desktop maps these counts onto the `Industry`/`Vertical`/`ProfessionalField`/
  `ProfessionalRole` read models. Live mode uses the op counts; the not-
  entitled demo keeps fixture counts.
- `IndustryGrid` and `VerticalGrid` sort by `leadCount` descending before
  rendering; the counts shown are the op's values, never a hardcoded literal.

No new primitive: this extends the existing workspace action/receipt contract
with one operation, the same way `update_campaign_sources` was added.

## Phase B: Lead details, updates, and Pipeline

### B1. `get_lead`

Extend `DiscoveryWorkspaceOperation` with `GetLead { lead_id }`:

- Returns the full retained Lead projection (the existing `LeadProjection`
  shape) plus its Party relationship state (`party_id`, `relationship status`,
  `owner_persona_id`) when a relationship exists.
- Bounded, idempotent, entitlement-gated, and `p`-gated exactly like
  `get_campaign`.

### B2. `update_lead`

Extend `DiscoveryWorkspaceOperation` with `UpdateLead`:

- Editable Lead data fields: `website`, `email`, `phone`, `linkedin_url`,
  `contact_name`/`contact_title` for People, `score`, `owner_persona_id`, and
  optional free-text notes.
- Status moves are not free-form strings. They go through the Party
  relationship contract: the relay applies `validate_relationship_update` /
  `is_relationship_transition_allowed` and writes a party relationship event
  with the requester's provenance. Allowed Lead transitions already exist:
  `candidate -> accepted|disqualified`, `accepted -> qualified|dormant|
  disqualified`, `qualified -> dormant|disqualified`, `dormant -> qualified|
  disqualified`; `disqualified` is terminal. A "won" Lead becomes a Client
  relationship (`active`) via the party action path.
- Data-field edits are recorded as workspace observation updates with
  provenance (`source=member`, `source=agent:<id>`), preserving the
  observation model's rule that no field exists without a source.
- Same permission and capability model as existing workspace ops; the agent
  capability `discovery.update_lead` gates agent-submitted updates.

### B3. Lead detail UI

- Lead rows/cards become clickable and open a detail panel (drawer), styled
  from the SalesTeams lead detail reference but composed from Colony UI
  primitives.
- Detail shows company/person fields, contacts, source, score, relationship
  status, owner, campaign origin, and provenance; an **Edit** mode posts the
  corresponding `update_lead` request and refreshes from the receipt.
- The route/search model gains an addressable `leadId` surface so a detail
  view is shareable and survives community remounts.

### B4. Pipeline tab

- Add a **Pipeline** tab to the Discovery screen (visible when the workspace
  has Leads or access is live).
- Columns are the Lead relationship statuses: Candidate, Accepted, Qualified,
  Dormant, Disqualified, plus Converted (Client `active`). Cards/counts per
  column come from a bounded `list_leads` filtered by relationship status
  (the status filter already exists in the UI `LeadScope`; the workspace
  list request gains the same optional filter).
- Moving a Lead between columns calls `update_lead` with the target status;
  invalid transitions are rejected by the relay and shown inline.

### B5. CLI and agent parity

Extend `buzz discovery` with:

- `lead-get --lead <id>`
- `lead-update --lead <id> [--website ...] [--status accepted] [--owner ...]`
- `leads-counts [--target-type business|individual]`

Same envelope, same idempotency, same validation as the desktop path. The
Lead Specialist agent uses these commands, so "agent updates leads after
scraping" is the same contract as the human UI.

## Phase C: Mentionable Leads

- Leads are external identities (Parties), not members, so they must not be
  shoehorned into pubkey `p`-tag mentions.
- The existing `lead-card` composite Block is the mention primitive. The
  composer autocomplete (or an attach/mention affordance) inserts a
  `lead-card` Block instance carrying the lead's stable `company_id`, name,
  website, fit summary, score, and relationship status.
- The message renders the Block through the existing block rendering path
  (`newMessageRouteSearch` already routes `lead-card`), and agents resolve
  the block's `company_id`/name to lead details through `buzz discovery
  lead-get`.
- The `lead-card` manifest's status enum is aligned to the Party lifecycle
  vocabulary (`candidate/accepted/qualified/dormant/disqualified`) plus
  `converted` as the card's display for a Client-`active` relationship, so
  the card never shows a status the relationship contract cannot hold. This
  is an evolution of the existing manifest, not a new primitive.

## Deliberately not invented

- No new CRM kind or table: lifecycle lives in `PartyRelationship`.
- No new mention tag family: a Lead mention is a `lead-card` Block.
- No new taxonomy or count store: counts aggregate the retained observation
  store through the workspace contract.
- No new action/receipt kinds: `get_lead`, `update_lead`, and
  `list_lead_counts` are operations on 40021/40022.
- No generic "enrichment" entity: enrichment fields reuse Party identifiers
  and provenance (`IdentifierScheme::Email/Domain/Phone/Linkedin`).

## Data flow

1. Desktop/CLI signs a 40021 workspace action (`get_lead`, `update_lead`, or
   `list_lead_counts`).
2. Relay checks membership, entitlement, capability, and idempotency claim;
   applies the operation; writes the requester-private 40022 receipt.
3. Status changes additionally flow through the party broker: a
   `KIND_PARTY_RELATIONSHIP` event is validated against the previous head,
   written with provenance, and returned in the receipt.
4. Desktop refreshes the read model from the receipt and updates counts.

Errors are the existing contract's errors: invalid field, invalid transition,
not entitled, unknown lead, idempotency conflict. Receipts never contain
provider credentials or raw provider payloads.

## Testing and acceptance gate

- Unit tests for the two new op validators, count aggregation SQL, and the
  relationship transition mapping (reusing party contract tests).
- Deterministic relay tests prove: counts match `list_leads` totals per
  industry/vertical; `update_lead` persists and returns provenance; an
  illegal status transition is refused; a won Lead creates a Client
  relationship; an agent with `discovery.update_lead` succeeds and one
  without it is refused; a `lead-card` block message resolves to the lead.
- Desktop tests cover: default Leads tab, empty state + Discover more route,
  sorting by count, click-through to detail, edit round trip, Pipeline
  columns, and composer insertion of a lead-card Block.
- Gate: all above green, `pnpm check:px-text`, `pnpm typecheck`, `pnpm
  build:e2e`, Playwright screenshots from this worktree, `just ci`, and no
  fixture counts leaking into live mode.

## Decisions and defaults chosen for this spec

- Funnel = Party relationship lifecycle exactly; no `contacted`/`won` strings
  invented. Won = conversion to Client `active`.
- Updates are open to any Discovery-capable member or agent; the owner is
  recorded, not enforced as a gate, in this phase.
- Lead mentions render as `lead-card` Blocks rather than `p`-tag mentions.
- Work lands on `codex/discovery-leads-crm` from current `origin/develop`;
  the staged Discovery-worker work in the `ledger-desktop` worktree stays
  separate unless the owner says otherwise.

## Out of scope (next phases, not invented here)

- Live outreach sending and conversation channels (fixtures exist).
- Enrichment via paid providers and LLM qualification scoring.
- Duplicate merge UI over `merge_parties`.
- Lead groups/segments, notes timeline, and pipeline analytics.
- Client lifecycle UI (Active/Paused/Former) beyond the Converted column.
