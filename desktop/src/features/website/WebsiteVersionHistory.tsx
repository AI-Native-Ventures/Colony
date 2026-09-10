import * as React from "react";
import { Check, ChevronRight, X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { PubKey } from "@/shared/ui/PubKey";

import {
  websiteAgentColorClass,
  websiteAgentInitial,
} from "./agentPresentation";
import type {
  WebsiteAgentDirectory,
  WebsiteReviewRecord,
  WebsiteRevisionRecord,
} from "./types";

export type WebsiteVersionHistoryProps = {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  selectedRevision: number;
  onSelectRevision: (revision: number) => void;
  className?: string;
};

function BuilderLine({
  agents,
  builtBy,
}: {
  agents: WebsiteAgentDirectory;
  builtBy: string;
}) {
  const agent = agents.get(builtBy);
  if (!agent) {
    return (
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        Built by
        <PubKey className="text-2xs" interactive={false} pubkey={builtBy} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full text-3xs font-medium",
          websiteAgentColorClass(agent.color),
        )}
      >
        {websiteAgentInitial(agent.name)}
      </span>
      <span className="truncate">
        {agent.name} · {agent.role}
      </span>
    </span>
  );
}

function RevisionRow({
  revision,
  record,
  agents,
  selected,
  onSelect,
}: {
  revision: WebsiteRevisionRecord;
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  selected: boolean;
  onSelect: () => void;
}) {
  const isCurrent = revision.revision === record.currentRevision;
  const decisions = record.decisions.filter(
    (decision) => decision.revision === revision.revision,
  );
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-t border-border/60 py-2 first:border-t-0 first:pt-0">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">
            Version {revision.revision}
          </span>
          {isCurrent ? (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-3xs text-accent-foreground">
              Current
            </span>
          ) : (
            <span className="text-3xs text-muted-foreground">Earlier</span>
          )}
          {revision.qa ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-3xs",
                revision.qa.passed
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-destructive",
              )}
            >
              {revision.qa.passed ? (
                <Check aria-hidden="true" className="size-3" />
              ) : (
                <X aria-hidden="true" className="size-3" />
              )}
              {revision.qa.passed ? "Reviewed" : "Not passed"}
            </span>
          ) : (
            <span className="text-3xs text-muted-foreground">
              No independent review
            </span>
          )}
        </span>
        <BuilderLine agents={agents} builtBy={revision.builtBy} />
        {decisions.map((decision) => (
          <span
            className="flex flex-wrap items-baseline gap-1.5 text-2xs text-muted-foreground"
            key={decision.decisionId}
          >
            <span
              className={cn(
                "font-medium",
                decision.kind === "approve"
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-foreground",
              )}
            >
              {decision.kind === "approve"
                ? "Approved"
                : "Changes requested"}
            </span>
            {decision.note ? (
              <span className="line-clamp-2 min-w-0 text-muted-foreground">
                {decision.note}
              </span>
            ) : null}
          </span>
        ))}
      </span>
      <button
        aria-pressed={selected}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs",
          selected
            ? "border-primary/50 bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={onSelect}
        type="button"
      >
        {selected ? "Viewing" : "View"}
        <ChevronRight aria-hidden="true" className="size-3" />
      </button>
    </li>
  );
}

/**
 * Every recorded revision with its builder, review result, and decisions.
 * History is append-only in the record and rendered newest first; selecting an
 * earlier version never changes the decision target, which stays pinned to the
 * exact current revision.
 */
export function WebsiteVersionHistory({
  record,
  agents,
  selectedRevision,
  onSelectRevision,
  className,
}: WebsiteVersionHistoryProps) {
  if (record.revisions.length === 0) return null;
  const sorted = [...record.revisions].sort(
    (left, right) => right.revision - left.revision,
  );
  return (
    <section
      aria-label="Version history"
      className={cn("border-t border-border px-3.5 py-3", className)}
    >
      <h4 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        Version history
      </h4>
      <ul className="mt-1.5 flex flex-col">
        {sorted.map((revision) => (
          <RevisionRow
            agents={agents}
            key={revision.revision}
            onSelect={() => onSelectRevision(revision.revision)}
            record={record}
            revision={revision}
            selected={revision.revision === selectedRevision}
          />
        ))}
      </ul>
    </section>
  );
}
