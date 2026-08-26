import type { TaskStatus } from "@/features/company/contracts";
import { statusPillTone } from "@/features/company/workListModel";
import type { TaskExecutionState } from "@/features/company/taskThreadModel";
import { cn } from "@/shared/lib/cn";

/**
 * Shared colour mapping for the two truths a task row shows: the business
 * status pill and the execution dot. Both TaskListScreen and the thread chip
 * render these identically so a status never changes meaning between views.
 */

const TONE_PILL_CLASS: Record<string, string> = {
  active: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  danger: "bg-red-500/15 text-red-600 dark:text-red-400",
  neutral: "bg-muted text-muted-foreground",
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const TONE_DOT_CLASS: Record<string, string> = {
  active: "bg-blue-500 motion-safe:animate-pulse",
  danger: "bg-red-500",
  neutral: "bg-muted-foreground/40",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
};

export function taskStatusPillClass(status: TaskStatus): string {
  return TONE_PILL_CLASS[statusPillTone(status)];
}

export function executionDotClass(execution: TaskExecutionState): string {
  return TONE_DOT_CLASS[execution.tone];
}

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium leading-none",
        taskStatusPillClass(status),
      )}
    >
      {status}
    </span>
  );
}

export function ExecutionDot({ execution }: { execution: TaskExecutionState }) {
  return (
    <span
      aria-label={execution.label}
      className={cn(
        "size-2 shrink-0 rounded-full",
        executionDotClass(execution),
      )}
      role="img"
      title={execution.label}
    />
  );
}
