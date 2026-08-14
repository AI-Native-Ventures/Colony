import type { CompanyTask } from "@/features/company/contracts";
import {
  collapseAndSelectCurrentTaskRun,
  type TaskRunContext,
  type TaskRunHead,
} from "@/features/company/taskRunContracts";
import type { RelayEvent } from "@/shared/api/types";
import type { ActionTaskSource } from "../contracts";

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
  const runs = new Map<string, TaskRunHead | null>();
  for (const task of tasks) {
    const context = taskContext(task);
    runs.set(
      task.id,
      context ? collapseAndSelectCurrentTaskRun(events, context) : null,
    );
  }
  return runs;
}

export function buildTaskSources(
  tasks: readonly CompanyTask[],
  events: readonly RelayEvent[],
): ActionTaskSource[] {
  const runs = selectTaskRuns(tasks, events);
  return tasks.map((task) => ({
    kind: "task" as const,
    task,
    run: runs.get(task.id) ?? null,
    channelId: task.sourceChannelId || null,
    threadId: task.sourceEventId || null,
  }));
}
