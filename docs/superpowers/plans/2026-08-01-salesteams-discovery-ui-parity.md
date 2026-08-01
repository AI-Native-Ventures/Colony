# SalesTeams Discovery UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic Buzz Discovery presentation with a faithful port of the existing SalesTeams discovery catalog, vertical flow, right campaign drawer, and campaign creation drawer while preserving Buzz's fixture data and route adapter.

**Architecture:** Keep Buzz's `DiscoveryDataSource`, route/search state, entitlement, and campaign detail surfaces. Port the source-of-truth visual composition from `/Users/mac/Desktop/Billion/SalesTeams`: editorial header, four-column entity cards, filter/view controls, right-side vertical campaign drawer, and right-side create drawer. Only map Buzz read models into the source component props; do not recreate a new design system.

**Tech Stack:** React 19, Vite, Tailwind CSS v4, Radix dialog primitives, lucide-react, existing Buzz shared UI components, Playwright E2E.

---

### Task 1: Port the catalog header and entity cards

**Files:**
- Modify: `desktop/src/features/discovery/ui/DiscoveryHeader.tsx`
- Modify: `desktop/src/features/discovery/ui/IndustryGrid.tsx`
- Modify: `desktop/src/features/discovery/ui/VerticalGrid.tsx`
- Modify: `desktop/src/features/discovery/ui/DiscoveryWorkspace.tsx`
- Test: `desktop/tests/e2e/discovery.spec.ts`

- [ ] **Step 1: Match the source header structure** — use the source wording, serif headline hierarchy, Businesses/People segmented control, search field with black Search button, and route-specific back/breadcrumb behavior.
- [ ] **Step 2: Match the source card structure** — use the source 108px image banner, Active/Available badge, 16px rounded card, mono metadata row, and four-column responsive grid.
- [ ] **Step 3: Wire existing Buzz read models into the cloned props** — keep current IDs, image keys, campaign counts, lead counts, and click handlers.
- [ ] **Step 4: Run the focused discovery layout tests and build.**
- [ ] **Step 5: Commit the catalog parity change.**

### Task 2: Port the right-side vertical campaign drawer

**Files:**
- Modify: `desktop/src/features/discovery/ui/CampaignListView.tsx`
- Modify: `desktop/src/features/discovery/ui/DiscoveryWorkspace.tsx`
- Modify: `desktop/src/shared/ui/sheet.tsx` only if the existing Radix sheet cannot reproduce the source drawer behavior
- Test: `desktop/tests/e2e/discovery.spec.ts`

- [ ] **Step 1: Replace the full-page two-column campaign layout with a right-side drawer over the catalog.**
- [ ] **Step 2: Match source drawer hierarchy** — image header, industry/vertical label, Campaign and Total Leads stat cards, New Campaign button, campaign cards, location/status pills, and progress bar.
- [ ] **Step 3: Preserve deep-link navigation when a campaign row is opened and preserve the back/close behavior.**
- [ ] **Step 4: Capture the vertical drawer state in the browser and inspect it against the supplied reference.**
- [ ] **Step 5: Commit the campaign drawer parity change.**

### Task 3: Port the source campaign creation drawer

**Files:**
- Modify: `desktop/src/features/discovery/ui/CreateCampaignSheet.tsx`
- Modify: `desktop/src/features/discovery/sourceConfig.ts` only for prop/data mapping required by the source controls
- Test: `desktop/tests/e2e/discovery.spec.ts`

- [ ] **Step 1: Match the source drawer opening state and overlay.**
- [ ] **Step 2: Match the selected vertical card, location chips/input, lead quantity, credit estimate, advanced data sources, and advanced criteria hierarchy.**
- [ ] **Step 3: Keep the Buzz fixture create callback and LAKA entitlement lock behind the cloned UI.**
- [ ] **Step 4: Capture and inspect the campaign creation drawer in the browser.**
- [ ] **Step 5: Commit the campaign creation parity change.**

### Task 4: Prove the complete visual flow

**Files:**
- Modify: `desktop/tests/e2e/discovery.spec.ts`
- Create: `desktop/test-results/discovery-parity/*.png`

- [ ] **Step 1: Capture the Buzz shell with the Discovery sidebar item visible.**
- [ ] **Step 2: Capture industries, verticals, vertical campaign drawer, and create campaign drawer as separate states.**
- [ ] **Step 3: Verify screenshots are visually inspected against the supplied SalesTeams references, not merely hash-distinct.**
- [ ] **Step 4: Run `pnpm build:e2e` and the smoke suite from `desktop`.**
- [ ] **Step 5: Report implemented, browser-proven, and remaining-unproven states separately.**
