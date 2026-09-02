import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  initiativesQueryKey,
  tasksQueryKey,
  useCompanyTasks,
  useInitiatives,
} from "@/features/company/hooks";
import { queueActioner } from "@/features/company/queueActions";
import { selectTaskRuns } from "@/features/company/taskRuns";
import type { CompanyTask } from "@/features/company/contracts";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { initiativeRows } from "@/features/company/initiativesModel";
import { InitiativesScreen } from "@/features/company/ui/InitiativesScreen";
import { NewTaskDialog } from "@/features/company/ui/NewTaskDialog";
import { WorkTopTabs } from "@/features/company/ui/WorkTopTabs";
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
import { useChannelsQuery } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { RelayEvent } from "@/shared/api/types";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_JOB_HEAD } from "@/shared/constants/kinds";
import { Route as WorkRoute } from "./work";
import { workView } from "./workSearch";

const NO_EVENTS: RelayEvent[] = [];

export function WorkRouteScreen() {
  const search = WorkRoute.useSearch();
  const view = workView(search);
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";

  // No company gate. Work belongs to the community, so the only thing these
  // wait on is the community itself being resolved.
  const tasksQuery = useCompanyTasks(communityId, {});
  const initiativesQuery = useInitiatives(communityId);

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
    tasksQuery.error instanceof Error
      ? tasksQuery.error
      : tasksQuery.data && !tasksQuery.data.ok
        ? new Error(tasksQuery.data.message)
        : null;

  const initiatives = initiativesQuery.data?.ok
    ? initiativesQuery.data.value
    : [];
  const isLoading = communityId !== "" && tasksQuery.isLoading;

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

  const channelsQuery = useChannelsQuery();
  const memberChannels = React.useMemo(
    () => (channelsQuery.data ?? []).filter((channel) => channel.isMember),
    [channelsQuery.data],
  );
  const [isNewTaskOpen, setIsNewTaskOpen] = React.useState(false);
  const handleOpenNewTask = React.useCallback(() => setIsNewTaskOpen(true), []);
  const { goChannel, goWorkBoard } = useAppNavigation();
  // Open where the work is actually happening. A chat-attributed task carries
  // the send it came from, so the row lands on that message; a task created by
  // hand has only its channel, and lands there.
  const handleOpenTask = React.useCallback(
    (task: CompanyTask) => {
      if (!task.sourceChannelId) return;
      void goChannel(task.sourceChannelId, {
        messageId: task.sourceEventId ?? undefined,
        threadRootId: task.threadRoot ?? undefined,
      });
    },
    [goChannel],
  );
  const handleTaskCreated = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: tasksQueryKey(communityId, {}),
    });
  }, [queryClient, communityId]);

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
          queryKey: tasksQueryKey(communityId, {}),
        });
      } catch (thrown) {
        toast.error(
          thrown instanceof Error ? thrown.message : "That didn't go through.",
        );
      } finally {
        setPendingTaskId(null);
      }
    },
    [queryClient, communityId],
  );

  const handleQueueComplete = React.useCallback(
    (taskId: string, outcomeReason: string) =>
      runQueueAction(taskId, () =>
        queueActioner.completeTask(taskId, outcomeReason),
      ),
    [runQueueAction],
  );
  const handleQueueSnooze = React.useCallback(
    // `wakeAt` comes from the queue card's picker, which shares its presets
    // and its "must be in the future" guard with the reminders snooze.
    (taskId: string, wakeAt: number) =>
      runQueueAction(taskId, () => queueActioner.snoozeTask(taskId, wakeAt)),
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

  const initiativeListRows = React.useMemo(
    () => initiativeRows(initiatives, tasks),
    [initiatives, tasks],
  );
  const handleOpenInitiative = React.useCallback(
    (initiativeId: string) => {
      void goWorkBoard(initiativeId);
    },
    [goWorkBoard],
  );
  const handleInitiativeCreated = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: initiativesQueryKey(communityId),
    });
  }, [queryClient, communityId]);

  const boardInitiative =
    search.initiativeId !== undefined
      ? (initiatives.find((entry) => entry.id === search.initiativeId) ?? null)
      : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <WorkTopTabs initiativeId={search.initiativeId} view={view} />
      {view === "queue" ? (
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
      ) : null}

      {view === "initiatives" ? (
        <InitiativesScreen
          channels={memberChannels}
          communityId={communityId}
          error={error}
          isLoading={isLoading}
          onCreated={handleInitiativeCreated}
          onOpenInitiative={handleOpenInitiative}
          rows={initiativeListRows}
        />
      ) : null}

      {view === "board" ? (
        <TaskBoardScreen
          error={error}
          initiative={boardInitiative}
          initiatives={initiatives}
          isLoading={isLoading}
          onNewTask={handleOpenNewTask}
          rows={boardRows}
          tasksById={tasksById}
        />
      ) : null}

      {view === "list" ? (
        <TaskListScreen
          error={error}
          initiatives={initiatives}
          isLoading={isLoading}
          onNewTask={handleOpenNewTask}
          onOpenTask={handleOpenTask}
          rows={rows}
        />
      ) : null}

      {view === "board" || view === "list" ? (
        <NewTaskDialog
          channels={memberChannels}
          onCreated={handleTaskCreated}
          onOpenChange={setIsNewTaskOpen}
          open={isNewTaskOpen}
        />
      ) : null}
    </div>
  );
}
