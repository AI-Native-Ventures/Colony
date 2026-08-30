import * as React from "react";
import { ListTodo, Plus } from "lucide-react";

import type { Initiative } from "@/features/company/contracts";
import {
  countLiveTasks,
  filterWorkRows,
  formatTaskAge,
  groupWorkRows,
  shortIdLabel,
  sortWorkRows,
  WORK_LIST_GROUP_LABELS,
  WORK_LIST_GROUPS,
  WORK_LIST_SORT_LABELS,
  WORK_LIST_SORTS,
  type WorkListGroupKey,
  type WorkListRow,
  type WorkListSortKey,
} from "@/features/company/workListModel";
import {
  ExecutionDot,
  StatusPill,
} from "@/features/company/ui/taskStatusPresentation";
import { ToolbarSelect } from "@/features/company/ui/ToolbarSelect";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Skeleton } from "@/shared/ui/skeleton";
import { Switch } from "@/shared/ui/switch";

/**
 * The "All tasks" view: one place that lists everything the company is
 * working on, grouped by a real field.
 *
 * Presentational: the caller owns fetching and row assembly. Controls are
 * local state on purpose - group/sort/filter are view concerns, not data.
 */

function TaskRow({
  row,
  nowSeconds,
}: {
  nowSeconds: number;
  row: WorkListRow;
}) {
  const { task, execution } = row;
  const degraded = execution.tone === "warning" || execution.tone === "danger";
  return (
    <li
      className="flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/40"
      data-task-id={task.id}
      data-testid="task-list-row"
    >
      <span className="mt-1.5">
        <ExecutionDot execution={execution} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {task.title}
          </span>
          <StatusPill status={task.status} />
          {degraded ? (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-2xs font-medium leading-none text-amber-600 dark:text-amber-400">
              {execution.label}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
          <span>{shortIdLabel(task.owningTeamId)}</span>
          {task.assigneePersonaIds.length > 0 ? (
            <span>{task.assigneePersonaIds.map(shortIdLabel).join(", ")}</span>
          ) : null}
          {task.subject ? (
            <span>
              {task.subject.kind} · {task.subject.ref}
            </span>
          ) : null}
          {task.stage ? <span>{task.stage}</span> : null}
          <span className="tabular-nums">
            {formatTaskAge(task.updatedAt, nowSeconds)}
          </span>
        </div>
      </div>
    </li>
  );
}

function LoadingState() {
  return (
    <div aria-busy="true" aria-label="Loading tasks" role="status">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton className="mb-2 h-10 w-full rounded-lg" key={index} />
      ))}
    </div>
  );
}

function EmptyState({
  onNewTask,
  showingImplicit,
}: {
  onNewTask: () => void;
  showingImplicit: boolean;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border/70 px-5 py-12 text-center">
      <ListTodo aria-hidden className="mx-auto size-8 text-muted-foreground" />
      <h2 className="mt-3 text-base font-semibold text-foreground">
        No tasks here yet
      </h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        Tasks appear when work is created in chat or added to an initiative.
        {showingImplicit
          ? ""
          : " Chat-attributed tasks are filtered out; the toolbar toggle shows them."}
      </p>
      <Button
        className="mt-4"
        data-testid="task-list-empty-new-task"
        onClick={onNewTask}
        size="sm"
      >
        <Plus aria-hidden />
        New task
      </Button>
    </div>
  );
}

export function TaskListScreen({
  error,
  initiatives,
  isLoading,
  onNewTask,
  rows,
}: {
  error: Error | null;
  initiatives: Initiative[];
  isLoading: boolean;
  onNewTask: () => void;
  rows: WorkListRow[];
}) {
  const nowSeconds = useNowSeconds();
  const [groupKey, setGroupKey] = React.useState<WorkListGroupKey>("subject");
  const [sortKey, setSortKey] = React.useState<WorkListSortKey>("attention");
  const [showImplicit, setShowImplicit] = React.useState(false);
  const [initiativeFilter, setInitiativeFilter] = React.useState<string>("all");

  const visible = React.useMemo(
    () =>
      sortWorkRows(
        filterWorkRows(rows, {
          initiativeId: initiativeFilter === "all" ? null : initiativeFilter,
          showImplicit,
        }),
        sortKey,
      ),
    [rows, sortKey, showImplicit, initiativeFilter],
  );
  const groups = React.useMemo(
    () => groupWorkRows(visible, groupKey),
    [visible, groupKey],
  );

  const groupValueLabels = React.useMemo(() => {
    const labels: Record<string, string> = {};
    for (const entry of WORK_LIST_GROUPS) {
      labels[entry] = WORK_LIST_GROUP_LABELS[entry];
    }
    return labels;
  }, []);
  const sortValueLabels = React.useMemo(() => {
    const labels: Record<string, string> = {};
    for (const entry of WORK_LIST_SORTS) {
      labels[entry] = WORK_LIST_SORT_LABELS[entry];
    }
    return labels;
  }, []);
  const initiativeValueLabels = React.useMemo(() => {
    const labels: Record<string, string> = { all: "All initiatives" };
    for (const initiative of initiatives) {
      labels[initiative.id] = initiative.title;
    }
    return labels;
  }, [initiatives]);

  return (
    <div
      className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8"
      data-testid="task-list-page"
    >
      <div className="mx-auto w-full max-w-6xl">
        <PageHeader
          action={
            <Button data-testid="task-list-new-task" onClick={onNewTask}>
              <Plus aria-hidden />
              New task
            </Button>
          }
          description="Everything this company is working on, grouped by any field on the task."
          title="All tasks"
        />

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <ToolbarSelect
            label="Group"
            onChange={(next) => setGroupKey(next as WorkListGroupKey)}
            testId="task-group-select"
            value={groupKey}
            valueLabels={groupValueLabels}
            values={WORK_LIST_GROUPS}
          />
          <ToolbarSelect
            label="Sort"
            onChange={(next) => setSortKey(next as WorkListSortKey)}
            testId="task-sort-select"
            value={sortKey}
            valueLabels={sortValueLabels}
            values={WORK_LIST_SORTS}
          />
          <ToolbarSelect
            label="Initiative"
            onChange={setInitiativeFilter}
            testId="task-initiative-select"
            value={initiativeFilter}
            valueLabels={initiativeValueLabels}
            values={
              initiatives.length > 0
                ? ["all", ...initiatives.map((initiative) => initiative.id)]
                : ["all"]
            }
          />
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              aria-label="Show chat-attributed tasks"
              checked={showImplicit}
              data-testid="task-show-implicit"
              onCheckedChange={setShowImplicit}
            />
            Show chat-attributed tasks
          </span>
        </div>

        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="task-list-count"
        >
          {countLiveTasks(visible)} live of {visible.length} tasks shown
        </p>

        <div className="mt-4 space-y-6">
          {isLoading ? <LoadingState /> : null}

          {!isLoading && error ? (
            <div
              className="rounded-2xl border border-destructive/25 bg-destructive/5 px-5 py-8"
              data-testid="task-list-error"
              role="alert"
            >
              <h2 className="text-base font-semibold text-foreground">
                Tasks could not be loaded
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {error.message}
              </p>
            </div>
          ) : null}

          {!isLoading && !error && visible.length === 0 ? (
            <EmptyState onNewTask={onNewTask} showingImplicit={showImplicit} />
          ) : null}

          {!isLoading && !error && groups.length > 0
            ? groups.map((group) => (
                <section key={group.key || "(none)"}>
                  <h3
                    className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                    data-testid="task-group-label"
                  >
                    {group.label} · {group.rows.length}
                  </h3>
                  <ul className="mt-1">
                    {group.rows.map((row) => (
                      <TaskRow
                        key={row.task.id}
                        nowSeconds={nowSeconds}
                        row={row}
                      />
                    ))}
                  </ul>
                </section>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}

function useNowSeconds(intervalMs = 30_000): number {
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));
  React.useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      intervalMs,
    );
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
