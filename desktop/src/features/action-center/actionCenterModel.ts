import {
  KIND_EVENT_REMINDER,
  KIND_JOB_ACCEPTED,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_JOB_PROGRESS,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  KIND_JOB_HEAD,
  KIND_REMINDER,
  KIND_APPROVAL_REQUEST,
} from "@/shared/constants/kinds";
import type {
  ActionCenterFilter,
  ActionCenterProjectionInput,
  ActionItem,
  ActionItemKind,
  ActionItemState,
  ActionSource,
  ActionTaskSource,
  ActionWorkflowSource,
} from "./contracts";

const FILTER_KIND: Record<
  Exclude<ActionCenterFilter, "all" | "needs-action">,
  ActionItemKind
> = {
  asks: "ask",
  tasks: "task",
  messages: "message",
  reminders: "reminder",
  workflows: "workflow",
};

const STRUCTURED_FEED_KINDS = new Set([
  KIND_APPROVAL_REQUEST,
  KIND_EVENT_REMINDER,
  KIND_REMINDER,
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

function feedState(
  category: "mention" | "needs_action" | "activity" | "agent_activity",
  kind: number,
  isDone: boolean,
): ActionItemState {
  if (isDone) return "completed";
  if (kind === KIND_JOB_ERROR) return "failed";
  return category === "activity" || category === "agent_activity"
    ? "active"
    : "needs-action";
}

function sourceUpdatedAt(source: ActionSource): number {
  switch (source.kind) {
    case "ask":
      return source.ask.createdAt;
    case "message":
      return source.item.createdAt;
    case "reminder":
      return source.reminder.notBefore ?? source.reminder.createdAt;
    case "task":
      return source.run?.createdAt ?? source.task.updatedAt;
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

function messageItem(
  item: NonNullable<ActionCenterProjectionInput["feed"]>["mentions"][number],
  doneIds: ReadonlySet<string>,
): ActionItem {
  const isDone = doneIds.has(item.id);
  const threadRootId =
    item.tags.find(
      (tag) => tag[0] === "e" && tag.length >= 2 && tag[3] === "root",
    )?.[1] ??
    item.tags.find((tag) => tag[0] === "e" && tag.length >= 2)?.[1] ??
    null;
  const source: ActionSource = {
    kind: "message",
    item,
    threadRootId,
    isDone,
  };
  const state = feedState(item.category, item.kind, isDone);
  return {
    id: actionItemId("message", item.id),
    kind: "message",
    state,
    title:
      item.category === "mention"
        ? "Mention"
        : item.category === "agent_activity"
          ? "Agent update"
          : item.category === "activity"
            ? "Activity"
            : "Needs action",
    summary:
      item.content.trim() ||
      "No additional details were attached to this event.",
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    source,
    capabilities: [
      ...(item.channelId ? (["open-source"] as const) : []),
      ...(isDone ? (["undo-done"] as const) : (["mark-done"] as const)),
    ],
  };
}

function taskItem(source: ActionTaskSource): ActionItem {
  const isCompleted =
    source.task.status === "completed" || source.task.status === "cancelled";
  const isFailed =
    source.run?.runStatus === "failed" || source.run?.runStatus === "abandoned";
  const isActive =
    source.run?.runStatus === "queued" ||
    source.run?.runStatus === "executing" ||
    source.run?.runStatus === "recoverable" ||
    source.task.status === "inProgress" ||
    source.task.status === "inReview";
  const state: ActionItemState = isCompleted
    ? "completed"
    : isFailed
      ? "failed"
      : isActive
        ? "active"
        : "needs-action";
  const runLabel = source.run
    ? source.run.runStatus.replace(/_/g, " ")
    : source.task.status;
  return {
    id: actionItemId("task", source.task.id),
    kind: "task",
    state,
    title: source.task.title,
    summary: `${source.task.status} · ${runLabel}`,
    createdAt: source.task.createdAt,
    updatedAt: Math.max(source.task.updatedAt, source.run?.createdAt ?? 0),
    source,
    capabilities: [
      ...(source.channelId && source.threadId
        ? (["open-source"] as const)
        : []),
      "open-details",
      ...(source.run?.runStatus === "delivered" &&
      source.run.artifacts.length > 0
        ? (["open-workspace"] as const)
        : []),
    ],
  };
}

function workflowItem(source: ActionWorkflowSource): ActionItem {
  const approvalPending = source.approval?.status === "pending";
  const isFailed =
    source.run.status === "failed" || source.run.status === "cancelled";
  const isActive =
    source.run.status === "pending" ||
    source.run.status === "running" ||
    source.run.status === "waiting_approval";
  const state: ActionItemState = approvalPending
    ? "needs-action"
    : isFailed
      ? "failed"
      : isActive
        ? "active"
        : "completed";
  return {
    id: actionItemId("workflow", `${source.workflow.id}:${source.run.id}`),
    kind: "workflow",
    state,
    title: source.workflow.name,
    summary: approvalPending
      ? `Approval required · ${source.approval?.stepId ?? "workflow step"}`
      : `Run ${source.run.status.replace(/_/g, " ")}`,
    createdAt: source.run.createdAt,
    updatedAt: source.run.completedAt ?? source.run.createdAt,
    source,
    capabilities: [
      "open-details",
      "open-source",
      ...(approvalPending ? (["approve", "deny"] as const) : []),
      ...(isFailed ? (["run-again"] as const) : []),
    ],
  };
}

/** Build the global queue from source records without creating new records. */
export function buildActionCenterItems({
  asks,
  feed,
  reminders,
  tasks = [],
  workflows = [],
  doneIds = new Set<string>(),
}: ActionCenterProjectionInput): ActionItem[] {
  const items: ActionItem[] = asks.map((ask) => {
    const source: ActionSource = { kind: "ask", ask };
    return {
      id: actionItemId("ask", ask.id),
      kind: "ask",
      state: "needs-action",
      title: ask.headline,
      summary: ask.costOfDelay ?? `Answer requested · ${ask.askType}`,
      createdAt: ask.createdAt,
      updatedAt: ask.createdAt,
      source,
      capabilities: [
        "answer",
        ...(ask.channelId && ask.threadId ? (["open-source"] as const) : []),
      ],
    };
  });

  items.push(...tasks.map(taskItem), ...workflows.map(workflowItem));

  const reminderEventIds = new Set(
    reminders.map((reminder) => reminder.eventId),
  );
  for (const reminder of reminders) {
    if (reminder.content.status !== "pending") continue;
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

  const feedItems = [
    ...(feed?.needsAction ?? []),
    ...(feed?.mentions ?? []),
    ...(feed?.agentActivity ?? []),
    ...(feed?.activity ?? []),
  ];
  const seenFeedIds = new Set<string>();
  for (const item of feedItems) {
    if (seenFeedIds.has(item.id) || STRUCTURED_FEED_KINDS.has(item.kind))
      continue;
    if (reminderEventIds.has(item.id)) continue;
    seenFeedIds.add(item.id);
    items.push(messageItem(item, doneIds));
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
): ActionItem[] {
  if (filter === "all") return [...items];
  if (filter === "needs-action") {
    return items.filter(
      (item) => item.state === "needs-action" || item.state === "failed",
    );
  }
  return items.filter((item) => item.kind === FILTER_KIND[filter]);
}

export function countActionableItems(items: readonly ActionItem[]): number {
  return items.filter(
    (item) => item.state === "needs-action" || item.state === "failed",
  ).length;
}

export function sourceTimestamp(source: ActionSource): number {
  return sourceUpdatedAt(source);
}
