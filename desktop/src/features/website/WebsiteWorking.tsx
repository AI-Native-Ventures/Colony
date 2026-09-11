import { cn } from "@/shared/lib/cn";
import { PubKey } from "@/shared/ui/PubKey";

import {
  websiteAgentColorClass,
  websiteAgentInitial,
} from "./agentPresentation";
import { findRevision } from "./reviewLogic";
import { WebsiteWorkStages } from "./WebsiteWorkStages";
import type {
  WebsiteAgentDirectory,
  WebsiteProgressInput,
  WebsiteReviewRecord,
} from "./types";

export type WebsiteWorkingProps = {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  /** stage definition id to pubkey, from canonical assignment state. */
  stageAgents?: Readonly<Record<string, string>>;
  /** Display-only fallback for stages the record does not name yet. */
  stageFallbacks?: Readonly<Record<string, string>>;
  /** True when the viewer is the job owner. */
  viewerIsOwner?: boolean;
  /** Canonical completion facts and active work; no inference happens here. */
  progress?: WebsiteProgressInput | null;
  className?: string;
};

function BuilderFact({
  agents,
  pubkey,
}: {
  agents: WebsiteAgentDirectory;
  pubkey: string;
}) {
  const agent = agents.get(pubkey);
  if (!agent) {
    return (
      <span className="flex items-center gap-1.5">
        Built by
        <PubKey className="text-2xs" interactive={false} pubkey={pubkey} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
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
        Built by {agent.name} · {agent.role}
      </span>
    </span>
  );
}

/**
 * The working state: factual stage rows plus the latest recorded revision and
 * its review status. Nothing here estimates progress or claims a stage is
 * active without canonical data.
 */
export function WebsiteWorking({
  record,
  agents,
  stageAgents,
  stageFallbacks,
  viewerIsOwner,
  progress,
  className,
}: WebsiteWorkingProps) {
  const head = findRevision(record, record.currentRevision);
  return (
    <section
      aria-label="Work in progress"
      className={cn("border-t border-border px-3.5 py-3", className)}
    >
      <WebsiteWorkStages
        agents={agents}
        progress={progress}
        record={record}
        stageAgents={stageAgents}
        stageFallbacks={stageFallbacks}
        viewerIsOwner={viewerIsOwner}
      />
      {head ? (
        <div className="mt-3 flex flex-col gap-1 border-t border-border/60 pt-3 text-2xs text-muted-foreground">
          <span className="text-xs text-foreground">
            Version {head.revision} is on record
          </span>
          <BuilderFact agents={agents} pubkey={head.builtBy} />
          <span>
            {head.qa
              ? head.qa.passed
                ? `Independent review passed for Version ${head.qa.revision}.`
                : `Independent review did not pass for Version ${head.qa.revision}.`
              : "No independent review is recorded for this version yet."}
          </span>
          {record.status === "changesRequested" ? (
            <span>
              Changes have been requested. A new version follows review.
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
