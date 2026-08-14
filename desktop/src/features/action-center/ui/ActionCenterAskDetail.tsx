import * as React from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { answerAsk } from "@/features/asks/answerAsk";
import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { AskDetailCard } from "@/features/asks/ui/AskDetailCard";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";
import { useQueryClient } from "@tanstack/react-query";

export function ActionCenterAskDetail({
  ask,
  onOpenSource,
}: {
  ask: OpenAsk;
  onOpenSource?: () => void;
}) {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleAnswer = React.useCallback(
    async (decision: string, rationale: string) => {
      setError(null);
      setIsSubmitting(true);
      try {
        await answerAsk(ask, decision, rationale, {
          invalidateQueries: (queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          publishEvent: (event, timeoutMessage, sendErrorMessage) =>
            relayClient.publishEvent(event, timeoutMessage, sendErrorMessage),
          signRelayEvent,
        });
        toast.success("Ask answered");
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Failed to answer the ask.",
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [ask, queryClient],
  );

  return (
    <div
      className="min-h-full overflow-y-auto"
      data-testid="action-center-ask-detail"
    >
      <AskDetailCard
        ask={ask}
        isSubmitting={isSubmitting}
        onAnswer={handleAnswer}
      />
      {error ? (
        <p
          className="px-4 pb-4 text-sm text-destructive"
          data-testid="action-center-ask-error"
        >
          {error}
        </p>
      ) : null}
      {ask.channelId && ask.threadId && onOpenSource ? (
        <div className="border-t border-border/60 px-4 py-4">
          <Button onClick={onOpenSource} size="sm" variant="outline">
            <ExternalLink className="mr-2 size-4" />
            Open source thread
          </Button>
        </div>
      ) : (
        <p className="border-t border-border/60 px-4 py-4 text-sm text-muted-foreground">
          This ask was filed globally, so answering here is the canonical
          action.
        </p>
      )}
    </div>
  );
}
