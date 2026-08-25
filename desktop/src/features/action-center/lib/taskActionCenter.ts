import type { CompanyTask } from "@/features/company/contracts";
import type { TaskRunHead } from "@/features/company/taskRunContracts";
import { selectTaskRuns } from "@/features/company/taskRuns";
import type { RelayEvent } from "@/shared/api/types";
import type { ActionTaskSource } from "../contracts";

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
