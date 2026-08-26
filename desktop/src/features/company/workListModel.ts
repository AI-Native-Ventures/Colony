import type { CompanyTask, TaskStatus } from "./contracts";
import { isTerminalTaskStatus } from "./contracts";
import type { TaskRunHead } from "./taskRunContracts";
import {
  deriveTaskExecutionState,
  type TaskExecutionState,
} from "./taskThreadModel";

/**
 * The "All tasks" list model.
 *
 * Every row carries two truths that disagree on purpose: the task's business
 * status (what the company decided) and its execution state (what the run
 * head proves an agent is actually doing). A task can read `inProgress`
 * while its run is `recoverable` because the lease expired forty minutes
 * ago; the list must show both rather than let either stand for the other.
 *
 * Pure on purpose: the screen owns controls, this file owns meaning, and the
 * tests exercise the meaning without rendering anything.
 */

export type WorkListRow = {
  task: CompanyTask;
  execution: TaskExecutionState;
};

export function buildWorkListRows(
  tasks: readonly CompanyTask[],
  runsByTaskId: ReadonlyMap<string, TaskRunHead | null>,
  nowSeconds: number,
): WorkListRow[] {
  return tasks.map((task) => ({
    task,
    execution: deriveTaskExecutionState(
      runsByTaskId.get(task.id) ?? null,
      nowSeconds,
    ),
  }));
}

export type WorkListFilter = {
  /** Chat turns mint implicit tasks for cost attribution; they are noise in
   * the default view. Nothing is hidden: one toggle shows all of them. */
  showImplicit: boolean;
  initiativeId: string | null;
};

export function filterWorkRows(
  rows: readonly WorkListRow[],
  filter: WorkListFilter,
): WorkListRow[] {
  return rows.filter(
    (row) =>
      (filter.showImplicit || !row.task.implicit) &&
      (filter.initiativeId === null ||
        row.task.initiativeId === filter.initiativeId),
  );
}

export const WORK_LIST_SORTS = [
  "attention",
  "recent",
  "oldest",
  "title",
] as const;
export type WorkListSortKey = (typeof WORK_LIST_SORTS)[number];

export const WORK_LIST_SORT_LABELS: Record<WorkListSortKey, string> = {
  attention: "Attention first",
  oldest: "Oldest first",
  recent: "Newest first",
  title: "Title A-Z",
};

/**
 * Danger before warning before live work before finished work. This is the
 * toolbar's default ("stalled first"): a dead agent outranks a busy one,
 * which outranks a done one.
 */
const ATTENTION_BANDS = {
  danger: 0,
  warning: 1,
  active: 2,
  neutral: 2,
  success: 2,
} as const;

function attentionBand(row: WorkListRow): number {
  if (row.execution.tone === "danger") return ATTENTION_BANDS.danger;
  if (row.execution.tone === "warning") return ATTENTION_BANDS.warning;
  return isTerminalTaskStatus(row.task.status)
    ? ATTENTION_BANDS.success + 1
    : ATTENTION_BANDS.active;
}

function recencyOrder(left: WorkListRow, right: WorkListRow): number {
  return (
    right.task.updatedAt - left.task.updatedAt ||
    left.task.id.localeCompare(right.task.id)
  );
}

export function sortWorkRows(
  rows: readonly WorkListRow[],
  key: WorkListSortKey,
): WorkListRow[] {
  const sorted = [...rows];
  switch (key) {
    case "attention":
      sorted.sort(
        (left, right) =>
          attentionBand(left) - attentionBand(right) ||
          recencyOrder(left, right),
      );
      break;
    case "recent":
      sorted.sort(recencyOrder);
      break;
    case "oldest":
      sorted.sort((left, right) => recencyOrder(right, left));
      break;
    case "title":
      sorted.sort(
        (left, right) =>
          left.task.title.localeCompare(right.task.title) ||
          left.task.id.localeCompare(right.task.id),
      );
      break;
  }
  return sorted;
}

/**
 * Every group-by is a real field on the task contract. No labels, no custom
 * fields: a swimlane key the relay mirrors (`party:acme`), a stage slug, a
 * status slug, or an id.
 */
export const WORK_LIST_GROUPS = [
  "subject",
  "stage",
  "status",
  "team",
  "initiative",
  "assignee",
] as const;
export type WorkListGroupKey = (typeof WORK_LIST_GROUPS)[number];

export const WORK_LIST_GROUP_LABELS: Record<WorkListGroupKey, string> = {
  assignee: "Assignee",
  initiative: "Initiative",
  stage: "Stage",
  status: "Status",
  subject: "Subject",
  team: "Team",
};

/** The readable tail of a colon-scoped id: `relay1:horizonlabs:sales` →
 * `sales`. Ids without scope render whole. */
export function shortIdLabel(id: string): string {
  const tail = id.slice(Math.max(id.lastIndexOf(":"), id.lastIndexOf("/")) + 1);
  return tail === "" ? id : tail;
}

export type WorkListGroup = {
  key: string;
  label: string;
  rows: WorkListRow[];
};

function groupOf(row: WorkListRow, dimension: WorkListGroupKey): string {
  switch (dimension) {
    case "subject":
      return row.task.subject === null
        ? ""
        : `${row.task.subject.kind}:${row.task.subject.ref}`;
    case "stage":
      return row.task.stage ?? "";
    case "status":
      return row.task.status;
    case "team":
      return row.task.owningTeamId;
    case "initiative":
      return row.task.initiativeId ?? "";
    case "assignee":
      return row.task.assigneePersonaIds
        .map((id) => shortIdLabel(id))
        .join(", ");
  }
}

function groupDisplayLabel(key: string, dimension: WorkListGroupKey): string {
  if (key === "") {
    switch (dimension) {
      case "subject":
        return "No subject";
      case "stage":
        return "No stage";
      case "initiative":
        return "No initiative";
      case "assignee":
        return "Unassigned";
      default:
        return key;
    }
  }
  if (dimension === "subject") {
    // `party:acme-lead` names the lead; the kind prefix is wire spelling.
    const [, ...rest] = key.split(":");
    return rest.join(":");
  }
  if (dimension === "assignee") {
    // Already a display string: comma-joined short persona names.
    return key;
  }
  return shortIdLabel(key);
}

export function groupWorkRows(
  rows: readonly WorkListRow[],
  dimension: WorkListGroupKey,
): WorkListGroup[] {
  const byKey = new Map<string, WorkListRow[]>();
  for (const row of rows) {
    const key = groupOf(row, dimension);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey.entries()]
    .map(([key, grouped]) => ({
      key,
      label: groupDisplayLabel(key, dimension),
      rows: sortWorkRows(grouped, "attention"),
    }))
    .sort(
      (left, right) =>
        Number(left.key === "") - Number(right.key === "") ||
        left.label.localeCompare(right.label),
    );
}

/** Compact relative age for a row's last update, ticking with `nowSeconds`. */
export function formatTaskAge(
  updatedAtSeconds: number,
  nowSeconds: number,
): string {
  const seconds = Math.max(0, Math.floor(nowSeconds - updatedAtSeconds));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function countLiveTasks(rows: readonly WorkListRow[]): number {
  return rows.filter((row) => !isTerminalTaskStatus(row.task.status)).length;
}

/** Statuses whose pill should read as settled rather than demanding action. */
export function statusPillTone(status: TaskStatus): string {
  if (status === "completed") return "success";
  if (status === "cancelled") return "danger";
  if (status === "blocked") return "warning";
  if (status === "snoozed") return "neutral";
  return "active";
}
