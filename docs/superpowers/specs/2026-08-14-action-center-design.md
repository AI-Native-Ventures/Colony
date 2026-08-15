# Action Center Design

## Status

Approved design. The Action Center is a native desktop destination for unresolved work signals, built on existing ask, message, reminder, company-task, task-run, workspace, and navigation surfaces. It is not a second inbox and it does not create duplicate source records.

## User problem

Asks, durable tasks, reminders, and actionable messages currently live in different places. A person can miss an ask because they are reading a channel, or miss the status of a durable task because task state only appears after opening its canonical thread. The user needs one global place that answers two questions immediately:

1. What needs my attention?
2. What can I do about it right now?

A row without a source link or an executable action is a product failure.

## Product boundary

Home remains the conversation inbox. Action Center is the global work queue. Its default view is `Needs action`; `All activity` is available for monitoring active and recently completed work. The first version includes:

- Open owner-addressed asks.
- Durable company tasks and their current verified task-run state.
- Actionable messages and agent updates that already appear in Home.
- Pending reminders.
- Workflow approval/run records only where the existing backend exposes a real action and source; unsupported workflow records are not fabricated or shown as inert rows.

Closed asks, completed/cancelled reminders, completed/cancelled company tasks, resolved local feed items, and terminal workflow records are excluded from `Needs action` but may appear in `All activity` when the source already supplies them.

## Native navigation and layout

Add `/action-center` as a TanStack Router file route with validated search fields:

- `item`: stable Action Center item id.
- `filter`: `needs-action`, `all`, `asks`, `tasks`, `messages`, `reminders`, or `workflows`.
- `state`: optional `open`, `active`, `completed`, or `failed` filter.

The route is integrated into `AppShell`, `AppSidebar`, and the command-capable `TopbarSearch`. It receives an active-view highlight and a badge count. The existing community transition saves/restores Home or channel destinations; Action Center selection is community-scoped and is cleared when the active community changes.

The page uses the existing two-pane inbox/workflow visual grammar:

- Left list pane with grouped rows and a resizable boundary where the existing pane primitives support it.
- Right detail pane owned by `?item=`.
- On narrow widths, selecting an item switches to a detail-only view with a Back control.
- Loading, empty, unavailable, and reconnecting states use existing skeleton, muted-border, and relay-error components.
- All readable text uses existing rem-based tokens. No arbitrary px/rem text sizes.

Rows show an icon, type label, title, source location, current state, actor/owner, and age. The primary action is visible in the selected detail and available from the row when it is safe and compact.

## Action model

The UI consumes a discriminated projection rather than rendering raw source records directly:

```ts
type ActionItemKind =
  | "ask"
  | "task"
  | "message"
  | "reminder"
  | "workflow";

type ActionItem = {
  id: string;
  kind: ActionItemKind;
  state: "needs-action" | "active" | "failed" | "completed";
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  source: {
    eventId?: string;
    channelId?: string | null;
    threadId?: string | null;
    taskId?: string;
    workflowId?: string;
    runId?: string;
    reminderId?: string;
  };
  capabilities: readonly ActionCapability[];
};
```

IDs are stable and source-derived: `ask:<eventId>`, `task:<taskId>:<threadId>`, `message:<eventId>`, `reminder:<id>`, and `workflow:<workflowId>:<runId>` or `workflow:approval:<eventId>`.

Capabilities are keys, not arbitrary UI callbacks. Source controllers execute them through the existing mutation/event APIs, invalidate the source query, and report success/error. The detail renderer is selected by `kind`, so a task opens task-specific context and an ask opens the existing answer card.

## Source adapters and actions

### Asks

Reuse `useOpenAsks`, `readAsk`, `selectOpenAsks`, and the existing answer event (`KIND_ASK_RESOLUTION`). Extract optional `h`/`e` tags when present so channel-backed asks can link to their canonical thread. Channel-less asks remain answerable directly in Action Center and show their ask id and work context instead of inventing a thread.

Actions:

- Answer and unblock.
- Open source thread when a valid channel/thread exists.
- Mark the resulting resolution through the existing query invalidation path.

### Durable tasks

Reuse the verified company task parser and `TaskThreadContext` model. Extend the task-run repository with one bounded global read that fetches Job heads for the active community, validates each head's task/channel/thread tags, collapses parameterized heads by `d`, and returns current runs. The projection joins those runs with `companyRepository.listTasks({ companyId })`.

Only relay-authored, signature-valid company heads and valid Job heads enter the projection. Completed/cancelled company tasks are not actionable. Active runs remain visible in `All activity`; recoverable, failed, abandoned, and delivered runs enter `Needs action`.

Actions:

- Open canonical task thread through `goChannel(channelId, { thread: threadId })`.
- Open task details, reusing the existing task state labels and evidence presentation.
- Open an accepted artifact through `openTaskArtifact` and the existing workspace tab registry.

No retry/resume button is invented for durable tasks. If the backend later exposes an authenticated recovery command, it can be added as a capability without changing the item identity.

### Messages and agent updates

Reuse Home feed data and existing read/done state. Structured records with their own adapters are deduplicated from the generic message projection by event id. Message rows always have an `Open thread`/`Open message` action when a channel id is available, and a `Mark done` action using `useAppShell().feedItemState`. Marking done updates the same local state Home uses; it never creates a second unread store.

### Reminders

Reuse `useRemindersQuery`, `useReminderMutations`, `resolveReminderDestination`, and the existing `ReminderDetailPane` patterns. Pending reminders are actionable; done and cancelled reminders are not in the default view.

Actions:

- Complete.
- Snooze.
- Cancel.
- Open the target message/thread when the target is navigable.

### Workflows

Use existing workflow query/mutation APIs only when the returned record has a real status and action. Pending approvals use the existing grant/deny mutation and token. Failed/cancelled runs use the shipped `Run again` mutation. Each workflow item links to `/workflows/<id>` and, when possible, the source channel.

The native backend currently returns empty workflow-run/approval arrays in some paths. Until a real record is available, the Action Center must not display a fake workflow item merely because a route exists. This keeps the queue trustworthy.

## Data flow and realtime

`useActionCenterItems` runs source reads in parallel under the active community and identity. It uses existing React Query caches for Home, asks, reminders, company records, and workflows. Task-run aggregation has its own community-scoped query key and a 5-second active/30-second terminal refresh policy matching `useTaskThreadContext`.

The existing AppShell live Home subscription invalidates Home feed data. Ask closure, reminder, and workflow mutation paths invalidate their existing keys. The Action Center derives from those caches, so a source action updates Home and Action Center together. A task-run live subscription or bounded refetch invalidates the task-run projection. All module-level caches are reset through `resetCommunityState()` if introduced.

The list is capped and sorted by actionable state, priority derived from source semantics, then `updatedAt`. It must not perform one detail request per row. Detail queries load only for the selected item when the summary does not contain enough evidence.

## Security and failure handling

Community and identity are part of every query key. Company heads are verified against the active relay identity. Job heads are validated against their signed employee and exact task/channel/thread tags. Ask answer, reminder, approval, and workflow mutations continue through the existing relay/native authorization checks; the frontend never decides permission.

If one source is unavailable, the Action Center shows that source's inline error and keeps other sources usable. It does not infer a task as working when task state is unavailable. Rows whose source disappeared show a recoverable `This item is no longer available` detail with the source id and a refresh action, then leave the default queue after the next successful projection.

## Acceptance criteria

- The sidebar, command palette, route, URL selection, keyboard navigation, and community switching all work.
- Real asks can be answered from Action Center and disappear after resolution.
- Task rows show verified state and open their canonical thread; delivered artifacts open in workspace.
- Message rows open the source thread and share Home's done/read state.
- Reminder rows complete, snooze, cancel, and navigate through existing APIs.
- Workflow actions appear only when the source supplies a real token/run and mutation.
- Every default-view row has at least one executable action and a canonical source link or explicit channel-less explanation.
- Loading, empty, partial-error, stale, reconnect, narrow-layout, and selected-item states are covered by focused tests and E2E screenshots.
- `pnpm typecheck`, `pnpm check`, focused unit tests, fresh E2E build, smoke E2E, CI, and merge-queue checks pass for each mergeable slice.

## Delivery slices

1. Shell, route, projection contracts, asks, messages, reminders, and navigation.
2. Global durable-task read model, task detail, thread deep link, and workspace artifact action.
3. Workflow capability adapter where real records exist, realtime invalidation, badges, and final accessibility/performance polish.

The source systems remain canonical throughout. Action Center is a native cross-signal projection and command surface, not a duplicate task manager.
