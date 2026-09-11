import type * as React from "react";
import { ExternalLink } from "lucide-react";

import type { CompanyTask } from "@/features/company/contracts";
import {
  ExecutionDot,
  StatusPill,
} from "@/features/company/ui/taskStatusPresentation";
import { shortIdLabel } from "@/features/company/workListModel";
import type { TaskExecutionState } from "@/features/company/taskThreadModel";
import {
  assigneeInitials,
  pullRequestLabel,
  type BoardColumn,
} from "@/features/factory/lib/boardModel";
import { cn } from "@/shared/lib/cn";

/**
 * The board's three columns of ticket cards.
 *
 * A card carries only what stays readable at tile width: what kind of work it
 * is, its title, who holds it, the PR it produced, and whether its run has
 * stalled. Everything else is one click away in the detail pane.
 */

export type BoardCardMeta = {
  execution: TaskExecutionState;
  stalled: boolean;
  pullRequestUrl: string | null;
};

/** A task's kind badge: its stage when it has one, else who does the work. */
function kindBadge(task: CompanyTask): string {
  if (task.stage) return shortIdLabel(task.stage);
  if (task.subject) return task.subject.kind;
  return task.doerKind;
}

export function AssigneeChip({
  personaId,
  title,
}: {
  personaId: string;
  title?: string;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-semibold uppercase text-muted-foreground"
      data-testid="factory-board-assignee"
      title={title ?? personaId}
    >
      {assigneeInitials(personaId)}
    </span>
  );
}

function BoardCard({
  meta,
  onSelect,
  selected,
  task,
}: {
  meta: BoardCardMeta;
  onSelect: (taskId: string) => void;
  selected: boolean;
  task: CompanyTask;
}): React.JSX.Element {
  return (
    <li>
      <button
        className={cn(
          "w-full rounded-lg border bg-card px-2.5 py-2 text-left shadow-sm transition-colors hover:border-muted-foreground/40",
          selected ? "border-primary/60" : "border-border/60",
        )}
        data-task-id={task.id}
        data-testid="factory-board-card"
        onClick={() => onSelect(task.id)}
        type="button"
      >
        <div className="flex items-center gap-1.5">
          <span
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground"
            data-testid="factory-board-card-kind"
          >
            {kindBadge(task)}
          </span>
          <ExecutionDot execution={meta.execution} />
          {meta.stalled ? (
            <span
              className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-3xs font-medium leading-none text-amber-600 dark:text-amber-400"
              data-testid="factory-board-card-stalled"
            >
              stalled
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 line-clamp-2 text-xs font-medium text-foreground">
          {task.title}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <StatusPill status={task.status} />
          {task.assigneePersonaIds.slice(0, 3).map((personaId) => (
            <AssigneeChip key={personaId} personaId={personaId} />
          ))}
          <span className="flex-1" />
          {meta.pullRequestUrl ? (
            <a
              className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
              data-testid="factory-board-card-pr"
              href={meta.pullRequestUrl}
              onClick={(event) => event.stopPropagation()}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden className="size-3" />
              {pullRequestLabel(meta.pullRequestUrl)}
            </a>
          ) : null}
        </div>
      </button>
    </li>
  );
}

export function BoardColumns({
  columns,
  metaByTaskId,
  onSelect,
  selectedTaskId,
}: {
  columns: readonly BoardColumn[];
  metaByTaskId: ReadonlyMap<string, BoardCardMeta>;
  onSelect: (taskId: string) => void;
  selectedTaskId: string | null;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
      {columns.map((column) => (
        <div
          className="flex w-56 shrink-0 flex-col rounded-xl bg-muted/20 p-2"
          data-testid={`factory-board-column-${column.key}`}
          key={column.key}
        >
          <div className="flex items-center justify-between px-1 pb-2">
            <h3 className="truncate text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {column.label}
            </h3>
            <span
              className="shrink-0 text-2xs tabular-nums text-muted-foreground"
              data-testid={`factory-board-count-${column.key}`}
            >
              {column.tasks.length}
            </span>
          </div>
          <ul className="flex min-h-8 flex-col gap-1.5 overflow-y-auto">
            {column.tasks.map((task) => {
              const meta = metaByTaskId.get(task.id);
              if (!meta) return null;
              return (
                <BoardCard
                  key={task.id}
                  meta={meta}
                  onSelect={onSelect}
                  selected={selectedTaskId === task.id}
                  task={task}
                />
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
