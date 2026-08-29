import {
  KIND_EVENT_REMINDER,
  KIND_JOB_ACCEPTED,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_JOB_PROGRESS,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  KIND_JOB_HEAD,
  KIND_APPROVAL_REQUEST,
} from "@/shared/constants/kinds";
import { describeAskResolution } from "@/features/asks/lib/askResolution";
import { isDue } from "@/features/reminders/lib/reminderFilters";
import { projectBlockFeedItem } from "./lib/blockActionCenter";
import type {
  ActionCenterFilter,
  ActionCenterProjectionInput,
  ActionCenterStateFilter,
  ActionItem,
  ActionItemKind,
  ActionItemState,
  ActionSource,
  ActionWorkflowSource,
} from "./contracts";

const FILTER_KIND: Record<
  Exclude<ActionCenterFilter, "all" | "needs-action">,
  ActionItemKind
> = {
  asks: "ask",
  blocks: "block",
  reminders: "reminder",
  workflows: "workflow",
};

/** Feed kinds that are never a plain Block row (structured surfaces render
 * them directly), so they never enter the Action Center projection. */
const STRUCTURED_FEED_KINDS = new Set([
  KIND_APPROVAL_REQUEST,
  KIND_EVENT_REMINDER,
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_JOB_HEAD,
]);

const STATE_RANK: Record<ActionItemState, number> = {
  failed: 0,
  "needs-action": 1,
  active: 2,
  completed: 3,
};

export function actionItemId(kind: ActionItemKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

function sourceUpdatedAt(source: ActionSource): number {
  switch (source.kind) {
    case "ask":
      return source.ask.createdAt;
    case "block":
      return source.item.createdAt;
    case "reminder":
      return source.reminder.notBefore ?? source.reminder.createdAt;
    case "workflow":
      return source.run.completedAt ?? source.run.createdAt;
  }
}

function compareItems(left: ActionItem, right: ActionItem): number {
  return (
    STATE_RANK[left.state] - STATE_RANK[right.state] ||
    right.updatedAt - left.updatedAt ||
    left.id.localeCompare(right.id)
  );
}

type FeedSourceItem = NonNullable<
  ActionCenterProjectionInput["feed"]
>["needsAction"][number];

/** `e` markers that reference Block plumbing, never a thread. */
const BLOCK_E_MARKERS = new Set([
  "block",
  "block-instance",
  "block-manifest",
  "block-action",
  "block-receipt",
]);

function feedThreadRootId(item: FeedSourceItem): string | null {
  const rootTag = item.tags.find(
    (tag) => tag[0] === "e" && tag.length >= 2 && tag[3] === "root",
  );
  if (rootTag) return rootTag[1] ?? null;
  // A Block instance's first `e` tag points at its manifest, not a thread, so
  // Block references are skipped rather than mistaken for a thread root.
  const fallbackTag = item.tags.find((tag) => {
    if (tag[0] !== "e" || tag.length < 2) return false;
    const marker = tag.length >= 4 ? tag[3] : undefined;
    return marker === undefined || !BLOCK_E_MARKERS.has(marker);
  });
  return fallbackTag?.[1] ?? null;
}

/**
 * A `needsAction` feed row that carries Block instance tags becomes a Block
 * item, so the queue can render the Block itself and offer its declared
 * decision. Returns `null` for anything that does not parse as a Block
 * instance, or that the relay no longer counts as waiting on this person
 * (`relayStillWaiting` false): a resolved or never-actionable Block is not a
 * "needs me" item and does not belong in the queue at all. A row hidden
 * locally (`isDone`) while the relay still counts it as open stays in,
 * because the local hide never actually closed it — see
 * `blockActionCenter.ts`'s `blockStatusLine`.
 */
function blockItem(
  item: FeedSourceItem,
  doneIds: ReadonlySet<string>,
): ActionItem | null {
  const isDone = doneIds.has(item.id);
  const projection = projectBlockFeedItem(item, feedThreadRootId(item), isDone);
  if (!projection) return null;
  const { instance } = projection.source;
  const relayStillWaiting =
    instance.attentionRequired && item.category === "needs_action";
  if (!relayStillWaiting) return null;
  return {
    id: actionItemId("block", item.id),
    kind: "block",
    state: isDone ? "completed" : "needs-action",
    title: projection.title,
    summary: projection.summary,
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    source: projection.source,
    capabilities: projection.capabilities,
  };
}

/**
 * Every `ActionWorkflowSource` reaching here already passed
 * `selectOwnerWorkflowApprovalSources`: a run waiting on a pending approval
 * that names the owner specifically. Other run states (running, completed,
 * failed) and approvals open to anyone never become sources at all, so this
 * item is always the one thing left: an approval waiting on this person.
 */
function workflowItem(source: ActionWorkflowSource): ActionItem {
  return {
    id: actionItemId("workflow", `${source.workflow.id}:${source.run.id}`),
    kind: "workflow",
    state: "needs-action",
    title: source.workflow.name,
    summary: `Approval required · ${source.approval?.stepId ?? "workflow step"}`,
    createdAt: source.run.createdAt,
    updatedAt: source.run.completedAt ?? source.run.createdAt,
    source,
    capabilities: ["open-details", "open-source", "approve", "deny"],
  };
}

/** Build the global queue from source records without creating new records. */
export function buildActionCenterItems({
  asks,
  resolvedAsks = [],
  resolverLabelsByPubkey,
  askRoutingNotesByAskId,
  feed,
  reminders,
  workflows = [],
  doneIds = new Set(),
  now = Math.floor(Date.now() / 1_000),
}: ActionCenterProjectionInput): ActionItem[] {
  const items: ActionItem[] = asks.map((ask) => {
    const source: ActionSource = { kind: "ask", ask };
    const baseSummary = ask.costOfDelay ?? `Answer requested · ${ask.askType}`;
    const routingNote = askRoutingNotesByAskId?.get(ask.id) ?? null;
    return {
      id: actionItemId("ask", ask.id),
      kind: "ask",
      state: "needs-action",
      title: ask.headline,
      summary: routingNote ? `${baseSummary} · ${routingNote}` : baseSummary,
      createdAt: ask.createdAt,
      updatedAt: ask.createdAt,
      source,
      capabilities: [
        "answer",
        ...(ask.channelId && ask.threadId ? (["open-source"] as const) : []),
      ],
    };
  });

  // Closed asks stay visible as completed rows. The summary is an account
  // of what happened, and the source carries the full resolution so every
  // surface can render an executed default differently from a human answer.
  for (const { resolution, ask } of resolvedAsks) {
    const source: ActionSource = { kind: "ask", ask, resolution };
    items.push({
      id: `resolved-ask:${ask.id}`,
      kind: "ask",
      state: "completed",
      title: ask.headline.trim() || "Resolved ask",
      summary: describeAskResolution(
        resolution,
        resolverLabelsByPubkey?.get(resolution.resolverPubkey) ?? null,
      ),
      createdAt: ask.createdAt,
      updatedAt: Math.max(ask.createdAt, resolution.createdAt),
      source,
      capabilities:
        ask.channelId && ask.threadId ? (["open-source"] as const) : [],
    });
  }

  items.push(...workflows.map(workflowItem));

  // Only reminders that are due (pending and `notBefore <= now`) enter the
  // queue — the same definition `countDueReminders` uses for the Home badge,
  // reused via `isDue` rather than redefined here so the two surfaces can
  // never disagree about what "due" means.
  const reminderEventIds = new Set(
    reminders.map((reminder) => reminder.eventId),
  );
  for (const reminder of reminders) {
    if (!isDue(reminder, now)) continue;
    const source: ActionSource = { kind: "reminder", reminder };
    items.push({
      id: actionItemId("reminder", reminder.id),
      kind: "reminder",
      state: "needs-action",
      title: "Reminder",
      summary:
        reminder.content.target?.preview ??
        reminder.content.note ??
        "Reminder is waiting for you.",
      createdAt: reminder.createdAt,
      updatedAt: reminder.notBefore ?? reminder.createdAt,
      source,
      capabilities: [
        "complete",
        "snooze",
        "cancel",
        ...(reminder.content.target ? (["open-source"] as const) : []),
      ],
    });
  }

  const feedItems = feed?.needsAction ?? [];
  const seenFeedIds = new Set<string>();
  for (const item of feedItems) {
    if (seenFeedIds.has(item.id) || STRUCTURED_FEED_KINDS.has(item.kind))
      continue;
    if (reminderEventIds.has(item.id)) continue;
    const block = blockItem(item, doneIds);
    if (!block) continue;
    seenFeedIds.add(item.id);
    items.push(block);
  }

  const unique = new Map<string, ActionItem>();
  for (const item of items) {
    const existing = unique.get(item.id);
    if (!existing || compareItems(item, existing) < 0)
      unique.set(item.id, item);
  }
  return [...unique.values()].sort(compareItems);
}

export function filterActionCenterItems(
  items: readonly ActionItem[],
  filter: ActionCenterFilter,
  state?: ActionCenterStateFilter,
): ActionItem[] {
  const filteredByKind =
    filter === "all" || filter === "needs-action"
      ? [...items]
      : items.filter((item) => item.kind === FILTER_KIND[filter]);
  const filteredByDefaultState =
    filter === "needs-action"
      ? filteredByKind.filter(
          (item) => item.state === "needs-action" || item.state === "failed",
        )
      : filteredByKind;
  if (!state) return filteredByDefaultState;
  return filteredByDefaultState.filter((item) =>
    state === "open"
      ? item.state === "needs-action" || item.state === "failed"
      : item.state === state,
  );
}

export function countActionableItems(items: readonly ActionItem[]): number {
  return items.filter(
    (item) => item.state === "needs-action" || item.state === "failed",
  ).length;
}

export function sourceTimestamp(source: ActionSource): number {
  return sourceUpdatedAt(source);
}
