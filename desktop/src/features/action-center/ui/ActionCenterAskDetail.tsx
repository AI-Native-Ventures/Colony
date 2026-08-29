import * as React from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { answerAsk } from "@/features/asks/answerAsk";
import { answerAskInThread } from "@/features/asks/answerAskInThread";
import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { relayClient } from "@/shared/api/relayClient";
import { sendChannelMessage } from "@/shared/api/sendChannelMessage";
import { signRelayEvent } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";

import { resolveAskAnswerRoute } from "../lib/answerRouting";
import {
  ActionCenterAskComposer,
  type AskComposerAnswer,
} from "./ActionCenterAskComposer";

export function ActionCenterAskDetail({
  ask,
  isResolving,
  onOpenSource,
  onThreadReplySent,
}: {
  ask: OpenAsk;
  /** True once a threaded reply for this ask (or a sibling ask bound to the
   * same origin thread, the relay resolves every one of them from a single
   * reply) has been sent and is waiting for confirmation. */
  isResolving: boolean;
  onOpenSource?: () => void;
  /** Called with the ask's origin thread id right after a threaded reply is
   * sent, so the caller can mark every ask bound to that thread as
   * resolving: a reply can close more than this one ask. */
  onThreadReplySent: (threadId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const route = resolveAskAnswerRoute(ask);

  const handleSubmit = React.useCallback(
    async (answer: AskComposerAnswer) => {
      setError(null);
      setIsSubmitting(true);
      try {
        if (route.kind === "thread-reply") {
          await answerAskInThread(
            { ...ask, channelId: route.channelId, threadId: route.threadId },
            answer,
            {
              sendChannelMessage,
              invalidateQueries: (queryKey) =>
                queryClient.invalidateQueries({ queryKey }),
            },
          );
          onThreadReplySent(route.threadId);
          toast.success("Reply sent");
        } else {
          await answerAsk(ask, answer, {
            invalidateQueries: (queryKey) =>
              queryClient.invalidateQueries({ queryKey }),
            publishEvent: (event, timeoutMessage, sendErrorMessage) =>
              relayClient.publishEvent(event, timeoutMessage, sendErrorMessage),
            signRelayEvent,
          });
          toast.success("Ask answered");
        }
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Failed to answer the ask.",
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [ask, onThreadReplySent, queryClient, route],
  );

  return (
    <div
      className="flex flex-col gap-4 overflow-y-auto p-4"
      data-testid="action-center-ask-detail"
    >
      <div className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">
          Ask · {ask.askType}
        </span>
        <h2 className="text-base font-medium text-foreground">
          {ask.headline}
        </h2>
        {ask.costOfDelay ? (
          <p className="text-sm text-muted-foreground">
            Waiting costs: {ask.costOfDelay}
          </p>
        ) : null}
      </div>

      <ActionCenterAskComposer
        ask={ask}
        isResolving={isResolving}
        isSubmitting={isSubmitting}
        onSubmit={handleSubmit}
        route={route}
      />

      {error ? (
        <p
          className="text-sm text-destructive"
          data-testid="action-center-ask-error"
        >
          {error}
        </p>
      ) : null}

      {ask.channelId && ask.threadId && onOpenSource ? (
        <div className="border-t border-border/60 pt-4">
          <Button onClick={onOpenSource} size="sm" variant="outline">
            <ExternalLink className="mr-2 size-4" />
            Open source thread
          </Button>
        </div>
      ) : null}
    </div>
  );
}
