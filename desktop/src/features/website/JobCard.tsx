import type * as React from "react";
import { CircleCheck, CircleDot, Loader2, PanelsTopLeft } from "lucide-react";

import { cn } from "@/shared/lib/cn";

import {
  websiteAgentColorClass,
  websiteAgentInitial,
} from "./agentPresentation";
import type {
  WebsiteAgentDirectory,
  WebsiteBriefView,
  WebsiteReviewRecord,
} from "./types";

export type WebsiteJobCardProps = {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  /** Agent-authored brief content; nothing is composed here. */
  brief?: WebsiteBriefView;
  /** Deliverable body (preview, stages, review panel, ...). */
  children?: React.ReactNode;
  onOpenThread?: () => void;
  className?: string;
};

type StatusPresentation = {
  label: string;
  icon: React.ReactNode;
  className: string;
};

/** The current revision's builder first name, when the directory knows it. */
function builderFirstName(
  record: WebsiteReviewRecord,
  agents: WebsiteAgentDirectory,
): string | undefined {
  const revision = record.revisions.find(
    (entry) => entry.revision === record.currentRevision,
  );
  if (!revision) return undefined;
  const name = agents.get(revision.builtBy)?.name?.trim();
  if (!name) return undefined;
  return name.split(/\s+/)[0];
}

function statusPresentation(
  record: WebsiteReviewRecord,
  agents: WebsiteAgentDirectory,
): StatusPresentation {
  switch (record.status) {
    case "working": {
      const builder = builderFirstName(record, agents);
      return {
        label: builder ? `${builder} is shaping the new site` : "In progress",
        icon: (
          <Loader2 aria-hidden="true" className="size-[13px] animate-spin" />
        ),
        className: "text-primary",
      };
    }
    case "readyForReview":
      return {
        label:
          record.currentRevision > 1
            ? "Revised design ready for review"
            : "Ready for your review",
        icon: <CircleDot aria-hidden="true" className="size-[13px]" />,
        className: "text-primary",
      };
    case "changesRequested":
      return {
        label: "Changes requested",
        icon: <CircleDot aria-hidden="true" className="size-[13px]" />,
        className: "text-primary",
      };
    case "approved":
      return {
        label: "Design approved",
        icon: <CircleCheck aria-hidden="true" className="size-[13px]" />,
        className: "text-primary",
      };
    case "handedOver":
      return {
        label: "Design approved · awaiting launch",
        icon: <CircleCheck aria-hidden="true" className="size-[13px]" />,
        className: "text-primary",
      };
    case "draft":
    default:
      return {
        label: "Ready to start",
        icon: <CircleDot aria-hidden="true" className="size-[13px]" />,
        className: "text-primary",
      };
  }
}

/**
 * The inline job block that sits in the thread root: a quiet heading, a factual
 * status line, the deliverable surface authored by the caller, and a footer
 * naming the coordinator. Sections inside the body own their dividers; the
 * card itself does not nest another card per stage.
 */
export function WebsiteJobCard({
  record,
  agents,
  brief,
  children,
  onOpenThread,
  className,
}: WebsiteJobCardProps) {
  const status = statusPresentation(record, agents);
  const coordinator = record.coordinator
    ? agents.get(record.coordinator)
    : undefined;

  return (
    <article
      aria-label="Website redesign job"
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3.5 pb-3 pt-4">
        <span
          aria-hidden="true"
          className="grid h-8 w-[34px] shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"
        >
          <PanelsTopLeft className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h3 className="truncate text-sm font-semibold tracking-[-0.25px] text-foreground">
            {brief?.title || "Website redesign"}
          </h3>
        </div>
      </header>

      <p
        className={cn(
          "mx-3.5 mb-3.5 flex items-center gap-1.5 text-2xs",
          status.className,
        )}
      >
        {status.icon}
        {status.label}
      </p>

      {children ? <div className="flex flex-col">{children}</div> : null}

      <footer className="flex items-center justify-between gap-3 border-t border-border px-3.5 py-3">
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn(
              "grid size-4 place-items-center rounded-full text-3xs font-medium",
              coordinator
                ? websiteAgentColorClass(coordinator.color)
                : "bg-accent text-accent-foreground",
            )}
          >
            {coordinator ? websiteAgentInitial(coordinator.name) : "?"}
          </span>
          {coordinator
            ? `${coordinator.name} coordinates this job`
            : "Website Manager coordinates this job"}
        </span>
        {onOpenThread ? (
          <button
            className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={onOpenThread}
            type="button"
          >
            Open thread
          </button>
        ) : null}
      </footer>
    </article>
  );
}
