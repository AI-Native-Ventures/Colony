import { useQuery } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";

import { companyRepository } from "./companyRepository";
import type { CompanyTask } from "./contracts";
import { taskRunRepository, type TaskRunReadResult } from "./taskRunRepository";
import type { TaskRunHead } from "./taskRunContracts";

const TASK_THREAD_ROOT = "colony-task-thread" as const;

function taskOrThrow(
  result: Awaited<ReturnType<typeof companyRepository.getTask>>,
) {
  if (!result.ok && result.code === "unavailable")
    throw new Error(result.message);
  return result.ok ? result.value : null;
}

function runOrThrow(result: TaskRunReadResult): TaskRunHead | null {
  if (!result.ok && result.code === "unavailable")
    throw new Error(result.message);
  return result.ok ? result.value : null;
}

/** Live-enough read model for one canonical task thread. */
export function useTaskThreadContext(input: {
  taskId: string;
  channelId: string;
  threadId: string;
}) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const taskQuery = useQuery<CompanyTask | null>({
    queryKey: [TASK_THREAD_ROOT, communityId, input.taskId, "task"],
    queryFn: async () =>
      taskOrThrow(await companyRepository.getTask(input.taskId)),
    enabled: communityId !== "",
    staleTime: 15_000,
  });
  const runQuery = useQuery<TaskRunHead | null>({
    queryKey: [
      TASK_THREAD_ROOT,
      communityId,
      input.taskId,
      input.channelId,
      input.threadId,
      "run",
    ],
    queryFn: async () =>
      runOrThrow(await taskRunRepository.getCurrentRun(input)),
    enabled: communityId !== "",
    staleTime: 3_000,
    refetchInterval: (query) => {
      const run = query.state.data;
      return run?.runStatus === "delivered" ||
        run?.runStatus === "failed" ||
        run?.runStatus === "abandoned"
        ? 30_000
        : 5_000;
    },
  });
  return { taskQuery, runQuery };
}
