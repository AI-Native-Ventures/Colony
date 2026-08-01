# Colony Discovery Engine — Design Specification

**Status:** Design approved; awaiting written-spec review  
**Date:** 2026-08-01  
**Worktree:** `codex/discovery-engine`

## 1. Purpose

Colony is free to use as a company workspace. Discovery is a paid capability
gated by the LAKA subscription entitlement. It gives a company a SalesTeams.ai-
style visual engine for finding prospective businesses and people, while chat
remains the command and orchestration surface.

This phase builds the frontend experience and its typed state contract. It must
look and behave like the supplied SalesTeams screens, but it must be backed by
an executable fixture adapter rather than a static mock or live provider calls.

## 2. Scope

### In scope

- A first-class Discovery workspace with the eight supplied SalesTeams surfaces:
  1. industries grid;
  2. verticals within an industry;
  3. campaign list for a vertical;
  4. campaign creation drawer;
  5. campaign overview;
  6. discovery progress/timeline;
  7. campaign leads table;
  8. global leads workspace.
- SalesTeams-style visual structure, navigation, filters, cards, tables,
  drawers, tabs, progress timeline, and responsive states.
- The source configuration editor: source enable/disable, concurrent versus
  waterfall mode, and waterfall ordering.
- Typed read models and a `DiscoveryDataSource` adapter boundary.
- Fixture-backed event streaming and deterministic state transitions.
- A Colony/LAKA entitlement boundary that can render free, entitled, locked,
  loading, and entitlement-error states without coupling the UI to a billing
  provider.
- An asset registry for industry and vertical imagery, using local checked-in
  assets rather than remote image URLs.

### Out of scope for this phase

- Supabase schema, persistence, realtime subscriptions, or migrations.
- Google Maps, DataForSEO, Brave, Exa, OpenStreetMap, directory, LinkedIn, or
  other provider execution.
- Provider credentials, scraping, enrichment, deduplication, billing charges,
  credit reservation, or actual LAKA checkout.
- CRM lifecycle, clients, outreach delivery, conversations, or accounting.
- Rebuilding the SalesTeams backend or introducing a live dependency on the
  SalesTeams repository.

The adapter is deliberately shaped so those systems can be added later without
redesigning the UI or changing its core state model.

## 3. Product and entitlement boundary

The free Colony workspace can show the Discovery entry point and explain its
value. Starting a discovery run requires the `discovery_engine` LAKA
entitlement. The campaign shell and source configuration can remain visible to
non-subscribers, but paid actions are locked with a clear activation path.

The frontend must not hardcode a price. Pricing, currency, trial status, and
plan names are supplied by an entitlement provider later. The UI consumes a
small provider-neutral contract:

```ts
type DiscoveryEntitlement = {
  feature: 'discovery_engine'
  state: 'loading' | 'entitled' | 'not_entitled' | 'error'
  planName?: string
  manageUrl?: string
}
```

The following states are required:

- **Entitled:** campaign creation and discovery controls are available.
- **Not entitled:** the workspace remains visible, but start/run actions and
  any paid-source action present a clear LAKA upgrade/activation path.
- **Loading:** controls are disabled without flashing a locked state.
- **Error:** the user sees a retry action; the app does not assume access.

Fixtures can force each state. No subscription API or payment redirect is
implemented in this phase.

## 4. Backend-informed UI contract

The SalesTeams backend audit establishes that Discovery is not just a search
box. The UI must preserve these semantics even while execution is fixture-backed.

### Campaign source configuration

```ts
type DiscoverySource =
  | 'google_maps'
  | 'dataforseo'
  | 'brave_search'
  | 'exa_search'
  | 'openstreetmap'
  | 'directories'
  | 'linkedin_company_search'

type CampaignSourceConfig = {
  mode: 'concurrent' | 'waterfall'
  order: DiscoverySource[] // enabled sources, in execution order
  registry?: boolean
}
```

Absence from `order` means disabled. In concurrent mode, enabled sources run
at the same time and order is informational. In waterfall mode, sources run
strictly in `order` and later sources are skipped once the target is reached.
The source editor must communicate this distinction and make drag ordering
available only for enabled waterfall sources.

The fixture adapter must support at least these source-config scenarios:

- default waterfall with several enabled sources;
- concurrent mode;
- a disabled paid source;
- a reordered waterfall;
- malformed/empty config resolved to a safe non-empty default.

### Discovery run state

The runtime model mirrors the audited unified discovery model:

```ts
type DiscoveryPhase =
  | 'initializing'
  | 'sampling'
  | 'evaluating'
  | 'focused_discovery'
  | 'fallback'
  | 'completed'
  | 'failed'

type SourceStatus =
  | 'pending'
  | 'sampling'
  | 'sampled'
  | 'active'
  | 'exhausted'
  | 'failed'
  | 'skipped'
```

Each source exposes discovered, stored, rejected, duplicate, quality,
acceptance, timing, and error fields. A run exposes target, totals, current
source, phase, status, completion, and errors.

The UI event stream must be able to represent session start, source start,
source progress, source completion, source exhaustion, fallback activation,
lead stored/rejected, target reached, completion, cancellation, and failure.
The event stream is simulated locally now; a future realtime/SSE adapter can
feed the same event type.

### Operational states to prove in fixtures

- idle and ready to start;
- running concurrently with multiple active sources;
- running as a waterfall with the next source queued;
- a source unavailable and skipped;
- provider fallback activated;
- target reached before the remaining waterfall sources run;
- completed with results;
- completed below target (partial results);
- cancelled and resumable/restartable;
- failed with a useful retry path.

## 5. Frontend architecture

The feature lives under `desktop/src/features/discovery` and is independent of
SalesTeams runtime code.

### Read model

The feature owns stable UI-facing types for:

`Industry → Vertical → Campaign → DiscoveryRun → Lead`.

The read model includes source configuration, entitlement state, image asset
keys, counts, status labels, and timestamps. It should not expose Supabase row
shapes or provider SDK types.

### Data adapter

```ts
interface DiscoveryDataSource {
  getEntitlement(): Promise<DiscoveryEntitlement>
  getIndustries(): Promise<Industry[]>
  getVertical(industryId: string, verticalId: string): Promise<VerticalDetail>
  getCampaign(campaignId: string): Promise<CampaignDetail>
  getLeads(scope: LeadScope): Promise<LeadPage>
  createCampaign(input: CampaignDraft): Promise<CampaignDetail>
  updateSourceConfig(campaignId: string, config: CampaignSourceConfig): Promise<CampaignDetail>
  startDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>
  cancelDiscovery(campaignId: string): Promise<void>
  retryDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>
}
```

The first implementation is `FixtureDiscoveryDataSource`. It owns deterministic
fixtures and event sequences; no component should branch directly on fixture
data or fake timers. The adapter makes the later Supabase/provider integration
an implementation change instead of a UI rewrite.

### Navigation

Routes must be addressable for every major surface, with campaign context
preserved when switching between the campaign list and the campaign shell. The
campaign shell's navigation must match the supplied reference, including
Overview, Discovery, Leads, Outreach, Conversations, and Settings. Outreach,
Conversations, and Settings are visual shells in this phase; their delivery and
configuration runtimes are separate work. Chat can later invoke these routes
through typed references; this phase does not add the chat command parser.

### Assets

An explicit asset registry maps stable industry/vertical keys to local images.
Cards render registry keys, not arbitrary URLs. Missing assets use a deliberate
neutral fallback and are covered by tests. The supplied screenshots are visual
references; they are not shipped as UI backgrounds.

## 6. Component reuse strategy

We will port/adapt the existing SalesTeams component structure, not redraw the
screens from screenshots and not import the SalesTeams app at runtime.

The primary source components inspected are:

- `/Users/mac/Desktop/Billion/SalesTeams/components/discovery/industry-list-card.tsx`
- `/Users/mac/Desktop/Billion/SalesTeams/components/discovery/vertical-detail-sidebar.tsx`
- `/Users/mac/Desktop/Billion/SalesTeams/components/campaigns/create-discovery-campaign-sheet.tsx`
- `/Users/mac/Desktop/Billion/SalesTeams/components/campaigns/source-config-editor.tsx`
- `/Users/mac/Desktop/Billion/SalesTeams/components/discovery/jen-discovery-interface.tsx`
- `/Users/mac/Desktop/Billion/SalesTeams/components/discovery/jen-feed-item.tsx`
- `/Users/mac/Desktop/Billion/SalesTeams/components/campaigns/campaign-detail-tabs.tsx`
- `/Users/mac/Desktop/Billion/SalesTeams/components/leads/leads-page-client.tsx`

Next.js navigation, React Query/Supabase hooks, provider calls, and SalesTeams
branding are replaced with Colony route wrappers, typed fixtures, local assets,
and Colony design tokens. The interaction and information architecture remain
recognizably the same.

## 7. Testing and acceptance

### Contract tests

- Source config validation, default resolution, enable/disable behavior, and
  waterfall ordering.
- Entitlement state transitions and locked-action behavior.
- Fixture adapter returns complete read models and deterministic event streams.
- Asset registry has an image or deliberate fallback for every referenced key.

### UI tests

- Navigate through all eight parity surfaces.
- Create a campaign in both source modes.
- Toggle sources and reorder waterfall sources.
- Render concurrent, waterfall, fallback, skipped, failed, cancelled, partial,
  and completed states.
- Verify entitled, locked, loading, and entitlement-error states.
- Verify the leads table, global leads view, filters, tabs, drawers, and back
  navigation preserve campaign context.

### Browser proof gate

Before implementation is considered complete, capture browser screenshots of all
eight surfaces plus the source configuration and LAKA-locked states. The gate
requires visual inspection against the supplied SalesTeams references and a
working interaction path through fixtures. Passing typechecks or unit tests
alone is not sufficient proof.

## 8. Release boundaries

This worktree contains the Discovery frontend and its specification only. It
does not change the existing Blocks branch, Colony rebrand branch, relay,
community ownership, Supabase schema, or production subscription configuration.

The next implementation plan should be split into small, reviewable slices:

1. read models, adapter, entitlement contract, and fixtures;
2. asset registry and industries/verticals/campaign-list surfaces;
3. campaign creation and source configuration;
4. campaign detail tabs and discovery event timeline;
5. leads surfaces;
6. parity browser QA and accessibility/visual cleanup.
