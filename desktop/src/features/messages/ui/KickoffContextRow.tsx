import { ChevronRight } from "lucide-react";
import * as React from "react";

import type { TimelineMessage } from "@/features/messages/types";
import { WELCOME_KICKOFF_CONTEXT_SUMMARY } from "@/features/onboarding/welcomeKickoffContext";
import { cn } from "@/shared/lib/cn";

/**
 * The founder's signup context, as one line they can open.
 *
 * First run posts this message on the founder's behalf so Scout starts with
 * the company details instead of asking for them again. It is a handoff
 * between two machines that happens to be addressed to a person, and rendering
 * it as a full message row put a wall of labels the founder typed two screens
 * earlier above the reply that was written for them to read. Nothing is
 * hidden: the whole body is one click away, and it stays open once opened.
 */
export function KickoffContextRow({
  footer,
  message,
}: {
  footer?: React.ReactNode;
  message: TimelineMessage;
}) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const bodyId = `kickoff-context-body-${message.id}`;

  return (
    <div className="flex flex-col gap-1 pb-2.5">
      <button
        aria-controls={isExpanded ? bodyId : undefined}
        aria-expanded={isExpanded}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground/75 transition-colors hover:bg-muted/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="kickoff-context-toggle"
        onClick={() => setIsExpanded((current) => !current)}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            isExpanded && "rotate-90",
          )}
        />
        <span className="truncate">{WELCOME_KICKOFF_CONTEXT_SUMMARY}</span>
      </button>
      {isExpanded ? (
        <div
          className="mx-2 whitespace-pre-wrap rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
          data-testid="kickoff-context-body"
          id={bodyId}
        >
          {message.body}
        </div>
      ) : null}
      {footer}
    </div>
  );
}
