import * as React from "react";
import { Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import type { ActionPingSource } from "../contracts";
import { Button } from "@/shared/ui/button";

/**
 * A ping has no answer form (spec, out of scope: "the reply composer -- this
 * ticket makes pings appear and dismissable; answering them reuses the
 * composer once it exists"). The only in-place action is dismissing it, which
 * publishes a kind:7 reaction on the ping message rather than any local
 * state -- see dismissThreadPing.ts.
 */
export function ActionCenterPingDetail({
  onDismiss,
  onOpenSource,
  source,
}: {
  onDismiss: () => Promise<void>;
  onOpenSource?: () => void;
  source: ActionPingSource;
}) {
  const [isDismissing, setIsDismissing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleDismiss = async () => {
    setError(null);
    setIsDismissing(true);
    try {
      await onDismiss();
      toast.success("Ping dismissed");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to dismiss the ping.",
      );
    } finally {
      setIsDismissing(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-4 overflow-y-auto p-4"
      data-testid="action-center-ping-detail"
    >
      <div className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">
          Ping · #{source.ping.channelName}
        </span>
        <h2 className="text-base font-medium text-foreground">
          Waiting on you in this thread
        </h2>
        <p className="text-sm text-muted-foreground">{source.ping.content}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="action-center-ping-dismiss"
          disabled={isDismissing}
          onClick={() => void handleDismiss()}
          size="sm"
        >
          <Check className="mr-2 size-4" />
          {isDismissing ? "Dismissing…" : "Dismiss"}
        </Button>
        {onOpenSource ? (
          <Button onClick={onOpenSource} size="sm" variant="outline">
            <ExternalLink className="mr-2 size-4" />
            Open thread
          </Button>
        ) : null}
      </div>

      {error ? (
        <p
          className="text-sm text-destructive"
          data-testid="action-center-ping-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
