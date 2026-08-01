# Discovery Typography Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the cloned Discovery UI with Buzz's existing Inter typography, named Tailwind size tokens, and hierarchy without changing its SalesTeams layout or interaction model.

**Architecture:** Keep the global Buzz font stack as the single source of truth. Replace Discovery-only serif and oversized/bold choices with the existing named sans, heading, body, metadata, and numeric styles already used by Buzz screens.

**Tech Stack:** React, Tailwind CSS, Inter Variable, Playwright smoke tests, pnpm typecheck/build tooling.

---

### Task 1: Normalize Discovery typography

**Files:**
- Modify: `desktop/src/features/discovery/ui/DiscoveryHeader.tsx`
- Modify: `desktop/src/features/discovery/ui/CampaignListView.tsx`
- Modify: `desktop/src/features/discovery/ui/IndustryGrid.tsx`
- Modify: `desktop/src/features/discovery/ui/VerticalGrid.tsx`
- Modify: `desktop/src/features/discovery/ui/CreateCampaignSheet.tsx`

- [ ] **Step 1: Replace Discovery-only display typography**

Use Buzz's Inter stack by removing `font-serif` from the Discovery hero and contextual title. Use `text-title` for the large hero at desktop sizes and `text-3xl` for the contextual title, retaining the existing accent color and italic emphasis without changing layout.

- [ ] **Step 2: Match existing Buzz weight hierarchy**

Use `font-semibold` for campaign drawer titles, metric values, and primary card labels where the cloned screen currently uses `font-bold`. Keep `font-mono` only for numeric/count metadata and preserve `tabular-nums` for metrics.

- [ ] **Step 3: Keep all secondary text on named tokens**

Use the existing `text-sm`, `text-xs`, `text-2xs`, and `text-3xs` tokens for body, helper, metadata, and badge text. Do not add arbitrary text-size literals or a Discovery-specific font family.

### Task 2: Verify typography and responsive behavior

**Files:**
- Test: `desktop/tests/e2e/discovery.spec.ts`

- [ ] **Step 1: Run static gates**

Run `pnpm check:px-text`, `pnpm typecheck`, and `pnpm build:e2e` from `desktop/`; all must pass.

- [ ] **Step 2: Run Discovery browser proof**

Run `pnpm exec playwright test tests/e2e/discovery.spec.ts --project=smoke` from `desktop/`, then inspect the resulting parity screenshots for the Inter stack, heading scale, card labels, and drawer metrics.

- [ ] **Step 3: Verify zoom resilience**

Confirm the Discovery smoke flow still renders without overflow or clipped text at the test viewport, and confirm every changed text size uses a rem-backed named token so Buzz Cmd +/- zoom remains supported.
