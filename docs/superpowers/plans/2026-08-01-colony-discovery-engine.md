# Colony Discovery Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fixture-backed, SalesTeams.ai-parity Discovery workspace in the Colony desktop app with source orchestration states and a LAKA entitlement boundary, without connecting real providers or Supabase.

**Architecture:** Add a self-contained `features/discovery` module with stable read models, a provider-neutral `DiscoveryDataSource`, deterministic fixtures, and a local async event stream. Add a `/discovery` TanStack Router route with search-addressable surfaces, expose it in the desktop sidebar, and render the eight supplied SalesTeams surfaces plus source configuration and subscription-lock states. Keep all provider, persistence, billing, and chat integration behind the adapter for later work.

**Tech Stack:** React 19, TypeScript, TanStack Router, Radix primitives already present in `desktop/src/shared/ui`, Tailwind tokens, Node test runner with `test-loader.mjs`, and Playwright smoke screenshots.

---

## File map

The implementation is isolated to these new feature files plus the explicit
route/navigation wiring below:

```text
desktop/src/features/discovery/
  types.ts                         # UI read models and state/event unions
  entitlement.ts                   # LAKA entitlement contract and helpers
  sourceConfig.ts                  # source labels, defaults, validation
  assets.ts                        # local industry/vertical image registry
  data/DiscoveryDataSource.ts      # adapter interface
  data/FixtureDiscoveryDataSource.ts
  data/fixtures.ts
  data/fixtureEvents.ts
  data/discoveryData.test.mjs
  ui/DiscoveryRouteScreen.tsx      # route-level data loading and search state
  ui/DiscoveryWorkspace.tsx        # shell and surface switch
  ui/DiscoveryHeader.tsx
  ui/IndustryGrid.tsx
  ui/VerticalGrid.tsx
  ui/CampaignListView.tsx
  ui/CreateCampaignSheet.tsx
  ui/SourceConfigEditor.tsx
  ui/EntitlementLock.tsx
  ui/CampaignDetailView.tsx
  ui/CampaignTabs.tsx
  ui/OverviewTab.tsx
  ui/DiscoveryRunTab.tsx
  ui/DiscoveryTimeline.tsx
  ui/SourceStatusTable.tsx
  ui/LeadsWorkspace.tsx
  ui/LeadTable.tsx
  ui/LeadFilters.tsx
  ui/MetricCard.tsx
  ui/discoveryState.test.mjs
```

Navigation and proof files:

```text
desktop/src/app/routes.ts
desktop/src/app/routes/discovery.tsx
desktop/src/app/AppShell.helpers.ts
desktop/src/app/navigation/useAppNavigation.ts
desktop/src/app/AppShell.tsx
desktop/src/features/sidebar/ui/AppSidebar.tsx
desktop/src/features/sidebar/ui/AppSidebarPinnedHeader.tsx
desktop/public/discovery/industries/*
desktop/public/discovery/verticals/*
desktop/tests/e2e/discovery.spec.ts
desktop/playwright.config.ts
```

The image folders are copied from the inspected SalesTeams assets:
`/Users/mac/Desktop/Billion/SalesTeams/public/images/industries` and
`/Users/mac/Desktop/Billion/SalesTeams/public/verticals`. The registry, not
component code, decides which stable key maps to which local file.

---

### Task 1: Define read models, source configuration, entitlement, and fixtures

**Files:**
- Create: `desktop/src/features/discovery/types.ts`
- Create: `desktop/src/features/discovery/sourceConfig.ts`
- Create: `desktop/src/features/discovery/entitlement.ts`
- Create: `desktop/src/features/discovery/data/DiscoveryDataSource.ts`
- Create: `desktop/src/features/discovery/data/fixtures.ts`
- Create: `desktop/src/features/discovery/data/fixtureEvents.ts`
- Create: `desktop/src/features/discovery/data/FixtureDiscoveryDataSource.ts`
- Test: `desktop/src/features/discovery/data/discoveryData.test.mjs`

- [ ] **Step 1: Write failing contract tests**

Create tests that import the fixture factory through the TypeScript loader and
assert the exact public contract:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixtureDiscoveryDataSource } from "./FixtureDiscoveryDataSource.ts";

test("fixture source returns the SalesTeams-shaped discovery hierarchy", async () => {
  const source = createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  const industries = await source.getIndustries();
  assert.equal(industries.length, 4);
  assert.equal(industries[0].slug, "automotive");
  assert.ok(industries[0].imageKey);
  const vertical = await source.getVertical("automotive", "auto-repair");
  assert.equal(vertical.name, "Auto Repair");
  assert.equal(vertical.campaigns.length, 1);
});

test("entitlement is provider-neutral and does not invent a price", async () => {
  const locked = createFixtureDiscoveryDataSource({ entitlement: "not_entitled" });
  const entitlement = await locked.getEntitlement();
  assert.deepEqual(entitlement, {
    feature: "discovery_engine",
    state: "not_entitled",
    planName: "LAKA",
  });
});

test("waterfall fixture emits ordered source states and target completion", async () => {
  const source = createFixtureDiscoveryDataSource({ scenario: "waterfall-target" });
  const events = [];
  for await (const event of source.startDiscovery("auto-repair-johannesburg")) {
    events.push(event);
  }
  assert.deepEqual(
    events.filter((event) => event.type === "source_started").map((event) => event.source),
    ["google_maps"],
  );
  assert.equal(events.at(-1)?.type, "session_completed");
  assert.equal(events.at(-1)?.targetReached, true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine/desktop
node --import ./test-loader.mjs --experimental-strip-types --test src/features/discovery/data/discoveryData.test.mjs
```

Expected: FAIL because the feature modules do not exist yet.

- [ ] **Step 3: Add the stable read models and adapter interfaces**

Define `Industry`, `Vertical`, `CampaignSummary`, `CampaignDetail`, `Lead`,
`LeadScope`, `LeadPage`, `DiscoveryRun`, `SourceMetric`, `DiscoveryEvent`, and
the entitlement union in `types.ts`. Keep provider/Supabase row types out of
these definitions. Use the exact adapter surface:

```ts
export interface DiscoveryDataSource {
  getEntitlement(): Promise<DiscoveryEntitlement>;
  getIndustries(): Promise<Industry[]>;
  getVertical(industryId: string, verticalId: string): Promise<VerticalDetail>;
  getCampaign(campaignId: string): Promise<CampaignDetail>;
  getLeads(scope: LeadScope): Promise<LeadPage>;
  createCampaign(input: CampaignDraft): Promise<CampaignDetail>;
  updateSourceConfig(campaignId: string, config: CampaignSourceConfig): Promise<CampaignDetail>;
  startDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>;
  cancelDiscovery(campaignId: string): Promise<void>;
  retryDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>;
}
```

- [ ] **Step 4: Implement source config and entitlement helpers**

In `sourceConfig.ts`, export the seven audited sources, labels matching
SalesTeams, the non-empty waterfall default, `isValidSourceConfig`,
`resolveSourceConfig`, and `toggleSource`. `order` is the enabled set; only
waterfall uses its order. In `entitlement.ts`, export `DiscoveryEntitlement`
and `canStartDiscovery` returning `true` only for `state === "entitled"`.

- [ ] **Step 5: Build deterministic fixtures and event sequences**

Create four industries, an Automotive vertical set, the Johannesburg campaign,
the campaign lead rows, and the global lead rows. Use local asset keys such as
`industry.automotive` and `vertical.auto-repair`. Implement fixture scenarios:
`concurrent`, `waterfall-target`, `fallback`, `skipped-source`, `partial`,
`cancelled`, `failed`, and entitlement states `entitled`, `not_entitled`,
`loading`, `error`.

`FixtureDiscoveryDataSource.startDiscovery` must return an `AsyncIterable` that
emits one deterministic event per microtask, never sleeps on wall-clock time,
and stops after `cancelDiscovery` marks the campaign cancelled. Each sequence
must include source status/metrics updates and end with exactly one terminal
event.

- [ ] **Step 6: Run the focused tests and commit**

Run the test command from Step 2 and expect all contract tests to pass. Then
run:

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine/desktop
pnpm typecheck
```

Commit only Task 1:

```bash
git add src/features/discovery
git commit -s -m "feat(discovery): add fixture data and entitlement contract"
```

### Task 2: Add local image registry and addressable Discovery navigation

**Files:**
- Create: `desktop/src/features/discovery/assets.ts`
- Create: `desktop/src/app/routes/discovery.tsx`
- Create: `desktop/src/features/discovery/ui/DiscoveryRouteScreen.tsx`
- Modify: `desktop/src/app/routes.ts`
- Modify: `desktop/src/app/AppShell.helpers.ts`
- Modify: `desktop/src/app/navigation/useAppNavigation.ts`
- Modify: `desktop/src/app/AppShell.tsx`
- Modify: `desktop/src/features/sidebar/ui/AppSidebar.tsx`
- Modify: `desktop/src/features/sidebar/ui/AppSidebarPinnedHeader.tsx`
- Copy: `/Users/mac/Desktop/Billion/SalesTeams/public/images/industries/*` to `desktop/public/discovery/industries/`
- Copy: `/Users/mac/Desktop/Billion/SalesTeams/public/verticals/*` to `desktop/public/discovery/verticals/`
- Test: `desktop/src/app/discoveryNavigation.test.mjs`

- [ ] **Step 1: Write failing navigation tests**

Add pure tests for `deriveShellRoute("/discovery")`, `deriveShellRoute("/discovery?surface=campaign")`, and the navigation builder. Assert the selected view is `"discovery"` and that `goDiscovery` preserves `surface`, `industryId`, `verticalId`, `campaignId`, and `tab` search fields.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine/desktop
node --import ./test-loader.mjs --experimental-strip-types --test src/app/discoveryNavigation.test.mjs
```

Expected: FAIL because the route and navigation types do not include Discovery.

- [ ] **Step 3: Add the route and route-level screen**

Register `route("/discovery", "discovery.tsx")` in `desktop/src/app/routes.ts`.
The route validates this search shape:

```ts
type DiscoverySearch = {
  surface?: "industries" | "verticals" | "campaigns" | "campaign" | "leads";
  industryId?: string;
  verticalId?: string;
  campaignId?: string;
  tab?: "overview" | "discovery" | "leads" | "outreach" | "conversations" | "settings";
};
```

`DiscoveryRouteScreen` creates one `FixtureDiscoveryDataSource`, loads the
entitlement and route-selected read model, and passes both to
`DiscoveryWorkspace`. It does not call Supabase, fetch a URL, or put fixture
branches in route code.

- [ ] **Step 4: Wire sidebar selection and route derivation**

Add `"discovery"` to `AppView` and sidebar selected-view unions. Add
`goDiscovery(options?: { surface?: string; industryId?: string; verticalId?: string; campaignId?: string; tab?: string })` to `useAppNavigation`. Add a visible Discovery menu item with `data-testid="open-discovery-view"` and a compass/search icon. Pass the callback through `AppShell` and `AppSidebar` without changing existing menu order or behavior.

- [ ] **Step 5: Copy assets and add registry**

Copy the inspected industry and vertical files into `desktop/public/discovery`.
`assets.ts` exports a complete map for every fixture key and a neutral fallback:

```ts
export const DISCOVERY_ASSETS = {
  "industry.automotive": "/discovery/industries/automotive.png",
  "industry.professional-services": "/discovery/industries/professional-services.png",
  "industry.agriculture": "/discovery/industries/agriculture.png",
  "industry.aviation-airlines": "/discovery/industries/aviation-airlines.png",
  "vertical.auto-repair": "/discovery/verticals/auto-repair.png",
} as const;

export function resolveDiscoveryAsset(key: string): string {
  return DISCOVERY_ASSETS[key as keyof typeof DISCOVERY_ASSETS] ?? "/discovery/industries/automotive.png";
}
```

- [ ] **Step 6: Run tests and commit**

Run the focused navigation test and `pnpm typecheck`. Commit:

```bash
git add src/app/routes.ts src/app/routes/discovery.tsx src/app/AppShell.helpers.ts src/app/navigation/useAppNavigation.ts src/app/AppShell.tsx src/features/sidebar/ui/AppSidebar.tsx src/features/sidebar/ui/AppSidebarPinnedHeader.tsx src/features/discovery/assets.ts public/discovery src/app/discoveryNavigation.test.mjs
git commit -s -m "feat(discovery): add route, sidebar entry, and local assets"
```

### Task 3: Implement the industries, verticals, and campaign-list surfaces

**Files:**
- Create: `desktop/src/features/discovery/ui/DiscoveryWorkspace.tsx`
- Create: `desktop/src/features/discovery/ui/DiscoveryHeader.tsx`
- Create: `desktop/src/features/discovery/ui/IndustryGrid.tsx`
- Create: `desktop/src/features/discovery/ui/VerticalGrid.tsx`
- Create: `desktop/src/features/discovery/ui/CampaignListView.tsx`
- Create: `desktop/src/features/discovery/ui/MetricCard.tsx`
- Create: `desktop/src/features/discovery/ui/discoveryLayout.ts`
- Test: `desktop/src/features/discovery/ui/discoveryLayout.test.mjs`

- [ ] **Step 1: Write layout and navigation tests**

Test that selecting an industry produces `surface=verticals`, selecting a
vertical produces `surface=campaigns`, and selecting a campaign produces
`surface=campaign` with the campaign id. Test that the campaign-list surface
renders the campaign card before campaign details are opened.

- [ ] **Step 2: Implement the shared workspace shell**

Use Colony tokens and existing primitives (`Card`, `Button`, `Input`, `Tabs`),
not screenshot-specific absolute positioning. `DiscoveryHeader` includes the
Businesses/People switch, search field, filter chips, and the page title/count
from the supplied references. Keep the People mode as a visible disabled/soon
state backed by the same route search field; do not invent an individual-lead
backend in this phase.

- [ ] **Step 3: Implement the industry grid**

Render the fixture industries as image cards with active/available status,
vertical count, lead count, keyboard focus, and a deterministic empty state.
Use `resolveDiscoveryAsset` for every image and provide `alt` text from the
industry name. Cards must be selectable with Enter/Space and expose
`data-testid="discovery-industry-card-${slug}"`.

- [ ] **Step 4: Implement verticals and the campaign list**

Render the selected industry's vertical cards with image, campaign count, and
lead count. The vertical detail surface must show the right-hand campaign list
drawer/sidebar before a user enters campaign details, matching the supplied
third screenshot. Campaign cards expose status, location, target, progress, and
an explicit `Open campaign` action.

- [ ] **Step 5: Run focused tests and commit**

Run the feature tests and `pnpm check:px-text` to ensure no arbitrary text sizes
are introduced. Commit:

```bash
git add src/features/discovery/ui
git commit -s -m "feat(discovery): add industry vertical and campaign surfaces"
```

### Task 4: Implement campaign creation, source configuration, and LAKA lock states

**Files:**
- Create: `desktop/src/features/discovery/ui/CreateCampaignSheet.tsx`
- Create: `desktop/src/features/discovery/ui/SourceConfigEditor.tsx`
- Create: `desktop/src/features/discovery/ui/EntitlementLock.tsx`
- Create: `desktop/src/features/discovery/sourceConfig.test.mjs`
- Modify: `desktop/src/features/discovery/ui/DiscoveryWorkspace.tsx`

- [ ] **Step 1: Write failing source-config tests**

Cover the audited behavior:

```js
test("waterfall toggles and reorders enabled sources only", () => {
  const initial = { mode: "waterfall", order: ["google_maps", "brave_search"] };
  assert.deepEqual(toggleSource(initial, "directories"), {
    mode: "waterfall",
    order: ["google_maps", "brave_search", "directories"],
  });
  assert.deepEqual(moveSource(initial, "brave_search", "google_maps"), {
    mode: "waterfall",
    order: ["brave_search", "google_maps"],
  });
});

test("concurrent mode disables drag ordering but keeps source toggles", () => {
  assert.equal(canReorderSources({ mode: "concurrent", order: ["google_maps"] }), false);
});
```

Also test an `not_entitled` entitlement disables the Run Discovery action and
opens an accessible LAKA activation dialog when clicked.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine/desktop
node --import ./test-loader.mjs --experimental-strip-types --test src/features/discovery/sourceConfig.test.mjs
```

Expected: FAIL because the editor helpers and components do not exist.

- [ ] **Step 3: Implement the source editor**

Use `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities` already in
`desktop/package.json`. Render the exact audited source labels, enabled rows
first, disabled rows afterward, a Concurrent/Waterfall toggle, and explanatory
copy. Only enabled waterfall rows receive drag handles. Persist changes through
`DiscoveryDataSource.updateSourceConfig`; fixtures update immediately.

- [ ] **Step 4: Implement the campaign drawer**

Use the existing shared `Sheet`, `Input`, `Button`, `Tabs`, and `Switch`
primitives. Reproduce the supplied flow: selected vertical, location chips,
lead quantity, estimated-credit placeholder, Advanced Data Sources, and
Advanced Criteria. The estimated cost is display-only fixture data and must not
claim to reserve or charge credits. Submit calls `createCampaign` and navigates
to the campaign list/detail surface.

- [ ] **Step 5: Implement entitlement lock UI**

`EntitlementLock` renders the workspace behind a lock overlay only for the
action that requires access. It must expose `role="dialog"` when opened, a
keyboard-close button, the `LAKA` plan label, and no hardcoded dollar amount.
Loading and entitlement-error states remain distinct from not-entitled.

- [ ] **Step 6: Run tests and commit**

Run the focused tests, `pnpm typecheck`, and `pnpm check`. Commit:

```bash
git add src/features/discovery
git commit -s -m "feat(discovery): add campaign setup and source controls"
```

### Task 5: Implement campaign detail tabs and the discovery event timeline

**Files:**
- Create: `desktop/src/features/discovery/ui/CampaignDetailView.tsx`
- Create: `desktop/src/features/discovery/ui/CampaignTabs.tsx`
- Create: `desktop/src/features/discovery/ui/OverviewTab.tsx`
- Create: `desktop/src/features/discovery/ui/DiscoveryRunTab.tsx`
- Create: `desktop/src/features/discovery/ui/DiscoveryTimeline.tsx`
- Create: `desktop/src/features/discovery/ui/SourceStatusTable.tsx`
- Create: `desktop/src/features/discovery/useDiscoveryRun.ts`
- Create: `desktop/src/features/discovery/ui/discoveryState.test.mjs`
- Modify: `desktop/src/features/discovery/ui/DiscoveryWorkspace.tsx`

- [ ] **Step 1: Write failing reducer/state tests**

Test that applying events updates phase, active source, source metrics, totals,
and terminal status without losing prior events. Include target reached,
fallback, skipped, failed, cancelled, and partial completion sequences.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine/desktop
node --import ./test-loader.mjs --experimental-strip-types --test src/features/discovery/ui/discoveryState.test.mjs
```

Expected: FAIL because the reducer/hook does not exist.

- [ ] **Step 3: Implement the event reducer and run hook**

`useDiscoveryRun` owns the `DiscoveryRun` state, subscribes to the adapter's
async iterable on Start/Retry, calls `cancelDiscovery` on Cancel, and ignores
events after a terminal state. The reducer must map source events to
`SourceMetric.status` and preserve the ordered timeline for rendering.

- [ ] **Step 4: Implement the campaign shell and tabs**

Match the supplied campaign navigation: Overview, Discovery, Leads, Outreach,
Conversations, Settings. Only Overview, Discovery, and Leads are functional;
the other three render a clear view-only shell with no fake delivery controls.
The header includes campaign name, industry/vertical, status, and Run Discovery.

- [ ] **Step 5: Implement Overview and Discovery tabs**

Overview renders Total Leads, Emails Sent, Drafts Ready, and Scheduled cards
from fixture metrics. Discovery renders the Jen-style hero, New/Total stats,
active source chips, timeline feed, source status table, Start/Find More/Start
Over/Retry/Cancel actions, and partial/failure copy. All actions respect the
LAKA entitlement before calling the adapter.

- [ ] **Step 6: Run tests and commit**

Run the reducer tests, `pnpm typecheck`, and `pnpm check`. Commit:

```bash
git add src/features/discovery
git commit -s -m "feat(discovery): add campaign tabs and streaming run states"
```

### Task 6: Implement campaign and global leads surfaces

**Files:**
- Create: `desktop/src/features/discovery/ui/LeadsWorkspace.tsx`
- Create: `desktop/src/features/discovery/ui/LeadTable.tsx`
- Create: `desktop/src/features/discovery/ui/LeadFilters.tsx`
- Create: `desktop/src/features/discovery/ui/LeadsStats.tsx`
- Modify: `desktop/src/features/discovery/ui/CampaignDetailView.tsx`
- Modify: `desktop/src/features/discovery/ui/DiscoveryWorkspace.tsx`
- Test: `desktop/src/features/discovery/ui/leadsWorkspace.test.mjs`

- [ ] **Step 1: Write failing lead filtering tests**

Test company/person mode selection, text search, industry/location/status
filters, owner filter, and stable row ordering against `getLeads` fixture data.
Assert that the campaign lead table and global lead workspace use the same
columns as the supplied references: company, location, source, contacts,
owner/score, added, and status.

- [ ] **Step 2: Run tests and verify failure**

Run the focused test with the Node test command used in earlier tasks and expect
failure because the view/filter helpers do not exist.

- [ ] **Step 3: Implement campaign leads**

Render the campaign summary row (companies found, contacts, emails, missing
websites), search/actions row, Quality/Status/Channels filters, list/grid
toggle, and lead table. Use accessible table headers and status badges. Export,
deduplicate, find-websites, and add-lead actions are explicit fixture no-op
states with explanatory feedback rather than fake provider work.

- [ ] **Step 4: Implement global leads**

Render the global Leads page with Groups, Export, New Campaign, Companies/People
toggle, search/filter row, summary metric cards, owner filter, and the full
table. Keep the supplied screenshot's empty/new/enriched status language.

- [ ] **Step 5: Run tests and commit**

Run focused tests, `pnpm typecheck`, and `pnpm check`. Commit:

```bash
git add src/features/discovery
git commit -s -m "feat(discovery): add campaign and global lead workspaces"
```

### Task 7: Add parity browser proof, screenshots, and release checks

**Files:**
- Create: `desktop/tests/e2e/discovery.spec.ts`
- Modify: `desktop/playwright.config.ts`
- Modify: `desktop/src/features/discovery/ui/*` only where browser proof finds a defect

- [ ] **Step 1: Write the E2E flow**

Use `installMockBridge` and the existing onboarding helpers. Navigate through
the Discovery sidebar entry and capture distinct screenshots for:

```ts
const SCREENSHOTS = [
  "discovery-industries.png",
  "discovery-verticals.png",
  "discovery-campaign-list.png",
  "discovery-campaign-drawer.png",
  "discovery-overview.png",
  "discovery-progress.png",
  "discovery-campaign-leads.png",
  "discovery-global-leads.png",
  "discovery-source-config.png",
  "discovery-laka-locked.png",
] as const;
```

Use `waitForAnimations(page)` before every screenshot. Scope screenshots to the
relevant workspace or sheet so states cannot accidentally produce identical
full-window images. Assert the hashes are distinct, following the existing
`blocks.spec.ts` pattern.

- [ ] **Step 2: Add the spec to the smoke project**

Add `"**/discovery.spec.ts"` to the `smoke.testMatch` list in
`desktop/playwright.config.ts`. Do not add it to integration because this flow
uses only the fixture adapter and mock bridge.

- [ ] **Step 3: Run the complete proof gate**

Run:

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/discovery-engine/desktop
pnpm test -- src/features/discovery/data/discoveryData.test.mjs src/features/discovery/sourceConfig.test.mjs src/features/discovery/ui/discoveryState.test.mjs
pnpm check
pnpm test:e2e:smoke -- discovery.spec.ts
```

Inspect all ten screenshots against the supplied SalesTeams parity references.
Fix only defects found in this flow, re-run the focused checks, and verify that
the app renders without console/page errors.

- [ ] **Step 4: Commit the proof**

```bash
git add tests/e2e/discovery.spec.ts playwright.config.ts src/features/discovery
git commit -s -m "test(discovery): add SalesTeams parity browser proof"
```

---

## Plan self-review

- **Spec coverage:** entitlement, source config, concurrent/waterfall behavior,
  runtime phases, source metrics, event streaming, all eight supplied surfaces,
  local imagery, route addressability, and browser proof each have a task.
- **Scope check:** no task adds Supabase, provider SDKs, billing checkout,
  enrichment, CRM lifecycle, outreach delivery, or chat parsing.
- **Type consistency:** `DiscoveryDataSource`, `DiscoveryEntitlement`,
  `CampaignSourceConfig`, `DiscoveryEvent`, and `DiscoveryRun` are defined in
  Task 1 and consumed unchanged in later tasks.
- **Placeholder scan:** the plan contains no unfinished placeholder steps;
  intentionally view-only surfaces and fixture no-op actions are explicitly
  described as such.
- **Release proof:** typecheck, lint/format guards, focused tests, smoke E2E,
  screenshot distinctness, and visual inspection are separate gates.
