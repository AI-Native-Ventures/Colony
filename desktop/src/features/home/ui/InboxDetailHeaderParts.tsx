import { AlertCircle, ExternalLink, LoaderCircle } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

/**
 * Header pieces for the Inbox detail pane, split out of `InboxDetailPane.tsx`
 * for the desktop file-size ratchet.
 */

/**
 * Status pill for a hidden DM the Inbox is reopening on the relay (#6885):
 * "Reopening…" while the round-trip is in flight, and a retry affordance when
 * it fails.
 */
export function InboxReopenStatus({
  errored,
  onRetry,
  pending,
}: {
  errored: boolean;
  onRetry: (() => void) | null;
  pending: boolean;
}) {
  if (!pending && !errored) return null;
  return (
    <div
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium",
        errored
          ? "bg-destructive/10 text-destructive"
          : "bg-muted/60 text-muted-foreground",
      )}
      data-testid="home-inbox-reopen-status"
      role="status"
    >
      {pending ? (
        <>
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>Reopening…</span>
        </>
      ) : (
        <>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Couldn’t reopen</span>
          {onRetry ? (
            <button
              className="ml-0.5 rounded font-semibold underline underline-offset-2 hover:no-underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="home-inbox-reopen-retry"
              onClick={onRetry}
              type="button"
            >
              Retry
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Opens the message's own channel from the Inbox detail header. */
export function InboxOpenContextAction({
  label,
  onOpen,
}: {
  label: string;
  onOpen: (() => void) | null;
}) {
  if (!onOpen) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="rounded-full text-muted-foreground"
          data-testid="home-inbox-open-context"
          onClick={onOpen}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ExternalLink />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The Inbox detail heading: a link to the source channel when one is open. */
export function InboxContextTitle({
  fullTimestampLabel,
  label,
  onOpen,
  openLabel,
}: {
  fullTimestampLabel: string;
  label: string;
  onOpen: (() => void) | null;
  openLabel: string;
}) {
  return (
    <div className="min-w-0">
      {onOpen ? (
        <h2 className="min-w-0">
          <button
            className="block min-w-0 max-w-full text-left text-sm font-semibold leading-5 tracking-tight text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            data-testid="home-inbox-context-title"
            onClick={onOpen}
            title={openLabel}
            type="button"
          >
            <span className="block min-w-0 translate-y-px truncate">
              {label}
            </span>
          </button>
        </h2>
      ) : (
        <h2
          className="min-w-0 text-sm font-semibold leading-5 tracking-tight text-foreground"
          title={fullTimestampLabel}
        >
          <span className="block min-w-0 translate-y-px truncate">{label}</span>
        </h2>
      )}
    </div>
  );
}
