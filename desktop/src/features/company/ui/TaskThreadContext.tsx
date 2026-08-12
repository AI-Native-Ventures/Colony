import * as React from "react";
import {
  CheckCircle2,
  CircleDotDashed,
  FileCheck2,
  RefreshCw,
} from "lucide-react";

import { usePersonasQuery, useTeamsQuery } from "@/features/agents/hooks";
import { useTaskThreadContext } from "@/features/company/useTaskThreadContext";
import {
  deriveTaskExecutionState,
  splitDeliveryArtifacts,
} from "@/features/company/taskThreadModel";
import {
  canOpenTaskArtifact,
  openTaskArtifact,
} from "@/features/workspace/lib/openTaskArtifact";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

import { TaskDetailSheet } from "./TaskDetailSheet";

function useExecutionClock(leaseExpiresAt: number | null | undefined) {
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));
  React.useEffect(() => {
    if (!leaseExpiresAt || leaseExpiresAt <= now) return;
    const delay = Math.min((leaseExpiresAt - now) * 1_000 + 50, 2_147_000_000);
    const timeout = window.setTimeout(
      () => setNow(Math.floor(Date.now() / 1000)),
      delay,
    );
    return () => window.clearTimeout(timeout);
  }, [leaseExpiresAt, now]);
  return now;
}

function stateBadgeVariant(
  tone: ReturnType<typeof deriveTaskExecutionState>["tone"],
) {
  if (tone === "success") return "success" as const;
  if (tone === "warning") return "warning" as const;
  if (tone === "danger") return "destructive" as const;
  if (tone === "active") return "info" as const;
  return "secondary" as const;
}

export function TaskThreadContext({
  channelId,
  channelName,
  profiles,
  taskId,
  threadId,
}: {
  channelId: string;
  channelName: string;
  profiles?: UserProfileLookup;
  taskId: string;
  threadId: string;
}) {
  const { taskQuery, runQuery } = useTaskThreadContext({
    taskId,
    channelId,
    threadId,
  });
  const teamsQuery = useTeamsQuery();
  const personasQuery = usePersonasQuery();
  const run = runQuery.data ?? null;
  const task = taskQuery.data ?? null;
  const now = useExecutionClock(run?.leaseExpiresAt);
  const execution = runQuery.isError
    ? {
        key: "unavailable" as const,
        label: "State unavailable",
        tone: "warning" as const,
      }
    : deriveTaskExecutionState(run, now);
  const delivery = splitDeliveryArtifacts(run);
  const [opening, setOpening] = React.useState(false);
  const [openMessage, setOpenMessage] = React.useState<string | null>(null);

  if (taskQuery.isPending || runQuery.isPending) {
    return (
      <div className="mx-2 mb-3 rounded-xl border border-border/60 p-3 text-sm text-muted-foreground">
        Reading durable task state…
      </div>
    );
  }
  if (!task) {
    return (
      <div className="mx-2 mb-3 rounded-xl border border-border/60 p-3 text-sm text-muted-foreground">
        This thread references a task that is unavailable. Conversation remains
        readable.
      </div>
    );
  }

  const ownerLabel =
    teamsQuery.data?.find((team) => team.id === task.owningTeamId)?.name ??
    task.owningTeamId;
  const qaLabel =
    personasQuery.data?.find((persona) => persona.id === task.qaPersonaId)
      ?.displayName ?? task.qaPersonaId;
  const workerLabel = run?.leaseHolderPubkey
    ? (profiles?.[run.leaseHolderPubkey]?.displayName ??
      run.leaseHolderPubkey.slice(0, 10))
    : null;
  const openDecision = delivery.primary
    ? canOpenTaskArtifact(delivery.primary)
    : null;

  const handleOpen = async () => {
    if (!delivery.primary) return;
    setOpening(true);
    setOpenMessage(null);
    const result = await openTaskArtifact({
      channelId,
      artifact: delivery.primary,
      createdBy: run?.employeePubkey ?? "relay",
    });
    setOpening(false);
    if (!result.ok) setOpenMessage(result.message);
  };

  return (
    <section
      className="mx-2 mb-3 overflow-hidden rounded-xl border border-border/70 bg-muted/15"
      data-testid="task-thread-context"
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <CircleDotDashed className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {task.title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Owner: {ownerLabel}
            {workerLabel ? ` · Worker: ${workerLabel}` : ""}
          </div>
        </div>
        <Badge
          data-testid="task-execution-state"
          variant={stateBadgeVariant(execution.tone)}
        >
          {execution.label}
        </Badge>
        <TaskDetailSheet
          channelId={channelId}
          channelName={channelName}
          execution={execution}
          ownerLabel={ownerLabel}
          qaLabel={qaLabel}
          run={run}
          task={task}
          threadId={threadId}
        />
      </header>

      {runQuery.isError ? (
        <div className="border-t border-border/60 px-3 py-2 text-xs text-destructive">
          Durable execution state is temporarily unavailable; no working state
          is inferred.
        </div>
      ) : null}

      {run?.checkpoint ? (
        <div
          className="flex gap-2 border-t border-border/60 px-3 py-2.5"
          data-testid="task-checkpoint-row"
        >
          <RefreshCw
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Accepted checkpoint {run.checkpoint.sequence}
            </div>
            <div className="mt-0.5 text-sm text-foreground">
              {run.checkpoint.summary}
            </div>
            {run.checkpoint.progress !== null ? (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${run.checkpoint.progress}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {delivery.primary ? (
        <div
          className="border-t border-border/60 p-3"
          data-testid="task-primary-deliverable"
        >
          <div className="flex items-start gap-2">
            <FileCheck2
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Primary deliverable accepted
              </div>
              <div className="mt-0.5 truncate text-sm font-medium text-foreground">
                {delivery.primary.label ?? "Task deliverable"}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {delivery.primary.kind} · {delivery.primary.reference}
              </div>
            </div>
            <Button
              disabled={opening || openDecision?.supported === false}
              onClick={() => void handleOpen()}
              size="sm"
              variant="outline"
            >
              {opening ? "Opening…" : "Open in workspace"}
            </Button>
          </div>
          {openDecision?.supported === false || openMessage ? (
            <div
              className={cn("mt-2 text-xs text-muted-foreground")}
              data-testid="task-artifact-fallback"
            >
              {openMessage ??
                (openDecision?.supported === false
                  ? openDecision.message
                  : null)}
            </div>
          ) : null}
        </div>
      ) : run?.runStatus === "delivered" ? (
        <div className="flex gap-2 border-t border-border/60 px-3 py-2.5">
          <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
          <span className="text-sm text-foreground">Delivery accepted.</span>
        </div>
      ) : null}
    </section>
  );
}
