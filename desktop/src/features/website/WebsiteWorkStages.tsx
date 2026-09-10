import * as React from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleDot,
  Loader2,
} from "lucide-react";

import { cn } from "@/shared/lib/cn";

import { websiteAgentDotClass } from "./agentPresentation";
import { deriveStageRows } from "./viewLogic";
import type {
  WebsiteAgentDirectory,
  WebsiteProgressInput,
  WebsiteReviewRecord,
  WebsiteStageRow,
} from "./types";

export type WebsiteWorkStagesProps = {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  /** stage id to pubkey, from canonical assignment state. */
  stageAgents?: Readonly<Record<string, string>>;
  /** Canonical completion facts and active work; never inferred. */
  progress?: WebsiteProgressInput | null;
  className?: string;
  /** Start collapsed once every stage is complete. Defaults to true. */
  defaultCollapsed?: boolean;
};

const STATE_LABEL: Record<WebsiteStageRow["state"], string> = {
  done: "Done",
  working: "Working",
  next: "Next",
  then: "Then",
  blocked: "Needs attention",
};

function StateIcon({ state }: { state: WebsiteStageRow["state"] }) {
  if (state === "done") {
    return <Check aria-hidden="true" className="size-4 text-emerald-600" />;
  }
  if (state === "working") {
    return (
      <Loader2
        aria-hidden="true"
        className="size-4 animate-spin text-foreground"
      />
    );
  }
  if (state === "blocked") {
    return <CircleAlert aria-hidden="true" className="size-4 text-amber-600" />;
  }
  return (
    <CircleDot aria-hidden="true" className="size-4 text-muted-foreground" />
  );
}

function EvidenceDetails({ rows }: { rows: readonly WebsiteStageRow[] }) {
  const rowsWithEvidence = rows.filter((row) => row.evidence.length > 0);
  if (rowsWithEvidence.length === 0) return null;
  return (
    <details className="mt-1.5 text-2xs text-muted-foreground">
      <summary className="cursor-pointer hover:text-foreground">
        Signed evidence records
      </summary>
      <ul className="mt-1 flex flex-col gap-1">
        {rowsWithEvidence.map((row) => (
          <li key={row.id}>
            <span className="text-foreground">{row.label}</span>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {row.evidence.map((evidence) => (
                <li
                  className="truncate font-mono text-3xs"
                  key={`${row.id}:${evidence.eventId}`}
                  title={evidence.eventId}
                >
                  {evidence.kind} · {evidence.eventId.slice(0, 12)}…
                  {evidence.revision ? ` · Version ${evidence.revision}` : ""}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

function StageRowView({ row }: { row: WebsiteStageRow }) {
  const roleLine = row.agent
    ? `${row.agent.name} · ${row.agent.role}`
    : row.agentFallback;
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2 border-t border-border px-3.5 py-3 first:border-t-0">
      <span className="mt-0.5">
        <StateIcon state={row.state} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-sm text-foreground">{row.label}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {row.agent ? (
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                websiteAgentDotClass(row.agent.color),
              )}
            />
          ) : null}
          <span className="truncate">{roleLine}</span>
        </span>
        {row.carriedForwardFrom !== undefined ? (
          <span className="mt-0.5 text-2xs text-muted-foreground">
            Carried forward from Version {row.carriedForwardFrom}
          </span>
        ) : null}
        {row.state === "working" && row.detail ? (
          <span className="mt-0.5 text-2xs text-foreground">{row.detail}</span>
        ) : (
          <span className="sr-only">{row.detail}</span>
        )}
      </span>
      <span
        className={cn(
          "text-2xs",
          row.state === "working" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {STATE_LABEL[row.state]}
      </span>
    </li>
  );
}

/**
 * Factual stage rows for a website job. States derive from canonical
 * completion facts and signed evidence; there is no timer and no generated
 * progress. Completed work collapses to a quiet overview; proof expands.
 */
export function WebsiteWorkStages({
  record,
  agents,
  stageAgents,
  progress,
  className,
  defaultCollapsed = true,
}: WebsiteWorkStagesProps) {
  const [showAll, setShowAll] = React.useState(!defaultCollapsed);
  const rows = deriveStageRows({ record, agents, stageAgents, progress });
  const allDone = rows.every((row) => row.state === "done");

  if (allDone && !showAll) {
    return (
      <section
        aria-label="Work stages"
        className={cn("flex flex-col", className)}
      >
        <div className="flex items-center justify-between gap-3 py-0.5">
          <span className="flex items-center gap-2 text-sm text-foreground">
            <Check aria-hidden="true" className="size-4 text-emerald-600" />
            All four stages are complete
          </span>
          <button
            className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowAll(true)}
            type="button"
          >
            View stage proof
            <ChevronDown aria-hidden="true" className="size-3" />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Work stages"
      className={cn("flex flex-col", className)}
    >
      <ol className="flex flex-col">
        {rows.map((row) => (
          <StageRowView key={row.id} row={row} />
        ))}
      </ol>
      <EvidenceDetails rows={rows} />
      {allDone && showAll ? (
        <button
          className="mt-2 self-start text-2xs text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll(false)}
          type="button"
        >
          Collapse stages
        </button>
      ) : null}
    </section>
  );
}
