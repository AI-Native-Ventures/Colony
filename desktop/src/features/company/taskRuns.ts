import type { CompanyTask } from "./contracts";
import {
  collapseAndSelectCurrentTaskRuns,
  type TaskRunContext,
  type TaskRunHead,
} from "./taskRunContracts";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The newest valid run per task, from one bounded Job-head read.
 *
 * A run head is only evidence inside the task/channel/thread scope its tags
 * declare, so every candidate head is validated against the context derived
 * from its own task before it can stand for that task's execution state.
 */
function taskContext(task: CompanyTask): TaskRunContext | null {
  if (!task.sourceChannelId || !task.sourceEventId) return null;
  return {
    taskId: task.id,
    channelId: task.sourceChannelId,
    threadId: task.sourceEventId,
  };
}

export function selectTaskRuns(
  tasks: readonly CompanyTask[],
  events: readonly RelayEvent[],
): ReadonlyMap<string, TaskRunHead | null> {
  const contexts = tasks.flatMap((task) => {
    const context = taskContext(task);
    return context ? [context] : [];
  });
  const selected = collapseAndSelectCurrentTaskRuns(events, contexts);
  return new Map(tasks.map((task) => [task.id, selected.get(task.id) ?? null]));
}
