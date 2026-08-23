import type * as React from "react";

import type { AskResolution } from "@/features/asks/lib/askResolution";
import { describeAskResolution } from "@/features/asks/lib/askResolution";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";

/**
 * How one ask closed, rendered as an account of what happened.
 *
 * An executed default is the relay acting on the owner's silence: it gets
 * its own label, its own tone, and copy that says outright that nobody
 * answered before the deadline and names the option that was applied. It
 * must never read like a human answer, because no human made it.
 */
export function AskResolutionNotice({
  headline = null,
  resolution,
  resolverLabel,
}: {
  headline?: string | null;
  resolution: AskResolution;
  resolverLabel?: string | null;
}): React.JSX.Element {
  const isDefault = resolution.defaultExecuted;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-3",
        isDefault
          ? "border-warning/40 bg-warning/5"
          : "border-border/60 bg-muted/30",
      )}
      data-testid="ask-resolution-notice"
    >
      <div className="flex items-center gap-2">
        <Badge variant={isDefault ? "warning" : "secondary"}>
          {isDefault ? "Default executed" : "Answered"}
        </Badge>
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">
          Ask closed
        </span>
      </div>
      {headline?.trim() ? (
        <p className="text-sm font-medium text-foreground">{headline}</p>
      ) : null}
      <p
        className={cn(
          "text-base",
          isDefault ? "text-warning" : "text-muted-foreground",
        )}
        data-testid={
          isDefault
            ? "ask-resolution-default-copy"
            : "ask-resolution-human-copy"
        }
      >
        {describeAskResolution(resolution, resolverLabel ?? null)}
      </p>
      {!isDefault && resolution.rationale ? (
        <p className="text-xs leading-4 text-muted-foreground">
          {resolution.rationale}
        </p>
      ) : null}
    </div>
  );
}
