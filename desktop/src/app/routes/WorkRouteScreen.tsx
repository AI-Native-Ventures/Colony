import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  tasksQueryKey,
  useActiveCompany,
  useCompanyTasks,
  useInitiatives,
} from "@/features/company/hooks";
import { queueActioner } from "@/features/company/queueActions";
import { selectTaskRuns } from "@/features/company/taskRuns";
import { TaskListScreen } from "@/features/company/ui/TaskListScreen";
import { TaskBoardScreen } from "@/features/company/ui/TaskBoardScreen";
import { TaskQueueScreen } from "@/features/company/ui/TaskQueueScreen";
import { buildTasksById } from "@/features/company/workBoardModel";
import {
  bounceTargetTaskId,
  selectMyQueue,
} from "@/features/company/workQueueModel";
import {
  buildWorkListRows,
  filterWorkRows,
  type WorkListRow,
} from "@/features/company/workListModel";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { RelayEvent } from "@/shared/api/types";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_JOB_HEAD } from "@/shared/constants/kinds";
import { Route as WorkRoute } from "./work";

const NO_EVENTS: RelayEvent[] = [];
/** A queue snooze has no picker yet - it parks the card for a day. */
const DEFAULT_SNOOZE_SECONDS = 24 * 60 * 60;

export function WorkRouteScreen() {
  const search = WorkRoute.useSearch();
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";

  const companyQuery = useActiveCompany(communityId);
  const companyId = companyQuery.data?.ok ? companyQuery.data.value.id : null;
  const tasksQuery = useCompanyTasks(
    communityId,
    { companyId: companyId ?? undefined },
    companyId !== null,
  );
  const initiativesQuery = useInitiatives(communityId, companyId);

  const tasks = tasksQuery.data?.ok ? tasksQuery.data.value : [];
  // Sorted so the runs query key is stable across refetches.
  const taskIds = React.useMemo(
    () => tasks.map((task) => task.id).sort(),
    [tasks],
  );
  const runsQuery = useQuery({
    queryKey: ["colony-work", communityId, "task-runs", taskIds],
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_JOB_HEAD],
        "#task": taskIds,
        limit: 500,
      }),
    enabled: communityId !== "" && taskIds.length > 0,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const runEvents = runsQuery.data ?? NO_EVENTS;
  const rows: WorkListRow[] = React.useMemo(
    () =>
      buildWorkListRows(
        tasks,
        selectTaskRuns(tasks, runEvents),
        Math.floor(Date.now() / 1000),
      ),
    [tasks, runEvents],
  );

  const error =
    companyQuery.error instanceof Error
      ? companyQuery.error
      : tasksQuery.error instanceof Error
        ? tasksQuery.error
        : companyQuery.data && !companyQuery.data.ok
          ? new Error(companyQuery.data.message)
          : tasksQuery.data && !tasksQuery.data.ok
            ? new Error(tasksQuery.data.message)
            : null;

  const initiatives = initiativesQuery.data?.ok
    ? initiativesQuery.data.value
    : [];
  const isLoading =
    (communityId !== "" && companyQuery.isLoading) ||
    (companyId !== null && tasksQuery.isLoading);

  // Dependencies can reach across initiatives, so the blocked-by count
  // resolves against every fetched task, not just the board's narrowed
  // set - a dependency on a task in another initiative must still show as
  // unsatisfied rather than silently vanish.
  const tasksById = React.useMemo(() => buildTasksById(tasks), [tasks]);
  const boardRows = React.useMemo(
    () =>
      search.initiativeId === undefined
        ? []
        : filterWorkRows(rows, {
            initiativeId: search.initiativeId,
            showImplicit: false,
          }),
    [rows, search.initiativeId],
  );

  const identityQuery = useIdentityQuery();
  const selfPubkey = identityQuery.data?.pubkey ?? null;
  const queue = React.useMemo(
    () => (selfPubkey ? selectMyQueue(tasks, [selfPubkey]) : []),
    [tasks, selfPubkey],
  );
  const initiativeTitleById = React.useMemo(
    () => new Map(initiatives.map((entry) => [entry.id, entry.title])),
    [initiatives],
  );
  const queryClient = useQueryClient();
  const [pendingTaskId, setPendingTaskId] = React.useState<string | null>(null);

  const runQueueAction = React.useCallback(
    async (
      taskId: string,
      action: () => Promise<
        { status: "applied" } | { status: "blocked"; message: string }
      >,
    ) => {
      setPendingTaskId(taskId);
      try {
        const outcome = await action();
        if (outcome.status === "blocked") {
          toast.error(outcome.message);
          return;
        }
        await queryClient.invalidateQueries({
          queryKey: tasksQueryKey(communityId, {
            companyId: companyId ?? undefined,
          }),
        });
      } catch (thrown) {
        toast.error(
          thrown instanceof Error ? thrown.message : "That didn't go through.",
        );
      } finally {
        setPendingTaskId(null);
      }
    },
    [queryClient, communityId, companyId],
  );

  const handleQueueComplete = React.useCallback(
    (taskId: string, outcomeReason: string) =>
      runQueueAction(taskId, () =>
        queueActioner.completeTask(taskId, outcomeReason),
      ),
    [runQueueAction],
  );
  const handleQueueSnooze = React.useCallback(
    (taskId: string) =>
      runQueueAction(taskId, () =>
        queueActioner.snoozeTask(
          taskId,
          Math.floor(Date.now() / 1000) + DEFAULT_SNOOZE_SECONDS,
        ),
      ),
    [runQueueAction],
  );
  const handleQueueBounce = React.useCallback(
    (taskId: string, reason: string) => {
      const task = tasks.find((entry) => entry.id === taskId);
      const upstreamId = task ? bounceTargetTaskId(task) : null;
      if (!upstreamId) {
        toast.error("This task has no single upstream to bounce.");
        return Promise.resolve();
      }
      return runQueueAction(taskId, () =>
        queueActioner.bounceUpstreamTask(upstreamId, reason),
      );
    },
    [runQueueAction, tasks],
  );

  if (search.view === "queue") {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <TaskQueueScreen
          error={error}
          initiativeTitleById={initiativeTitleById}
          isLoading={isLoading}
          onBounce={handleQueueBounce}
          onComplete={handleQueueComplete}
          onSnooze={handleQueueSnooze}
          pendingTaskId={pendingTaskId}
          queue={queue}
        />
      </div>
    );
  }

  if (search.view === "board") {
    const initiative =
      search.initiativeId !== undefined
        ? (initiatives.find((entry) => entry.id === search.initiativeId) ??
          null)
        : null;

    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <TaskBoardScreen
          error={error}
          initiative={initiative}
          initiatives={initiatives}
          isLoading={isLoading}
          rows={boardRows}
          tasksById={tasksById}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <TaskListScreen
        error={error}
        initiatives={initiatives}
        isLoading={isLoading}
        rows={rows}
      />
    </div>
  );
}
