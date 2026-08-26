import * as React from "react";
import { Inbox } from "lucide-react";

import type { CompanyTask } from "@/features/company/contracts";
import {
  bounceTargetTaskId,
  canCompleteFromQueue,
} from "@/features/company/workQueueModel";
import { formatTaskAge, shortIdLabel } from "@/features/company/workListModel";
import { StatusPill } from "@/features/company/ui/taskStatusPresentation";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Skeleton } from "@/shared/ui/skeleton";
import { SnoozeMenu } from "@/shared/ui/SnoozeMenu";
import { Textarea } from "@/shared/ui/textarea";

/**
 * The doer's queue: one card at a time, oldest first.
 *
 * Not the board. The board is for watching everything; this is for
 * finishing one thing, so it shows a card with the context already
 * assembled and buttons that ARE the outcome, rather than a table row.
 *
 * Deliberately absent from the card: acceptance criteria, tool scope, cost
 * ceiling, raw refs. Those belong on the task detail sheet, not here.
 *
 * `description` is listed as card material in the design brief, but
 * `CompanyTask` has no description field today - nothing to render there,
 * so this shows what the task actually carries: title, subject, stage, and
 * initiative. Inputs (the built site, the outreach pack, the contact) are
 * the same story: not a field yet, so not rendered, rather than invented.
 */

const GENERIC_OUTCOMES = [
  { label: "Done", tone: "ok" as const },
  { label: "Disqualify", tone: "danger" as const },
];

const OUTCOME_BUTTON_CLASS: Record<"ok" | "danger", string> = {
  danger: "border-destructive/40 text-destructive hover:bg-destructive/10",
  ok: "border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400",
};

function BounceDialog({
  disabled,
  onBounce,
  pending,
}: {
  disabled: boolean;
  onBounce: (reason: string) => Promise<void>;
  pending: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button
          className="ml-auto"
          data-testid="queue-bounce-trigger"
          disabled={disabled || pending}
          size="sm"
          variant="outline"
        >
          Bounce
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bounce this back</DialogTitle>
          <DialogDescription>
            Sends the upstream task back to ready with your reason attached. The
            upstream owner sees it on their own queue next.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          data-testid="queue-bounce-reason"
          onChange={(event) => setReason(event.target.value)}
          placeholder="What was wrong with it?"
          value={reason}
        />
        <DialogFooter>
          <Button
            data-testid="queue-bounce-submit"
            disabled={reason.trim() === "" || pending}
            onClick={async () => {
              await onBounce(reason.trim());
              setReason("");
              setOpen(false);
            }}
          >
            Bounce
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QueueCard({
  initiativeTitle,
  nowSeconds,
  onBounce,
  onComplete,
  onSnooze,
  pendingAction,
  task,
}: {
  initiativeTitle: string | null;
  nowSeconds: number;
  onBounce: (reason: string) => Promise<void>;
  onComplete: (outcomeReason: string) => Promise<void>;
  onSnooze: (wakeAt: number) => Promise<void>;
  pendingAction: string | null;
  task: CompanyTask;
}) {
  const headline = task.subject ? shortIdLabel(task.subject.ref) : task.title;
  const canComplete = canCompleteFromQueue(task);
  const canBounce = bounceTargetTaskId(task) !== null;
  const anyPending = pendingAction !== null;

  return (
    <div
      className="max-w-xl rounded-2xl border border-border/70 bg-card p-4 shadow-sm"
      data-task-id={task.id}
      data-testid="queue-card"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-foreground">
            {headline}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {task.title}
            {task.stage ? ` · ${task.stage}` : ""}
            {initiativeTitle ? ` · ${initiativeTitle}` : ""}
          </p>
        </div>
        <StatusPill status={task.status} />
      </div>

      <div className="mt-3 flex items-center gap-2 text-2xs text-muted-foreground">
        <span>{shortIdLabel(task.owningTeamId)}</span>
        <span>{formatTaskAge(task.updatedAt, nowSeconds)} old</span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canComplete
          ? GENERIC_OUTCOMES.map((outcome) => (
              <Button
                className={OUTCOME_BUTTON_CLASS[outcome.tone]}
                data-testid={`queue-outcome-${outcome.label.toLowerCase()}`}
                disabled={anyPending}
                key={outcome.label}
                onClick={() => onComplete(outcome.label)}
                size="sm"
                variant="outline"
              >
                {outcome.label}
              </Button>
            ))
          : null}
        <SnoozeMenu
          disabled={anyPending}
          label="Snooze"
          onSnooze={(wakeAt) => {
            void onSnooze(wakeAt);
          }}
          testId="queue-snooze"
        />
        <BounceDialog
          disabled={!canBounce || anyPending}
          onBounce={onBounce}
          pending={anyPending}
        />
      </div>
      {!canComplete ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          Not started yet - claim it to complete it.
        </p>
      ) : null}
    </div>
  );
}

function LoadingState() {
  return (
    <div aria-busy="true" aria-label="Loading queue" role="status">
      <Skeleton className="h-40 max-w-xl rounded-2xl" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border/70 px-5 py-12 text-center">
      <Inbox aria-hidden className="mx-auto size-8 text-muted-foreground" />
      <h2 className="mt-3 text-base font-semibold text-foreground">
        Nothing waiting on you
      </h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        Tasks show up here when they are yours to do and no agent is doing them
        for you.
      </p>
    </div>
  );
}

export function TaskQueueScreen({
  error,
  initiativeTitleById,
  isLoading,
  onBounce,
  onComplete,
  onSnooze,
  pendingTaskId,
  queue,
}: {
  error: Error | null;
  initiativeTitleById: ReadonlyMap<string, string>;
  isLoading: boolean;
  onBounce: (taskId: string, reason: string) => Promise<void>;
  onComplete: (taskId: string, outcomeReason: string) => Promise<void>;
  onSnooze: (taskId: string, wakeAt: number) => Promise<void>;
  pendingTaskId: string | null;
  queue: readonly CompanyTask[];
}) {
  const nowSeconds = useNowSeconds();
  const [active, ...upcoming] = queue;

  return (
    <div
      className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8"
      data-testid="task-queue-page"
    >
      <div className="mx-auto w-full max-w-6xl">
        <PageHeader
          description="One card at a time, oldest first."
          title="My queue"
        />
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="queue-count"
        >
          {queue.length} waiting
        </p>

        <div className="mt-4">
          {isLoading ? <LoadingState /> : null}

          {!isLoading && error ? (
            <div
              className="max-w-xl rounded-2xl border border-destructive/25 bg-destructive/5 px-5 py-8"
              data-testid="queue-error"
              role="alert"
            >
              <h2 className="text-base font-semibold text-foreground">
                Queue could not be loaded
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {error.message}
              </p>
            </div>
          ) : null}

          {!isLoading && !error && !active ? <EmptyState /> : null}

          {!isLoading && !error && active ? (
            <QueueCard
              initiativeTitle={
                active.initiativeId
                  ? (initiativeTitleById.get(active.initiativeId) ?? null)
                  : null
              }
              key={active.id}
              nowSeconds={nowSeconds}
              onBounce={(reason) => onBounce(active.id, reason)}
              onComplete={(outcomeReason) =>
                onComplete(active.id, outcomeReason)
              }
              onSnooze={(wakeAt) => onSnooze(active.id, wakeAt)}
              pendingAction={pendingTaskId === active.id ? active.id : null}
              task={active}
            />
          ) : null}

          {!isLoading && !error && upcoming.length > 0 ? (
            <p
              className="mt-4 text-2xs text-muted-foreground"
              data-testid="queue-upcoming"
            >
              Then:{" "}
              {upcoming
                .slice(0, 3)
                .map((task) =>
                  task.subject ? shortIdLabel(task.subject.ref) : task.title,
                )
                .join(" · ")}
              {upcoming.length > 3 ? ` · +${upcoming.length - 3}` : ""}
            </p>
          ) : null}
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
