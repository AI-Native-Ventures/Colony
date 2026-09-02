import type { CompanyTask, Initiative, InitiativeStatus } from "./contracts";

/**
 * The Initiatives list: one row per initiative, with the number of tasks
 * charged to it.
 *
 * The count is derived from the task list the Tasks page has already fetched
 * rather than from a per-initiative query, so opening the tab costs nothing
 * beyond the initiatives read itself.
 */

export type InitiativeRow = {
  id: string;
  title: string;
  status: InitiativeStatus;
  costCentreId: string;
  /** Tasks whose `initiativeId` names this initiative. */
  taskCount: number;
};

/**
 * Live work first, settled work last.
 *
 * Sorting by the status string would put "active" after "blocked" and
 * "cancelled" ahead of both, which reads as an arbitrary order to anyone
 * scanning the list for what is running now.
 */
const STATUS_RANK: Record<InitiativeStatus, number> = {
  active: 0,
  blocked: 1,
  approved: 2,
  proposed: 3,
  completed: 4,
  cancelled: 5,
};

/** Build the Initiatives list rows, ordered for scanning. */
export function initiativeRows(
  initiatives: readonly Initiative[],
  tasks: readonly Pick<CompanyTask, "initiativeId">[],
): InitiativeRow[] {
  const taskCounts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.initiativeId) continue;
    taskCounts.set(
      task.initiativeId,
      (taskCounts.get(task.initiativeId) ?? 0) + 1,
    );
  }
  return initiatives
    .map((initiative) => ({
      id: initiative.id,
      title: initiative.title,
      status: initiative.status,
      costCentreId: initiative.costCentreId,
      taskCount: taskCounts.get(initiative.id) ?? 0,
    }))
    .sort((left, right) => {
      const byStatus = STATUS_RANK[left.status] - STATUS_RANK[right.status];
      if (byStatus !== 0) return byStatus;
      const byTitle = left.title.localeCompare(right.title);
      return byTitle !== 0 ? byTitle : left.id.localeCompare(right.id);
    });
}
