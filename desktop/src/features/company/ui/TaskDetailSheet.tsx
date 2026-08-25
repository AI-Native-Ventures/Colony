import { ExternalLink } from "lucide-react";

import type { CompanyTask } from "@/features/company/contracts";
import type {
  TaskArtifact,
  TaskRunHead,
} from "@/features/company/taskRunContracts";
import type { TaskExecutionState } from "@/features/company/taskThreadModel";
import { buildMessageLink } from "@/features/messages/lib/messageLink";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/shared/ui/sheet";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-border/60 py-3 last:border-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

function ArtifactRow({
  artifact,
  primary,
}: {
  artifact: TaskArtifact;
  primary: boolean;
}) {
  return (
    <li className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="text-sm font-medium text-foreground">
        {artifact.label ??
          (primary ? "Primary deliverable" : "Supporting artifact")}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
        {artifact.kind}
      </div>
      <div className="mt-1 break-all text-xs text-muted-foreground">
        {artifact.reference}
      </div>
    </li>
  );
}

function keyedArtifacts(artifacts: TaskArtifact[]) {
  const occurrences = new Map<string, number>();
  return artifacts.map((artifact) => {
    const identity = `${artifact.kind}:${artifact.reference}:${artifact.label ?? ""}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { artifact, key: `${identity}:${occurrence}` };
  });
}

export function TaskDetailSheet({
  channelId,
  channelName,
  execution,
  ownerLabel,
  qaLabel,
  run,
  task,
  threadId,
  triggerLabel = "Details",
}: {
  channelId: string;
  channelName: string;
  execution: TaskExecutionState;
  ownerLabel: string;
  qaLabel: string;
  run: TaskRunHead | null;
  task: CompanyTask;
  threadId: string;
  /** Row surfaces name the affordance after the action, not the record. */
  triggerLabel?: string;
}) {
  const canonicalLink = buildMessageLink({ channelId, messageId: threadId });
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button data-testid="task-detail-open" size="xs" variant="ghost">
          {triggerLabel}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{task.title}</SheetTitle>
          <SheetDescription>
            Durable task context for this canonical thread.
          </SheetDescription>
        </SheetHeader>
        <dl className="mt-5">
          <DetailRow label="Accountable owner" value={ownerLabel} />
          <DetailRow label="QA owner" value={qaLabel} />
          <DetailRow label="Task state" value={task.status} />
          <DetailRow label="Execution" value={execution.label} />
          <DetailRow
            label="Expected deliverable"
            value={run?.instruction ?? task.title}
          />
          <DetailRow label="Task ID" value={task.id} />
        </dl>

        {run?.artifacts.length ? (
          <section className="mt-5">
            <h3 className="text-sm font-semibold text-foreground">
              Delivery evidence
            </h3>
            <ul className="mt-2 space-y-2">
              {keyedArtifacts(run.artifacts).map(({ artifact, key }, index) => (
                <ArtifactRow
                  artifact={artifact}
                  key={key}
                  primary={index === 0}
                />
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-5 rounded-lg border border-border/70 p-3">
          <h3 className="text-sm font-semibold text-foreground">
            Canonical context
          </h3>
          <div className="mt-2 text-xs text-muted-foreground">
            #{channelName} · thread {threadId.slice(0, 12)}…
          </div>
          <Markdown
            className="mt-2 text-sm"
            content={`[Open canonical thread](${canonicalLink})`}
            interactive
          />
          {run?.checkpoint?.eventId ? (
            <div className="mt-2 break-all text-xs text-muted-foreground">
              Checkpoint receipt: {run.checkpoint.eventId}
            </div>
          ) : null}
          {run?.outcomeEventId ? (
            <div className="mt-2 break-all text-xs text-muted-foreground">
              Delivery receipt: {run.outcomeEventId}
            </div>
          ) : null}
          <ExternalLink
            className="mt-2 size-3.5 text-muted-foreground"
            aria-hidden
          />
        </section>
      </SheetContent>
    </Sheet>
  );
}
