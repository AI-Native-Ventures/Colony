# Desktop QoL Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a small sequence of independently mergeable desktop QoL improvements for navigation, threaded messaging, workspace browsing, and agent/workflow recovery.

**Architecture:** Extend existing desktop surfaces instead of creating parallel systems. The current global search dialog becomes a command-capable quick switcher; thread controls reuse the existing persisted read-marker callbacks; browser actions reuse the existing per-channel workspace tab registry; workflow recovery reuses the existing trigger mutation. Each slice gets its own branch and PR to `develop`.

**Tech Stack:** React 19, TypeScript, TanStack Router/Query, Radix UI, Tauri desktop bridge, Playwright smoke tests, Node test-loader unit tests.

---

## Sequence and merge policy

1. **Navigation PR:** command-capable quick switcher with destinations and keyboard hints. Merge before starting PR 2.
2. **Messaging PR:** one-click mark-thread read/unread control in the thread header. Merge before starting PR 3.
3. **Workspace browser PR:** open the first safe HTTP(S) link in a message directly in the current channel's workspace browser. Do not change terminal behavior. Merge before starting PR 4.
4. **Agents/workflows PR:** add a `Run again` action for failed/cancelled workflow runs. Agent access is covered by the navigation destination and existing activity surface; no new agent runtime semantics are introduced.

For every PR: run focused unit/E2E tests, `pnpm typecheck`, `pnpm check`, inspect the diff, push a feature branch, open a PR against `develop`, arm auto-merge, and wait for every required check plus merge-queue result. Never merge a red or pending PR.

---

## PR 1: Command-capable quick switcher

**Files:**
- Modify: `desktop/src/features/search/ui/SearchResultItem.tsx` to add typed navigation-command result ids and icons.
- Modify: `desktop/src/features/search/ui/TopbarSearch.tsx` to accept commands, display them for empty and filtered queries, and invoke them after the dialog closes.
- Modify: `desktop/src/features/sidebar/ui/AppSidebarPinnedHeader.tsx` and `desktop/src/features/sidebar/ui/AppSidebar.tsx` to pass command definitions to the existing search trigger.
- Modify: `desktop/src/app/AppShell.tsx` to provide Home, Agents, Workflows, Projects, Pulse, Settings, and existing create/browse actions, respecting preview feature flags.
- Modify: `desktop/src/shared/lib/keyboard-shortcuts.ts` to describe `⌘K`/`Ctrl+K` as search and navigation.
- Test: `desktop/tests/e2e/navigation-command-palette.spec.ts` covering open, filter, keyboard selection, and route navigation.

- [ ] Add a `SearchCommand` type with stable ids, title, description, and `onSelect` callback. Keep the existing action callbacks working.
- [ ] Add route commands only when their feature is enabled. Keep command invocation keyboard-accessible, with ArrowUp/ArrowDown/Enter and Escape handled by Radix.
- [ ] Preserve current message/channel/user search behavior. A typed query should search both matching commands and relay results; an empty query should show recent conversations followed by commands.
- [ ] Test `⌘K` through the real AppShell listener and verify selecting `Settings` changes the route. Also verify a DM/channel result remains selectable.
- [ ] Run focused tests, commit `feat(desktop): make quick search a command palette`, and ship PR 1.

## PR 2: Thread read-state control

**Files:**
- Modify: `desktop/src/features/messages/ui/MessageThreadPanel.tsx` to add a header action using existing `onMarkRead`/`onMarkUnread` callbacks.
- Test: `desktop/tests/e2e/thread-unread.spec.ts` or a focused new spec covering the header action and label transition.

- [ ] Add a single accessible toggle labelled `Mark thread as read` or `Mark thread as unread` based on the existing root-message unread predicate.
- [ ] Apply the action to the thread root, allowing the existing subtree read-state implementation to update all descendants.
- [ ] Keep huddle transcript behavior unchanged and avoid adding a second read-state store.
- [ ] Prove the control changes the existing UI state in a smoke test, then commit and ship PR 2.

## PR 3: Open message links in the workspace browser

**Files:**
- Create: `desktop/src/features/workspace/lib/openUrlInWorkspace.ts` with HTTP(S) URL extraction/validation and workspace-tab creation.
- Create: `desktop/src/features/workspace/lib/openUrlInWorkspace.test.mjs` covering markdown/plain URLs, punctuation trimming, invalid schemes, and missing web kind.
- Modify: `desktop/src/features/messages/ui/MessageActionBar.tsx` to show `Open in workspace` only for delivered messages with a valid URL, a channel id, and the registered web kind.

- [ ] Extract the first `http://` or `https://` URL, trim common sentence punctuation, and reject credentials/javascript/file/data URLs.
- [ ] Open a `web` tab with the URL, title it from the hostname, and set the channel surface to `workspace`. Return a user-facing failure rather than throwing when the web preview feature is disabled.
- [ ] Do not touch terminal tabs, terminal sessions, or terminal feature flags.
- [ ] Test the pure URL and decision logic, then add/extend a smoke flow with the web-tab feature override and a seeded message. Commit and ship PR 3.

## PR 4: Workflow run recovery

**Files:**
- Modify: `desktop/src/features/workflows/ui/WorkflowDetailPanel.tsx` to expose `Run again` for failed/cancelled runs and keep the selected run visible while triggering.
- Modify: `desktop/src/features/workflows/hooks.ts` only if a small stable helper is needed for retryable statuses.
- Test: `desktop/src/features/workflows/ui/workflowRunRecovery.test.mjs` for retryable statuses and label selection.
- Test: focused workflow E2E if existing fixtures can exercise a failed run without adding relay infrastructure.

- [ ] Treat only `failed` and `cancelled` as retryable. Do not show retry on running, pending, or succeeded runs.
- [ ] Reuse the existing `useTriggerWorkflowMutation`, invalidate the existing workflow-runs query, and select the returned run on success.
- [ ] Show pending and error states through existing mutation feedback. No new backend endpoint or agent execution behavior.
- [ ] Commit and ship PR 4.

## Validation checklist per PR

- [ ] Focused test fails against the unfixed code before implementation.
- [ ] Focused test passes after implementation.
- [ ] `cd desktop && pnpm typecheck` passes.
- [ ] `cd desktop && pnpm check` passes, including file-size and px-text guards.
- [ ] Relevant Playwright smoke test passes using `pnpm test:e2e:smoke` and a fresh `pnpm build:e2e` after code changes.
- [ ] Diff reviewed for unrelated changes and existing untracked user files left untouched.
- [ ] PR targets `develop`, all checks pass, merge queue completes, and branch is confirmed merged before the next slice begins.
