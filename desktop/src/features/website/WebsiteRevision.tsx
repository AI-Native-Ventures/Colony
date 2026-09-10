import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { PubKey } from "@/shared/ui/PubKey";

import {
  websiteAgentColorClass,
  websiteAgentInitial,
} from "./agentPresentation";
import { resolveRevisionView } from "./viewLogic";
import type { WebsiteAgentDirectory, WebsiteReviewRecord } from "./types";

export type WebsiteRevisionProps = {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  /** Select an earlier version in the review preview. */
  onViewRevision?: (revision: number) => void;
  className?: string;
};

function ActorLine({
  agents,
  pubkey,
}: {
  agents: WebsiteAgentDirectory;
  pubkey: string;
}) {
  const agent = agents.get(pubkey);
  if (!agent) {
    return (
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        Requested by
        <PubKey className="text-2xs" interactive={false} pubkey={pubkey} />
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

/**
 * A change request and its disposition. `requested` means the next version is
 * not on record yet; `addressed` means a later version exists. Neither state
 * claims the new version is reviewed or approved.
 */
export function WebsiteRevision({
  record,
  agents,
  onViewRevision,
  className,
}: WebsiteRevisionProps) {
  const view = resolveRevisionView(record);
  if (view.kind === "none") return null;
  const { decision } = view;
  return (
    <section
      aria-label="Change request"
      className={cn("border-t border-border px-3.5 py-3", className)}
    >
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-foreground">
          {view.kind === "requested"
            ? `Changes requested for Version ${view.targetRevision}`
            : `Version ${view.currentRevision} was recorded after a change request on Version ${view.targetRevision}`}
        </h4>
        <ActorLine agents={agents} pubkey={decision.actor} />
        {decision.note ? (
          <p className="whitespace-pre-line rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-relaxed text-foreground">
            {decision.note}
          </p>
        ) : null}
        {view.kind === "requested" ? (
          <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            Waiting for the revised version to be recorded.
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Check aria-hidden="true" className="size-3 text-emerald-600" />
              The revised version is on record.
            </span>
            {onViewRevision ? (
              <button
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => onViewRevision(view.targetRevision)}
                type="button"
              >
                View Version {view.targetRevision}
              </button>
            ) : null}
          </span>
        )}
      </div>
    </section>
  );
}
