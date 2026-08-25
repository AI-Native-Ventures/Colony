import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { relayClient } from "@/shared/api/relayClient";
import { useNow } from "@/shared/lib/useNow";
import type { RelayEvent } from "@/shared/api/types";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { CompanyTask } from "@/features/company/contracts";
import { shortIdLabel, formatTaskAge } from "@/features/company/workListModel";
import type { TaskRunHead } from "@/features/company/taskRunContracts";
import {
  deriveTaskExecutionState,
  splitThreadTasks,
} from "@/features/company/taskThreadModel";
import { useCommunities } from "@/features/communities/useCommunities";
import { selectTaskRuns } from "@/features/company/taskRuns";
import { useThreadTasks } from "@/features/company/hooks";
import { KIND_JOB_HEAD } from "@/shared/constants/kinds";
import { cn } from "@/shared/lib/cn";

import { StatusPill, ExecutionDot } from "./taskStatusPresentation";
import { TaskDetailSheet } from "./TaskDetailSheet";
import { TaskThreadContext } from "./TaskThreadContext";

/**
 * The thread surface's work half.
 *
 * R4: the task points at the thread, never the reverse. Everything rendered
 * here is a query on `thread_root` (`useThreadTasks`); no tag on the thread
 * event is rewritten when the active task changes, because rewriting signed
 * tags would mean LWW conflicts and lost history.
 *
 * The one exception this surface tolerates is a legacy canonical thread
 * whose head carries an explicit `task` tag: that thread keeps its full
 * `TaskThreadContext` panel, and the query-driven chip suppresses itself for
 * that same task so the record never renders twice. New threads carry no
 * such tag and get the chip alone.
 */

const NO_EVENTS: RelayEvent[] = [];

function ThreadTaskChip({
  channelName,
  channelId,
  nowSeconds,
  runsByTaskId,
  task,
  threadRoot,
}: {
  channelName: string;
  channelId: string;
  nowSeconds: number;
  runsByTaskId: ReadonlyMap<string, TaskRunHead | null>;
  task: CompanyTask;
  threadRoot: string;
}) {
  const execution = deriveTaskExecutionState(
    runsByTaskId.get(task.id) ?? null,
    nowSeconds,
  );
  return (
    <div
      className="flex items-center gap-2 rounded-full border border-border/70 bg-muted/30 px-2.5 py-1"
      data-testid="thread-task-chip"
    >
      <ExecutionDot execution={execution} />
      <span className="min-w-0 truncate text-xs font-medium text-foreground">
        {task.title}
      </span>
      <StatusPill status={task.status} />
      <TaskDetailSheet
        channelId={channelId}
        channelName={channelName}
        execution={execution}
        ownerLabel={shortIdLabel(task.owningTeamId)}
        qaLabel={task.qaPersonaId}
        run={runsByTaskId.get(task.id) ?? null}
        task={task}
        threadId={task.threadRoot ?? threadRoot}
        triggerLabel="Open task"
      />
    </div>
  );
}

function EarlierTasksDisclosure({
  earlier,
  nowSeconds,
}: {
  earlier: readonly CompanyTask[];
  nowSeconds: number;
}) {
  const [open, setOpen] = React.useState(false);
  if (earlier.length === 0) return null;
  return (
    <div data-testid="thread-earlier-tasks">
      <button
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        data-testid="thread-earlier-tasks-toggle"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ChevronDown
          className={cn("size-3 transition-transform", open && "rotate-180")}
        />
        {earlier.length} earlier task{earlier.length === 1 ? "" : "s"}
      </button>
      {open ? (
        <ul className="mt-1 space-y-1">
          {earlier.map((task) => (
            <li
              className="flex items-center gap-2 text-xs text-muted-foreground"
              key={task.id}
            >
              <span className="truncate">{task.title}</span>
              <StatusPill status={task.status} />
              <span className="tabular-nums">
                {formatTaskAge(task.updatedAt, nowSeconds)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ThreadWorkSurface({
  canonicalTaskId,
  channelId,
  channelName,
  className,
  profiles,
  threadId,
  threadRoot,
}: {
  canonicalTaskId: string | null;
  channelId: string;
  channelName: string;
  /** Layout class owned by the mounting surface, e.g. the thread gutter. */
  className?: string;
  profiles?: UserProfileLookup;
  threadId: string;
  threadRoot: string;
}) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const tasksQuery = useThreadTasks(communityId, threadRoot);
  const nowSeconds = Math.floor(useNow(30_000) / 1000);

  const tasks = tasksQuery.data?.ok ? tasksQuery.data.value : [];
  const { live, earlier } = React.useMemo(
    () => splitThreadTasks(tasks),
    [tasks],
  );
  // The legacy panel already renders the full record for this task.
  const chipTasks =
    canonicalTaskId !== null
      ? live.filter((task) => task.id !== canonicalTaskId)
      : live;
  const runTaskIds = React.useMemo(
    () => [...new Set([...chipTasks.map((t) => t.id)])].sort(),
    [chipTasks],
  );
  const runsQuery = useQuery({
    queryKey: [
      "colony-work",
      communityId,
      "thread-runs",
      threadRoot,
      runTaskIds,
    ],
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_JOB_HEAD],
        "#task": runTaskIds,
        limit: 200,
      }),
    enabled: communityId !== "" && runTaskIds.length > 0,
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
  const runsByTaskId = React.useMemo(
    () => selectTaskRuns(chipTasks, runsQuery.data ?? NO_EVENTS),
    [chipTasks, runsQuery.data],
  );

  const hasCanonicalPanel = canonicalTaskId !== null && channelId !== "";
  if (!hasCanonicalPanel && chipTasks.length === 0 && earlier.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("flex flex-col gap-1.5", className)}
      data-testid="thread-work-surface"
    >
      {chipTasks.map((task) => (
        <ThreadTaskChip
          channelName={channelName}
          channelId={channelId}
          key={task.id}
          nowSeconds={nowSeconds}
          runsByTaskId={runsByTaskId}
          task={task}
          threadRoot={threadRoot}
        />
      ))}
      <EarlierTasksDisclosure earlier={earlier} nowSeconds={nowSeconds} />
      {hasCanonicalPanel ? (
        <TaskThreadContext
          channelId={channelId}
          channelName={channelName}
          profiles={profiles}
          taskId={canonicalTaskId}
          threadId={threadId}
        />
      ) : null}
    </div>
  );
}
