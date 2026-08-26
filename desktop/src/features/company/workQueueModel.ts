import type { CompanyTask } from "./contracts";

/**
 * The doer's queue: one card at a time, oldest first, for live work a human
 * is assigned to.
 *
 * Deliberately not the board's model. The board answers "where is work
 * stuck across everyone"; this answers "what do I do next", so it has no
 * group-by, no columns, no execution dot (human work has no agent run to
 * show two truths for) - just a queue.
 *
 * Assignee matching is the one piece of this file the caller should not
 * fully trust yet: it compares `assigneePersonaIds` against the caller's
 * own pubkey, but nothing in the company contract ties a human team
 * member's persona id to a pubkey the way `ManagedAgentRoster` does for
 * agents. Until that binding exists, `selfIdentifiers` is whatever the
 * caller can prove about itself - today, its own pubkey - and a task
 * assigned under a role slug rather than a raw pubkey will not match.
 */

export function isAssignedToAny(
  task: Pick<CompanyTask, "assigneePersonaIds">,
  selfIdentifiers: readonly string[],
): boolean {
  if (selfIdentifiers.length === 0) return false;
  const mine = new Set(selfIdentifiers.map((id) => id.toLowerCase()));
  return task.assigneePersonaIds.some((id) => mine.has(id.toLowerCase()));
}

/** Statuses the queue shows: live human work, not yet finished or parked. */
const QUEUE_STATUSES = new Set(["ready", "inProgress", "inReview"]);

export function isQueueEligible(
  task: CompanyTask,
  selfIdentifiers: readonly string[],
): boolean {
  return (
    task.doerKind === "human" &&
    QUEUE_STATUSES.has(task.status) &&
    isAssignedToAny(task, selfIdentifiers)
  );
}

export function selectMyQueue(
  tasks: readonly CompanyTask[],
  selfIdentifiers: readonly string[],
): CompanyTask[] {
  return tasks
    .filter((task) => isQueueEligible(task, selfIdentifiers))
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
}

/**
 * Whether the outcome buttons (Done, Disqualify, ...) apply to this card.
 * `ready` work has not been started - completing it would record work
 * nobody did - so only in-progress and in-review reach the completion
 * transition `plan_task_completion` builds.
 */
export function canCompleteFromQueue(
  task: Pick<CompanyTask, "status">,
): boolean {
  return task.status === "inProgress" || task.status === "inReview";
}

/**
 * Bounce is well-defined only when the task depends on exactly one upstream
 * task: bouncing means "send THIS deliverable back", and with zero or
 * multiple dependencies there is no single task to name.
 */
export function bounceTargetTaskId(
  task: Pick<CompanyTask, "dependsOn">,
): string | null {
  return task.dependsOn.length === 1 ? (task.dependsOn[0] ?? null) : null;
}
