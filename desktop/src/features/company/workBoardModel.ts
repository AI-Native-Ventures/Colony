import type { CompanyTask } from "./contracts";
import { isTerminalTaskStatus } from "./contracts";
import type { WorkListGroupKey, WorkListRow } from "./workListModel";

/**
 * The board's pure meaning: which dimension makes a column, which rows count
 * as stalled, and how many of a task's dependencies are still unsatisfied.
 *
 * Columns are stages, not statuses, by default (R: "stage columns give a
 * funnel, status columns give a count"). `groupWorkRows` from workListModel
 * already does the grouping generically; this file only narrows which
 * dimensions the board exposes and adds board-only facts `groupWorkRows`
 * has no reason to know about.
 */

export const BOARD_GROUPS = [
  "stage",
  "status",
  "team",
  "assignee",
] as const satisfies readonly WorkListGroupKey[];
export type BoardGroupKey = (typeof BOARD_GROUPS)[number];

export const BOARD_DEFAULT_GROUP: BoardGroupKey = "stage";

/**
 * Stalled is the board's whole point: a card reading `inProgress` whose
 * lease expired must be findable in one glance. That is the execution dot's
 * warning/danger tones on a task that is still live business-wise - a
 * terminal task (completed/cancelled) with a stale run head is finished
 * work, not a stalled one.
 */
export function isStalledRow(row: WorkListRow): boolean {
  return (
    !isTerminalTaskStatus(row.task.status) &&
    (row.execution.tone === "warning" || row.execution.tone === "danger")
  );
}

export function countStalledRows(rows: readonly WorkListRow[]): number {
  return rows.filter(isStalledRow).length;
}

/**
 * A dependency counts as satisfied only when the task it points at is
 * `completed`. Cancelled does not satisfy it (nothing produced), and an id
 * this company's task set does not contain is treated as unsatisfied rather
 * than silently dropped - a missing dependency is a reason to look, not a
 * reason to hide the count.
 */
export function unsatisfiedDependsOnCount(
  task: Pick<CompanyTask, "dependsOn">,
  tasksById: ReadonlyMap<string, CompanyTask>,
): number {
  return task.dependsOn.filter(
    (id) => tasksById.get(id)?.status !== "completed",
  ).length;
}

export function buildTasksById(
  tasks: readonly CompanyTask[],
): ReadonlyMap<string, CompanyTask> {
  return new Map(tasks.map((task) => [task.id, task]));
}
