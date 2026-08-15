# Native Action Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native global Action Center where users can inspect and act on open asks, actionable messages, reminders, durable tasks, and supported workflow items without losing canonical thread or workspace context.

**Architecture:** Add a route-backed Action Center projection over existing source systems. The first slice ships the shell, asks, messages, and reminders. The second adds a bounded, signature-validated global durable-task projection and task/workspace actions. The final slice adds workflow capability adapters only for real backend records, live refresh, badge counts, and accessibility/performance hardening. Source records stay canonical; Action Center stores no duplicate tasks or asks.

**Tech Stack:** React 19, TypeScript, TanStack Router/Query, existing Nostr relay client, Tauri workflow APIs, Radix UI primitives, Biome, Node test-loader unit tests, Playwright smoke tests.

---

## File map

### New files

- `desktop/src/app/routes/action-center.tsx`: validated `/action-center` route and screen entry point.
- `desktop/src/features/action-center/contracts.ts`: stable item ids, discriminated source/capability types, and public query result types.
- `desktop/src/features/action-center/actionCenterModel.ts`: pure projection, deduplication, sorting, filtering, and status helpers.
- `desktop/src/features/action-center/actionCenterModel.test.mjs`: unit coverage for projection, filtering, deduplication, and stable ids.
- `desktop/src/features/action-center/useActionCenterItems.ts`: source query composition and community-scoped React Query state.
- `desktop/src/features/action-center/lib/actionCenterNavigation.ts`: safe source-destination and canonical thread helpers.
- `desktop/src/features/action-center/ui/ActionCenterScreen.tsx`: page-level responsive layout, filters, selection, loading/error states.
- `desktop/src/features/action-center/ui/ActionCenterList.tsx`: grouped virtualizable-ready list boundary and row selection.
- `desktop/src/features/action-center/ui/ActionCenterRow.tsx`: one accessible row and compact action affordances.
- `desktop/src/features/action-center/ui/ActionCenterDetail.tsx`: source-kind detail dispatcher and empty/unavailable details.
- `desktop/src/features/action-center/ui/ActionCenterMessageDetail.tsx`: message/agent-update detail with open-source and mark-done actions.
- `desktop/src/features/action-center/ui/ActionCenterAskDetail.tsx`: ask answer surface using `AskDetailCard` and source-thread link.
- `desktop/src/features/action-center/ui/ActionCenterReminderDetail.tsx`: reminder detail wrapper and source actions.
- `desktop/src/features/company/taskRunRepository.test.mjs`: global task-run parsing/collapse tests.
- `desktop/tests/e2e/action-center.spec.ts`: seeded asks, reminders, messages, task state, deep links, and action feedback.

### Modified files, slice 1

- `desktop/src/app/AppShell.helpers.ts`: add `action-center` to the shell view union and route derivation.
- `desktop/src/app/navigation/useAppNavigation.ts`: add stable `goActionCenter` navigation with validated item/filter options.
- `desktop/src/app/navigation/navigationCommands.ts`: expose Action Center through the existing command palette.
- `desktop/src/app/AppShell.tsx`: wire Action Center navigation, sidebar badge query, and `AppSidebar` props.
- `desktop/src/features/sidebar/types.ts`: add the action-center selected view.
- `desktop/src/features/sidebar/ui/AppSidebar.tsx`: pass the Action Center callback/count through the sidebar.
- `desktop/src/features/sidebar/ui/AppSidebarPinnedHeader.tsx`: add the primary-menu item and accessible badge.
- `desktop/src/features/asks/lib/askEvent.ts`: retain optional source tags on parsed asks.
- `desktop/src/features/home/ui/InboxDetailPane.tsx`: extract the existing answer-event write into a shared ask answer helper without changing the Home surface.
- `desktop/src/app/routeTree.gen.ts`: regenerate through the repository's TanStack route generator, never hand-edit the generated structure.

### Modified files, slice 2

- `desktop/src/features/company/taskRunRepository.ts`: add bounded global Job-head read and generation-safe result type.
- `desktop/src/features/company/taskRunContracts.ts`: add raw-head context extraction and multi-run collapse helper.
- `desktop/src/features/company/taskThreadModel.ts`: expose a shared task-status projection for rows and details.
- `desktop/src/features/company/taskRunRepository.test.mjs`: test malformed, cross-context, duplicate, and terminal heads.
- `desktop/src/features/action-center/useActionCenterItems.ts`: join company tasks and current runs without N+1 detail queries.
- `desktop/src/features/action-center/ui/ActionCenterTaskDetail.tsx`: task status, checkpoint, artifact, canonical thread, and workspace actions.
- `desktop/src/features/action-center/ui/ActionCenterDetail.tsx`: dispatch task items.
- `desktop/src/testing/e2eBridge.ts`: deterministic Action Center task seeds and task-run query responses.
- `desktop/tests/helpers/bridge.ts`: expose task seed/query controls used by the E2E spec.

### Modified files, slice 3

- `desktop/src/features/action-center/useActionCenterItems.ts`: add supported workflow records and source dedupe.
- `desktop/src/features/action-center/ui/ActionCenterWorkflowDetail.tsx`: approve/deny or Run again only when capability data is present.
- `desktop/src/features/workflows/hooks.ts`: export/invalidate the existing query keys needed by the Action Center.
- `desktop/src/app/useLiveHomeFeedActions.ts`: invalidate the Action Center projection when source kinds arrive if query composition requires an explicit signal.
- `desktop/src/app/AppShell.tsx`: add final aggregate badge count without double-counting Home/reminders.
- `desktop/tests/e2e/action-center.spec.ts`: workflow action and realtime refresh coverage.

---

## Slice 1: Native shell, asks, messages, and reminders

### Task 1: Add pure contracts and projection tests

**Files:**
- Create: `desktop/src/features/action-center/contracts.ts`
- Create: `desktop/src/features/action-center/actionCenterModel.ts`
- Test: `desktop/src/features/action-center/actionCenterModel.test.mjs`

- [ ] **Step 1: Write failing projection tests**

Add Node test-loader tests that import the model and assert:

```js
const ask = {
  id: "ask-1",
  askType: "decision",
  headline: "Approve the launch brief",
  costOfDelay: "Launch slips one day",
  filerPubkey: "a".repeat(64),
  createdAt: 100,
  rawContent: "{}",
};

const items = buildActionCenterItems({
  asks: [ask],
  feed: {
    mentions: [message("message-1", 200)],
    needsAction: [message("approval-1", 300)],
    activity: [],
    agentActivity: [],
  },
  reminders: [reminder("reminder-1", 250)],
});

assert.deepEqual(items.map((item) => item.id), [
  "approval-1",
  "reminder:reminder-1",
  "ask:ask-1",
  "message:message-1",
]);
assert.equal(filterActionCenterItems(items, "asks").length, 1);
assert.equal(filterActionCenterItems(items, "needs-action").every((item) => item.state === "needs-action"), true);
```

Also test that a structured reminder/ask id is not duplicated by an equivalent feed event, malformed source records are skipped, and equal timestamps use stable id order.

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `desktop`:

```bash
pnpm exec node --import ./test-loader.mjs --experimental-strip-types --test src/features/action-center/actionCenterModel.test.mjs
```

Expected: FAIL because the model and contracts do not exist.

- [ ] **Step 3: Implement the minimal projection**

Define `ActionCenterFilter`, `ActionItemKind`, `ActionItemState`, `ActionSource`, and `ActionItem` in `contracts.ts`. Implement pure helpers in `actionCenterModel.ts`:

```ts
export function actionItemId(kind: ActionItemKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

const FILTER_KIND: Record<Exclude<ActionCenterFilter, "all" | "needs-action">, ActionItemKind> = {
  asks: "ask",
  tasks: "task",
  messages: "message",
  reminders: "reminder",
  workflows: "workflow",
};

export function filterActionCenterItems(
  items: readonly ActionItem[],
  filter: ActionCenterFilter,
): ActionItem[] {
  if (filter === "all") return [...items];
  if (filter === "needs-action") {
    return items.filter((item) => item.state === "needs-action" || item.state === "failed");
  }
  return items.filter((item) => item.kind === FILTER_KIND[filter]);
}
```

Keep source capabilities declarative, for example `"answer"`, `"open-source"`, `"mark-done"`, `"complete"`, `"snooze"`, and `"cancel"`. Do not place React callbacks in the model.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same command. Expected: PASS with all projection assertions.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/action-center
git commit -s -m "feat(desktop): add action center projection model"
```

### Task 2: Reuse ask source data and answer mutation

**Files:**
- Modify: `desktop/src/features/asks/lib/askEvent.ts`
- Create: `desktop/src/features/asks/answerAsk.ts`
- Modify: `desktop/src/features/home/ui/InboxDetailPane.tsx`
- Test: `desktop/src/features/asks/answerAsk.test.mjs`
- Test: `desktop/src/features/action-center/actionCenterModel.test.mjs`

- [ ] **Step 1: Write the failing helper test**

Test that `answerAsk` signs/publishes a `KIND_ASK_RESOLUTION` event with exactly one `e` tag, invalidates `open-asks` and `open-ask-closures`, and surfaces publish errors. Inject `signRelayEvent`, `publishEvent`, and `invalidateQueries` dependencies so the test does not touch the relay.

- [ ] **Step 2: Run it and verify failure**

```bash
pnpm exec node --import ./test-loader.mjs --experimental-strip-types --test src/features/asks/answerAsk.test.mjs
```

Expected: FAIL because the helper is absent.

- [ ] **Step 3: Implement the shared answer helper**

Move the existing `InboxDetailPane` event-writing body into `answerAsk.ts`, preserving the exact event shape and error messages. Export `answerAsk(ask, decision, rationale, dependencies)` with injected `signRelayEvent`, `publishEvent`, and `invalidateQueries` dependencies. Update `InboxDetailPane` to call the helper, keeping its current UI and test ids unchanged.

Extend `OpenAsk` with optional `channelId` and `threadId` derived only from valid `h` and `e` tags. Channel-less asks remain valid.

- [ ] **Step 4: Run ask tests and Home regression tests**

```bash
pnpm exec node --import ./test-loader.mjs --experimental-strip-types --test src/features/asks/answerAsk.test.mjs src/features/home/inboxSystemMessages.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/asks desktop/src/features/home/ui/InboxDetailPane.tsx
git commit -s -m "refactor(desktop): share ask answer mutation"
```

### Task 3: Compose source queries and build the Action Center screen

**Files:**
- Create: `desktop/src/features/action-center/useActionCenterItems.ts`
- Create: `desktop/src/features/action-center/lib/actionCenterNavigation.ts`
- Create: `desktop/src/features/action-center/ui/ActionCenterScreen.tsx`
- Create: `desktop/src/features/action-center/ui/ActionCenterList.tsx`
- Create: `desktop/src/features/action-center/ui/ActionCenterRow.tsx`
- Create: `desktop/src/features/action-center/ui/ActionCenterDetail.tsx`
- Create: `desktop/src/features/action-center/ui/ActionCenterMessageDetail.tsx`
- Create: `desktop/src/features/action-center/ui/ActionCenterAskDetail.tsx`
- Create: `desktop/src/features/action-center/ui/ActionCenterReminderDetail.tsx`

- [ ] **Step 1: Add query composition tests**

Extend the model tests with ask, feed, and reminder fixtures. Assert structured sources are deduplicated, item ids are stable, and message source links derive the thread root from NIP-10 tags.

- [ ] **Step 2: Implement `useActionCenterItems`**

Read `useHomeFeedQuery`, `useOpenAsks`, `useRemindersQuery`, `useChannelsQuery`, and `useIdentityQuery` in parallel. Use `useAppShell().feedItemState` and read-state methods when projecting message items. Return `{ items, isLoading, error, refetch, openCount }`, with `openCount` limited to default-view actionable items.

Do not create a second feed query or second local done/read store.

- [ ] **Step 3: Implement source navigation helpers**

Implement a helper that returns a destination only when `channelId` is non-empty and the event id is valid. For a thread, call the existing navigation with `messageId` and `threadRootId`; for a non-thread message, open the message event. Return a user-readable unsupported message for channel-less items.

- [ ] **Step 4: Implement list and row UI**

Use `TopChromeInsetHeader`, existing `Badge`, `Button`, `Tabs`, and muted-border card styles. Group rows by state, make each row a keyboard-focusable button, and keep row action buttons separately focusable with accessible labels. Use stable `item.id` keys. Do not add arbitrary text-size literals.

- [ ] **Step 5: Implement detail dispatchers**

`ActionCenterAskDetail` renders `AskDetailCard`, answer loading/error state, and an `Open source thread` button when available. `ActionCenterMessageDetail` renders message metadata, source preview, `Open thread`, and `Mark done`/`Undo done`. `ActionCenterReminderDetail` delegates to the existing `ReminderDetailPane` so complete/snooze/cancel behavior stays canonical. The dispatcher renders an unavailable state if a source disappears.

- [ ] **Step 6: Run typecheck and focused tests**

```bash
pnpm typecheck
pnpm exec node --import ./test-loader.mjs --experimental-strip-types --test src/features/action-center/*.test.mjs src/features/asks/answerAsk.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/features/action-center
git commit -s -m "feat(desktop): add actionable inbox center"
```

### Task 4: Register route, navigation, sidebar, and command palette

**Files:**
- Create: `desktop/src/app/routes/action-center.tsx`
- Modify: `desktop/src/app/AppShell.helpers.ts`
- Modify: `desktop/src/app/navigation/useAppNavigation.ts`
- Modify: `desktop/src/app/navigation/navigationCommands.ts`
- Modify: `desktop/src/app/AppShell.tsx`
- Modify: `desktop/src/features/sidebar/types.ts`
- Modify: `desktop/src/features/sidebar/ui/AppSidebar.tsx`
- Modify: `desktop/src/features/sidebar/ui/AppSidebarPinnedHeader.tsx`
- Regenerate: `desktop/src/app/routeTree.gen.ts`

- [ ] **Step 1: Add navigation unit tests**

Extend `navigationCommands.test.mjs` to assert the Action Center command is present, selecting it calls `goActionCenter`, and the shell route derives `selectedView: "action-center"` for `/action-center`.

- [ ] **Step 2: Implement route and navigation**

Add `goActionCenter(options?: { filter?: ActionCenterFilter; item?: string; replace?: boolean })` using `commitNavigation`. Validate search values in the route and render `ActionCenterScreen`.

Pass `actionCenterBadgeCount`, `onSelectActionCenter`, and `selectedView` through the existing sidebar interfaces. Use the `ListChecks` or `Inbox`-adjacent Lucide icon that matches the existing product language, and show at most `99` in the badge.

Add `goActionCenter` to the existing `useNavigationCommands` targets. Do not alter the existing Home shortcut semantics; Action Center is reachable from the sidebar and command palette in this slice.

- [ ] **Step 3: Regenerate and run route/type tests**

From `desktop` run the repository's route generation command if available, then:

```bash
pnpm typecheck
pnpm exec node --import ./test-loader.mjs --experimental-strip-types --test src/app/navigation/navigationCommands.test.mjs
```

Expected: PASS and the generated route tree includes `/action-center`.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/app desktop/src/features/sidebar
 git commit -s -m "feat(desktop): add action center navigation"
```

### Task 5: Seed and test the first real E2E flow

**Files:**
- Modify: `desktop/src/testing/e2eBridge.ts`
- Modify: `desktop/tests/helpers/bridge.ts`
- Create: `desktop/tests/e2e/action-center.spec.ts`

- [ ] **Step 1: Add deterministic fixtures**

Seed one open ask, one actionable channel message, one pending reminder targeting a message, and one empty-state configuration. The bridge must record ask-resolution publication, reminder completion/snooze/cancel, and navigation calls. Use existing mock channels and identity constants.

- [ ] **Step 2: Write E2E assertions**

Cover:

1. Sidebar Action Center entry and badge.
2. Route opens with `Needs action` default.
3. Selecting an ask shows `AskDetailCard` and answering removes it.
4. Selecting a message opens its canonical channel/thread.
5. Selecting a reminder exposes complete/snooze/cancel and source navigation.
6. Direct reload with `?item=` restores selection.
7. Empty and partial-error states are readable.
8. Narrow viewport provides Back navigation.

Call `waitForAnimations(page)` before every screenshot and scope screenshots to the relevant pane. Hash all captures and require distinct states.

- [ ] **Step 3: Prove the E2E fails before implementation, then run it**

```bash
pnpm test:e2e:smoke -- action-center.spec.ts
```

Expected pre-implementation failure: route/test ids are absent. After implementation, expected PASS.

- [ ] **Step 4: Run quality checks and commit**

```bash
pnpm typecheck
pnpm check
pnpm build:e2e
pnpm exec playwright test --project=smoke tests/e2e/action-center.spec.ts
```

```bash
git add desktop/src/testing/e2eBridge.ts desktop/tests/helpers/bridge.ts desktop/tests/e2e/action-center.spec.ts
git commit -s -m "test(desktop): cover action center workflows"
```

### Task 6: Review and ship slice 1

- [ ] Inspect `git diff origin/develop...HEAD` for unrelated changes, duplicate data stores, unsupported actions, arbitrary text sizing, and route typing mistakes.
- [ ] Run `just desktop-tauri-fmt` from the main checkout if the worktree pre-commit hook exposes the known Tauri worktree path issue. Re-stage only intended files.
- [ ] Push `feat/action-center`, open a PR targeting `develop`, and arm auto-merge with the merge queue.
- [ ] Wait for every required check and merge-group result to pass. Confirm the PR is merged before starting slice 2.

---

## Slice 2: Global durable tasks

### Task 7: Add validated multi-run task projection

**Files:**
- Modify: `desktop/src/features/company/taskRunContracts.ts`
- Modify: `desktop/src/features/company/taskRunRepository.ts`
- Test: `desktop/src/features/company/taskRunRepository.test.mjs`

- [ ] **Step 1: Write failing parser tests**

Build signed Job-head fixtures for two task/channel/thread coordinates, two historical heads for one coordinate, a malformed head, and a cross-context head. Assert only the newest valid head per `d` remains and each returned run preserves exact task/channel/thread identity.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
pnpm exec node --import ./test-loader.mjs --experimental-strip-types --test src/features/company/taskRunRepository.test.mjs
```

Expected: FAIL because the global parser/read method is absent.

- [ ] **Step 3: Implement bounded read**

Add `collapseCurrentTaskRuns(events)` that extracts exactly one `task`, `h`, and `e` tag before calling the existing strict parser. Add `listCurrentRuns(limit = 500)` to query `KIND_JOB_HEAD` with an explicit `kinds` filter, collapse by `d`, and return a generation-safe result. Keep the per-thread `getCurrentRun` path unchanged.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm exec node --import ./test-loader.mjs --experimental-strip-types --test src/features/company/taskRunRepository.test.mjs
 git add desktop/src/features/company/taskRunContracts.ts desktop/src/features/company/taskRunRepository.ts desktop/src/features/company/taskRunRepository.test.mjs
 git commit -s -m "feat(desktop): read global durable task runs"
```

### Task 8: Join task records into Action Center items

**Files:**
- Modify: `desktop/src/features/action-center/useActionCenterItems.ts`
- Modify: `desktop/src/features/action-center/actionCenterModel.ts`
- Modify: `desktop/src/features/action-center/contracts.ts`
- Create: `desktop/src/features/action-center/ui/ActionCenterTaskDetail.tsx`
- Modify: `desktop/src/features/action-center/ui/ActionCenterDetail.tsx`
- Modify: `desktop/src/features/action-center/lib/actionCenterNavigation.ts`
- Test: `desktop/src/features/action-center/actionCenterModel.test.mjs`

- [ ] **Step 1: Add projection tests**

Assert active company tasks join to their current run, terminal company tasks are excluded from default action items, failed/recoverable/delivered runs are `needs-action`, and a missing run yields a visible task item with `No execution record` rather than an inferred working state.

- [ ] **Step 2: Implement one-query join**

Read the active company, list tasks once, and read current runs once. Match by task id and exact source channel/thread. Never call `getCurrentRun` once per row. Use `deriveTaskExecutionState` for run labels and a task-status fallback only when no run exists.

- [ ] **Step 3: Implement task details/actions**

Render title, accountable team, QA persona, task status, execution badge, worker, checkpoint, failure/result, evidence, and task id. `Open canonical thread` calls `goChannel` with the source channel/thread. A delivered primary artifact calls `openTaskArtifact`; unsupported artifacts display the helper's explicit message. Keep retry absent unless the source capability exists.

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm exec node --import ./test-loader.mjs --experimental-strip-types --test src/features/action-center/*.test.mjs
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/action-center
 git commit -s -m "feat(desktop): surface durable tasks in action center"
```

### Task 9: Add task fixtures and E2E deep-link proof

**Files:**
- Modify: `desktop/src/testing/e2eBridge.ts`
- Modify: `desktop/tests/helpers/bridge.ts`
- Modify: `desktop/tests/e2e/action-center.spec.ts`

- [ ] Seed a valid company profile/task, an executing task run with checkpoint, and a delivered run with an `event` or safe `url` artifact.
- [ ] Assert task rows display status/checkpoint, `Open canonical thread` navigates to the expected channel/thread URL, and delivered artifacts open a workspace tab using the existing registry.
- [ ] Assert malformed/cross-community task heads do not render as task rows.
- [ ] Run fresh E2E build, focused smoke spec, typecheck, and check.
- [ ] Commit and ship a separate PR targeting `develop`; wait for merge queue completion before slice 3.

---

## Slice 3: Supported workflow actions, realtime, and hardening

### Task 10: Add workflow capability adapters without inert rows

**Files:**
- Modify: `desktop/src/features/action-center/useActionCenterItems.ts`
- Create: `desktop/src/features/action-center/ui/ActionCenterWorkflowDetail.tsx`
- Modify: `desktop/src/features/workflows/hooks.ts`
- Modify: `desktop/src/features/action-center/actionCenterModel.ts`
- Test: `desktop/src/features/action-center/actionCenterModel.test.mjs`

- [ ] Add fixture tests for pending approvals with tokens, failed/cancelled runs, and unsupported empty workflow responses.
- [ ] Project only records with executable capabilities. Approval detail uses `useApprovalMutation` grant/deny with pending/error feedback; failed/cancelled run detail uses `useTriggerWorkflowMutation` and the existing recovery label.
- [ ] Link every workflow item to `/workflows/<workflowId>`. Add a source-channel link only when the workflow record has a non-empty channel id. Do not show an approval row when `getRunApprovals` returns an empty placeholder.
- [ ] Run focused tests and commit.

### Task 11: Realtime, badge accuracy, and resilient selection

**Files:**
- Modify: `desktop/src/app/AppShell.tsx`
- Modify: `desktop/src/features/action-center/useActionCenterItems.ts`
- Modify: `desktop/src/features/action-center/ui/ActionCenterScreen.tsx`
- Test: `desktop/src/features/action-center/actionCenterModel.test.mjs`
- Test: `desktop/tests/e2e/action-center.spec.ts`

- [ ] Calculate the badge from Action Center default-view items only, never add Home/reminder counts a second time.
- [ ] On source mutation, invalidate the exact source query and move selection to the next valid item or clear `?item=`.
- [ ] Preserve selected item across background refresh if its source remains; show unavailable detail if it disappears mid-action.
- [ ] Verify reconnect/degraded relay states do not create false working task statuses.

### Task 12: Accessibility, performance, visual QA, and ship

- [ ] Add keyboard ArrowUp/ArrowDown/Enter/Escape behavior to the list without interfering with the global command palette.
- [ ] Add visible focus rings, `aria-current`/selected state, row labels, live action feedback, and Back behavior on narrow layouts.
- [ ] Keep list derivation stable with memoized source arrays and stable row props. Confirm no N+1 task/detail reads.
- [ ] Run:

```bash
pnpm typecheck
pnpm check
pnpm test
pnpm build:e2e
pnpm exec playwright test --project=smoke tests/e2e/action-center.spec.ts
```

- [ ] Capture and inspect desktop, narrow, empty, task-delivered, ask-answer, and error screenshots. Run SHA-256 distinctness check.
- [ ] Review `git diff origin/develop...HEAD`, run CI-equivalent local gates, push the final slice, open/arm PR, and confirm merge-group checks pass.
- [ ] Confirm all Action Center PRs are merged into `develop` and leave existing untracked `docs/design/software-factory.html` and `output/` untouched.

---

## Validation matrix

| Surface | Unit coverage | E2E coverage |
| --- | --- | --- |
| Projection/dedupe/filter | `actionCenterModel.test.mjs` | list grouping/filter selection |
| Ask answer | `answerAsk.test.mjs` | answer removes item |
| Message source | model/navigation tests | canonical thread navigation + mark done |
| Reminder actions | existing reminder tests | complete/snooze/cancel/source navigation |
| Durable tasks | `taskRunRepository.test.mjs` | status/checkpoint/thread/workspace |
| Workflow capabilities | model tests | approval/retry when real capability exists |
| Route/sidebar/commands | navigation tests | badge, route, URL selection, narrow Back |
| Failure/reconnect | repository and model tests | partial error/unavailable states |

Every slice must pass its focused tests before the full desktop checks. No PR is merged with pending or failing CI checks.
