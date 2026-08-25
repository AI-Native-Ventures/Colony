import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  useActiveCompany,
  useCompanyTasks,
  useInitiatives,
} from "@/features/company/hooks";
import { selectTaskRuns } from "@/features/company/taskRuns";
import { TaskListScreen } from "@/features/company/ui/TaskListScreen";
import { TaskBoardScreen } from "@/features/company/ui/TaskBoardScreen";
import { buildTasksById } from "@/features/company/workBoardModel";
import {
  buildWorkListRows,
  filterWorkRows,
  type WorkListRow,
} from "@/features/company/workListModel";
import { useCommunities } from "@/features/communities/useCommunities";
import type { RelayEvent } from "@/shared/api/types";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_JOB_HEAD } from "@/shared/constants/kinds";
import { Route as WorkRoute } from "./work";

const NO_EVENTS: RelayEvent[] = [];

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
