import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { useChannelsQuery } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import {
  tasksQueryKey,
  useCompanyTasks,
  useInitiatives,
} from "@/features/company/hooks";
import { selectTaskRuns } from "@/features/company/taskRuns";
import { deriveTaskExecutionState } from "@/features/company/taskThreadModel";
import { NewTaskDialog } from "@/features/company/ui/NewTaskDialog";
import { isStalledRow } from "@/features/company/workBoardModel";
import {
  boardAssigneeIds,
  projectBoard,
  taskPullRequestUrl,
} from "@/features/factory/lib/boardModel";
import { findProjectForChannel } from "@/features/factory/lib/projectChannel";
import {
  AssigneeChip,
  BoardColumns,
  type BoardCardMeta,
} from "@/features/factory/ui/BoardTileColumns";
import { BoardTileDetail } from "@/features/factory/ui/BoardTileDetail";
import { useProjectsQuery } from "@/features/projects/hooks";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_JOB_HEAD } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";

/**
 * One project's tickets, as a workspace tile: the story at the top, three
 * columns of cards under it, and the ticket you clicked in a pane on the
 * right.
 *
 * The tile reads the same company tasks the Work board does - agents keep
 * writing them through the CLI, and this surface is a view of that record,
 * never a second store. Scoping to the project happens in `projectBoard`.
 */

const NO_EVENTS: RelayEvent[] = [];

export function BoardTile({ channelId }: TabBodyProps): React.JSX.Element {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const tasksQuery = useCompanyTasks(communityId, {});
  const initiativesQuery = useInitiatives(communityId);
  const projects = useProjectsQuery();
  const channelsQuery = useChannelsQuery();
  const queryClient = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(
    null,
  );
  const [isNewTicketOpen, setIsNewTicketOpen] = React.useState(false);

  const tasks = tasksQuery.data?.ok ? tasksQuery.data.value : [];
  const initiatives = initiativesQuery.data?.ok
    ? initiativesQuery.data.value
    : [];

  const board = React.useMemo(
    () => projectBoard({ channelId, initiatives, tasks }),
    [channelId, initiatives, tasks],
  );
  const boardTasks = React.useMemo(
    () => board.columns.flatMap((column) => column.tasks),
    [board],
  );
  // Sorted so the runs query key is stable across refetches.
  const taskIds = React.useMemo(
    () => boardTasks.map((task) => task.id).sort(),
    [boardTasks],
  );
  const runsQuery = useQuery({
    queryKey: ["colony-factory-board", communityId, "task-runs", taskIds],
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

  const metaByTaskId = React.useMemo(() => {
    const runs = selectTaskRuns(boardTasks, runsQuery.data ?? NO_EVENTS);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const meta = new Map<string, BoardCardMeta>();
    for (const task of boardTasks) {
      const run = runs.get(task.id) ?? null;
      const execution = deriveTaskExecutionState(run, nowSeconds);
      meta.set(task.id, {
        execution,
        pullRequestUrl: taskPullRequestUrl(task, run?.artifacts ?? []),
        stalled: isStalledRow({ execution, task }),
      });
    }
    return meta;
  }, [boardTasks, runsQuery.data]);

  const selectedTask =
    boardTasks.find((task) => task.id === selectedTaskId) ?? null;
  const project = findProjectForChannel(projects.data, channelId);
  const channel = (channelsQuery.data ?? []).find(
    (entry) => entry.id === channelId,
  );
  const memberChannels = React.useMemo(
    () => (channelsQuery.data ?? []).filter((entry) => entry.isMember),
    [channelsQuery.data],
  );
  const assignees = React.useMemo(() => boardAssigneeIds(board), [board]);
  const { done, total } = board.progress;

  const handleCreated = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: tasksQueryKey(communityId, {}),
    });
  }, [communityId, queryClient]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-testid="factory-board-tile"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2
            className="truncate text-sm font-semibold text-foreground"
            data-testid="factory-board-story"
          >
            {board.initiative?.title ?? project?.name ?? "Tickets"}
          </h2>
          <div className="mt-1 flex items-center gap-2">
            <Progress
              className="h-1.5 w-32"
              data-testid="factory-board-progress"
              value={total === 0 ? 0 : (done / total) * 100}
            />
            <span
              className="text-2xs tabular-nums text-muted-foreground"
              data-testid="factory-board-progress-label"
            >
              {done}/{total} done
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {assignees.slice(0, 5).map((personaId) => (
            <AssigneeChip key={personaId} personaId={personaId} />
          ))}
        </div>
        <div className="flex-1" />
        <Button
          data-testid="factory-board-new-ticket"
          onClick={() => setIsNewTicketOpen(true)}
          size="xs"
          title="Add a ticket to this project"
          variant="outline"
        >
          <Plus aria-hidden className="size-3" />
          Ticket
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <BoardColumns
          columns={board.columns}
          metaByTaskId={metaByTaskId}
          onSelect={setSelectedTaskId}
          selectedTaskId={selectedTaskId}
        />
        {selectedTask ? (
          <BoardTileDetail
            channelId={channelId}
            channelName={channel?.name ?? "channel"}
            execution={
              metaByTaskId.get(selectedTask.id)?.execution ?? {
                key: "untracked",
                label: "No execution record",
                tone: "neutral",
              }
            }
            key={selectedTask.id}
            onClose={() => setSelectedTaskId(null)}
            task={selectedTask}
          />
        ) : null}
      </div>

      <NewTaskDialog
        channels={memberChannels}
        defaultChannelId={channelId}
        onCreated={handleCreated}
        onOpenChange={setIsNewTicketOpen}
        open={isNewTicketOpen}
      />
    </div>
  );
}
