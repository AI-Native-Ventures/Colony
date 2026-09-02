import * as React from "react";
import { LayoutGrid, Plus } from "lucide-react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { CompanyTask, Initiative } from "@/features/company/contracts";
import {
  groupWorkRows,
  shortIdLabel,
  WORK_LIST_GROUP_LABELS,
  type WorkListRow,
} from "@/features/company/workListModel";
import {
  BOARD_DEFAULT_GROUP,
  BOARD_GROUPS,
  countStalledRows,
  unsatisfiedDependsOnCount,
  type BoardGroupKey,
} from "@/features/company/workBoardModel";
import {
  ExecutionDot,
  StatusPill,
} from "@/features/company/ui/taskStatusPresentation";
import { ToolbarSelect } from "@/features/company/ui/ToolbarSelect";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Skeleton } from "@/shared/ui/skeleton";

/**
 * The board: one initiative, columns as a chosen dimension (stage by
 * default - a funnel of where work is stuck, not a status count). A card
 * shows only what stays scannable at ~100 cards: subject, execution dot,
 * status pill, and a blocked-by count when a dependency is unsatisfied.
 * Everything else lives in the detail sheet, not here.
 *
 * Presentational, same shape as TaskListScreen: the caller fetches and
 * assembles rows already scoped to the chosen initiative; this file owns
 * layout and its one local control (column dimension).
 */

function BoardCard({
  row,
  tasksById,
}: {
  row: WorkListRow;
  tasksById: ReadonlyMap<string, CompanyTask>;
}) {
  const { task, execution } = row;
  const blockedBy = unsatisfiedDependsOnCount(task, tasksById);
  const headline = task.subject ? shortIdLabel(task.subject.ref) : task.title;
  return (
    <li
      className="rounded-lg border border-border/60 bg-card px-2.5 py-2 shadow-sm"
      data-task-id={task.id}
      data-testid="board-card"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <ExecutionDot execution={execution} />
        <span className="truncate text-xs font-medium text-foreground">
          {headline}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <StatusPill status={task.status} />
        {blockedBy > 0 ? (
          <span
            className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium leading-none text-muted-foreground"
            data-testid="board-card-blocked"
          >
            {blockedBy} blocked
          </span>
        ) : null}
      </div>
    </li>
  );
}

function BoardColumn({
  group,
  tasksById,
}: {
  group: { key: string; label: string; rows: WorkListRow[] };
  tasksById: ReadonlyMap<string, CompanyTask>;
}) {
  return (
    <div
      className="flex w-64 shrink-0 flex-col rounded-xl bg-muted/20 p-2"
      data-testid="board-column"
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <h3 className="truncate text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {group.label}
        </h3>
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {group.rows.length}
        </span>
      </div>
      <ul className="flex min-h-8 flex-col gap-1.5 overflow-y-auto">
        {group.rows.map((row) => (
          <BoardCard key={row.task.id} row={row} tasksById={tasksById} />
        ))}
      </ul>
    </div>
  );
}

function LoadingState() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading board"
      className="flex gap-3"
      role="status"
    >
      {[0, 1, 2].map((index) => (
        <Skeleton className="h-64 w-64 shrink-0 rounded-xl" key={index} />
      ))}
    </div>
  );
}

function NoInitiativeSelected({ initiatives }: { initiatives: Initiative[] }) {
  const { goWorkInitiatives } = useAppNavigation();
  return (
    <div className="rounded-2xl border border-dashed border-border/70 px-5 py-12 text-center">
      <LayoutGrid
        aria-hidden
        className="mx-auto size-8 text-muted-foreground"
      />
      <h2 className="mt-3 text-base font-semibold text-foreground">
        Pick an initiative to board
      </h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        The board shows one initiative's tasks as a stage funnel. Choose one on
        the Initiatives tab to see it.
      </p>
      <Button
        className="mt-4"
        data-testid="board-open-initiatives"
        onClick={() => {
          void goWorkInitiatives();
        }}
        variant="outline"
      >
        Browse initiatives
      </Button>
      {initiatives.length > 0 ? (
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="board-initiative-hint"
        >
          {initiatives.length} initiative
          {initiatives.length === 1 ? "" : "s"} available
        </p>
      ) : null}
    </div>
  );
}

export function TaskBoardScreen({
  error,
  initiative,
  initiatives,
  isLoading,
  onNewTask,
  rows,
  tasksById,
}: {
  error: Error | null;
  initiative: Initiative | null;
  initiatives: Initiative[];
  isLoading: boolean;
  onNewTask: () => void;
  rows: WorkListRow[];
  tasksById: ReadonlyMap<string, CompanyTask>;
}) {
  const [groupKey, setGroupKey] =
    React.useState<BoardGroupKey>(BOARD_DEFAULT_GROUP);

  const groups = React.useMemo(
    () => groupWorkRows(rows, groupKey),
    [rows, groupKey],
  );
  const stalled = React.useMemo(() => countStalledRows(rows), [rows]);

  const groupValueLabels = React.useMemo(() => {
    const labels: Record<string, string> = {};
    for (const entry of BOARD_GROUPS) {
      labels[entry] = WORK_LIST_GROUP_LABELS[entry];
    }
    return labels;
  }, []);

  return (
    <div
      className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8"
      data-testid="task-board-page"
    >
      <div className="mx-auto w-full max-w-6xl">
        <PageHeader
          action={
            <Button data-testid="task-board-new-task" onClick={onNewTask}>
              <Plus aria-hidden />
              New task
            </Button>
          }
          description={
            initiative
              ? "Where this initiative's tasks are stuck, one column per stage."
              : "Pick an initiative from the sidebar to see its board."
          }
          title={initiative ? initiative.title : "Board"}
        />

        {initiative ? (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <ToolbarSelect
                label="Columns"
                onChange={(next) => setGroupKey(next as BoardGroupKey)}
                testId="board-group-select"
                value={groupKey}
                valueLabels={groupValueLabels}
                values={BOARD_GROUPS}
              />
              <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className={
                    stalled > 0
                      ? "size-2 rounded-full bg-amber-500"
                      : "size-2 rounded-full bg-muted-foreground/40"
                  }
                />
                <span data-testid="board-stalled-count">{stalled} stalled</span>
              </span>
            </div>

            <div className="mt-4">
              {isLoading ? <LoadingState /> : null}

              {!isLoading && error ? (
                <div
                  className="rounded-2xl border border-destructive/25 bg-destructive/5 px-5 py-8"
                  data-testid="board-error"
                  role="alert"
                >
                  <h2 className="text-base font-semibold text-foreground">
                    Board could not be loaded
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {error.message}
                  </p>
                </div>
              ) : null}

              {!isLoading && !error && rows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/70 px-5 py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    No tasks yet for this initiative.
                  </p>
                  <Button
                    className="mt-4"
                    data-testid="task-board-empty-new-task"
                    onClick={onNewTask}
                    size="sm"
                  >
                    <Plus aria-hidden />
                    New task
                  </Button>
                </div>
              ) : null}

              {!isLoading && !error && groups.length > 0 ? (
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {groups.map((group) => (
                    <BoardColumn
                      group={group}
                      key={group.key || "(none)"}
                      tasksById={tasksById}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div className="mt-5">
            <NoInitiativeSelected initiatives={initiatives} />
          </div>
        )}
      </div>
    </div>
  );
}
