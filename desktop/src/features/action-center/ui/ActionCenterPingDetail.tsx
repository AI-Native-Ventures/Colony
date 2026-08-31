import * as React from "react";
import { Check, ExternalLink, UserCheck } from "lucide-react";
import { toast } from "sonner";

import { delegateAnswerToLead } from "../lib/delegateAnswerToLead";
import type { ActionPingSource } from "../contracts";
import { sendChannelMessage } from "@/shared/api/sendChannelMessage";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";

/**
 * A ping has no answer form (spec, out of scope: "the reply composer -- this
 * ticket makes pings appear and dismissable; answering them reuses the
 * composer once it exists"). The two in-place actions are dismissing it
 * (kind:7 reaction, see dismissThreadPing.ts) and, when the asker has a lead
 * to hand off to, delegating the decision (a plain threaded reply, see
 * delegateAnswerToLead.ts -- NOT a relay-enforced grant).
 */
export function ActionCenterPingDetail({
  onDismiss,
  onOpenSource,
  source,
  title,
}: {
  onDismiss: () => Promise<void>;
  onOpenSource?: () => void;
  source: ActionPingSource;
  /** Precomputed "<asker> asked in #<channel>" (see `actionCenterModel.ts`'s
   * `pingItem`) -- reused here rather than re-resolving the asker's name a
   * second time. */
  title: string;
}) {
  const [isDismissing, setIsDismissing] = React.useState(false);
  const [isDelegating, setIsDelegating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { ping, delegateTarget } = source;

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

  const handleDelegate = async () => {
    if (!delegateTarget) return;
    setError(null);
    setIsDelegating(true);
    try {
      await delegateAnswerToLead(ping, delegateTarget, { sendChannelMessage });
      await onDismiss();
      toast.success(`Handed off to ${delegateTarget.label}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to hand this off to the lead.",
      );
    } finally {
      setIsDelegating(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-4 overflow-y-auto p-4"
      data-testid="action-center-ping-detail"
    >
      <div className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">
          Ping
        </span>
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        <div className="max-h-80 overflow-y-auto rounded-md border border-border/60 p-3">
          <Markdown
            className="text-sm text-muted-foreground"
            content={ping.content}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="action-center-ping-dismiss"
          disabled={isDismissing || isDelegating}
          onClick={() => void handleDismiss()}
          size="sm"
        >
          <Check className="mr-2 size-4" />
          {isDismissing ? "Dismissing…" : "Dismiss"}
        </Button>
        {delegateTarget ? (
          <Button
            data-testid="action-center-ping-delegate"
            disabled={isDismissing || isDelegating}
            onClick={() => void handleDelegate()}
            size="sm"
            variant="outline"
          >
            <UserCheck className="mr-2 size-4" />
            {isDelegating ? "Handing off…" : `Hand to ${delegateTarget.label}`}
          </Button>
        ) : null}
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
