import * as React from "react";
import { Check, CircleAlert, MinusCircle, X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { PubKey } from "@/shared/ui/PubKey";

import {
  websiteAgentColorClass,
  websiteAgentInitial,
} from "./agentPresentation";
import { useVerifiedArtifact } from "./useVerifiedArtifact";
import { WebsiteExternalLink } from "./WebsiteExternalLink";
import type { WebsiteQaReportState, WebsiteQaView } from "./viewLogic";
import type {
  WebsiteAgentDirectory,
  WebsiteArtifactLoader,
  WebsiteArtifactRef,
  WebsiteRevisionRecord,
} from "./types";

const EVIDENCE_THUMBNAILS = 3;
const EVIDENCE_TOTAL_LIMIT = 12;

export type WebsiteQaPanelProps = {
  revision?: WebsiteRevisionRecord;
  /** Loaded reviewer report state; the caller owns fetching. */
  reportState: WebsiteQaReportState;
  /** Resolved view model from `resolveQaView`. */
  view: WebsiteQaView;
  agents: WebsiteAgentDirectory;
  artifactLoader?: WebsiteArtifactLoader;
  className?: string;
};

function ResultIcon({ result }: { result: WebsiteQaView["checks"][number]["result"] }) {
  if (result === "pass") {
    return <Check aria-hidden="true" className="size-4 text-emerald-600" />;
  }
  if (result === "fail") {
    return <X aria-hidden="true" className="size-4 text-destructive" />;
  }
  return <MinusCircle aria-hidden="true" className="size-4 text-muted-foreground" />;
}

function EvidenceThumb({
  artifact,
  loader,
  label,
}: {
  artifact: WebsiteArtifactRef;
  loader?: WebsiteArtifactLoader;
  label: string;
}) {
  const state = useVerifiedArtifact({ loader, artifact });
  if (state.status === "ready") {
    return (
      <img
        alt={label}
        className="h-10 w-16 rounded border border-border object-cover"
        src={state.objectUrl}
      />
    );
  }
  if (state.status === "loading") {
    return (
      <span className="inline-flex h-10 w-16 items-center justify-center rounded border border-border bg-muted/30 text-2xs text-muted-foreground">
        Checking
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <span
        className="inline-flex h-10 w-16 items-center justify-center rounded border border-border bg-muted/30 text-center text-3xs text-muted-foreground"
        title={state.diagnostics}
      >
        Not verified
      </span>
    );
  }
  return (
    <span className="inline-flex h-10 w-16 items-center justify-center rounded border border-border bg-muted/30 text-center text-3xs text-muted-foreground">
      Not available
    </span>
  );
}

function ReviewerIdentity({
  agents,
  reviewer,
}: {
  agents: WebsiteAgentDirectory;
  reviewer?: string;
}) {
  if (!reviewer) {
    return <span className="text-xs text-muted-foreground">No reviewer recorded</span>;
  }
  const agent = agents.get(reviewer);
  if (!agent) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        Reviewer
        <PubKey className="text-2xs" interactive={false} pubkey={reviewer} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full text-3xs font-medium",
          websiteAgentColorClass(agent.color),
        )}
      >
        {websiteAgentInitial(agent.name)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-medium text-foreground">
          {agent.name}
        </span>
        <span className="truncate text-2xs text-muted-foreground">
          {agent.role}
        </span>
      </span>
    </span>
  );
}

/**
 * Owner-facing independent review summary. The checklist is reviewer-authored
 * report content; technical binding (event id, hashes) stays inside the
 * diagnostics disclosure. A checklist that disagrees with the recorded result
 * is surfaced, and the review is not presented as passed.
 */
export function WebsiteQaPanel({
  revision,
  reportState,
  view,
  agents,
  artifactLoader,
  className,
}: WebsiteQaPanelProps) {
  let remaining = EVIDENCE_TOTAL_LIMIT;
  const plan = view.checks.map((check) => {
    const allowed = Math.max(0, Math.min(EVIDENCE_THUMBNAILS, remaining));
    const shown = check.evidence.slice(0, allowed);
    remaining -= shown.length;
    return { check, shown, hidden: check.evidence.length - shown.length };
  });

  return (
    <section
      aria-label="Independent review"
      className={cn("border-t border-border px-3.5 py-3", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ReviewerIdentity agents={agents} reviewer={view.reviewerPubkey} />
        {view.present ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-xs font-medium",
              view.displayPassed
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-destructive",
            )}
          >
            {view.displayPassed ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : (
              <X aria-hidden="true" className="size-3.5" />
            )}
            {view.displayPassed ? "Passed" : "Not passed"}
          </span>
        ) : null}
      </div>

      {view.present && !view.reportAgrees && view.reportLoaded ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-2xs text-foreground">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <span>
            The reviewer checklist does not agree with the recorded result, so
            this review is not presented as passed.
          </span>
        </p>
      ) : null}

      {!view.present ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          No independent review is recorded for this version.
        </p>
      ) : null}

      {plan.length > 0 ? (
        <ul className="mt-2 flex flex-col">
          {plan.map(({ check, shown, hidden }) => (
            <li
              className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 border-t border-border/60 py-2 first:border-t-0 first:pt-0"
              key={check.id}
            >
              <ResultIcon result={check.result} />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-xs leading-snug text-foreground">
                  {check.label}
                </span>
                {check.detail ? (
                  <span className="whitespace-pre-line text-2xs leading-relaxed text-muted-foreground">
                    {check.detail}
                  </span>
                ) : null}
                {shown.length > 0 || hidden > 0 ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {shown.map((evidence) => (
                      <EvidenceThumb
                        artifact={evidence}
                        key={`${check.id}:${evidence.sha256}`}
                        label={`Evidence for ${check.label}`}
                        loader={artifactLoader}
                      />
                    ))}
                    {hidden > 0 ? (
                      <span className="text-3xs text-muted-foreground">
                        +{hidden} more in the report
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-2xs text-muted-foreground">
          {view.checksUnavailableReason ??
            "The reviewer checklist is not available for this version."}
        </p>
      )}

      {view.present && revision?.qa ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
          {view.report &&
          (reportState.status !== "ready" || view.checks.length === 0) ? (
            <WebsiteExternalLink
              className="text-primary underline-offset-2 hover:underline"
              href={view.report.url}
            >
              View reviewer report
            </WebsiteExternalLink>
          ) : null}
          {view.diagnostics.length > 0 ? (
            <details className="text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                Technical details
              </summary>
              <dl className="mt-1 flex flex-col gap-0.5">
                {view.diagnostics.map((row) => (
                  <div className="flex gap-2" key={row.label}>
                    <dt className="shrink-0 text-foreground/70">{row.label}</dt>
                    <dd className="min-w-0 break-all font-mono text-3xs">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
