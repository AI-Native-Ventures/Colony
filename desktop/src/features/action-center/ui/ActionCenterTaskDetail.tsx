import * as React from "react";
import { ExternalLink, FileCheck2 } from "lucide-react";

import {
  deriveTaskExecutionState,
  splitDeliveryArtifacts,
} from "@/features/company/taskThreadModel";
import {
  canOpenTaskArtifact,
  openTaskArtifact,
} from "@/features/workspace/lib/openTaskArtifact";
import type { ActionTaskSource } from "../contracts";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

export function ActionCenterTaskDetail({
  onOpenSource,
  source,
}: {
  onOpenSource?: () => void;
  source: ActionTaskSource;
}) {
  const [opening, setOpening] = React.useState(false);
  const [openError, setOpenError] = React.useState<string | null>(null);
  const run = source.run;
  const execution = deriveTaskExecutionState(
    run,
    Math.floor(Date.now() / 1_000),
  );
  const delivery = splitDeliveryArtifacts(run);
  const openDecision = delivery.primary
    ? canOpenTaskArtifact(delivery.primary)
    : null;

  const handleOpenArtifact = async () => {
    if (!delivery.primary || !source.channelId || !run) return;
    setOpening(true);
    setOpenError(null);
    const result = await openTaskArtifact({
      artifact: delivery.primary,
      channelId: source.channelId,
      createdBy: run.employeePubkey,
    });
    setOpening(false);
    if (!result.ok) setOpenError(result.message);
  };

  return (
    <section
      className="min-h-full overflow-y-auto"
      data-testid="action-center-task-detail"
    >
      <header className="border-b border-border/60 px-5 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Durable task
          </p>
          <Badge
            variant={execution.tone === "danger" ? "destructive" : "secondary"}
          >
            {execution.label}
          </Badge>
        </div>
        <h2 className="mt-2 text-lg font-semibold text-foreground">
          {source.task.title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {source.task.status} · Owning team {source.task.owningTeamId}
        </p>
      </header>

      <div className="space-y-5 px-5 py-5">
        <div className="rounded-xl border border-border/60 bg-muted/15 p-4">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Execution
          </p>
          <p className="mt-2 text-sm text-foreground">
            {run?.instruction ??
              "No durable execution has been recorded for this task."}
          </p>
          {run?.failure ? (
            <p className="mt-2 text-sm text-destructive">{run.failure}</p>
          ) : null}
          {run?.checkpoint ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Checkpoint {run.checkpoint.sequence}: {run.checkpoint.summary}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {onOpenSource ? (
            <Button onClick={onOpenSource} size="sm" variant="outline">
              <ExternalLink className="mr-2 size-4" />
              Open task thread
            </Button>
          ) : null}
          {delivery.primary ? (
            <Button
              disabled={
                opening ||
                openDecision?.supported === false ||
                !source.channelId ||
                !run
              }
              onClick={() => void handleOpenArtifact()}
              size="sm"
              variant="secondary"
            >
              <FileCheck2 className="mr-2 size-4" />
              {opening ? "Opening…" : "Open deliverable"}
            </Button>
          ) : null}
        </div>
        {openDecision?.supported === false || openError ? (
          <p className="text-sm text-muted-foreground">
            {openError ??
              (openDecision?.supported === false ? openDecision.message : null)}
          </p>
        ) : null}
      </div>
    </section>
  );
}
