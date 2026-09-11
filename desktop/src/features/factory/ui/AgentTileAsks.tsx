import * as React from "react";
import { CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { answerAsk, type AskAnswerInput } from "@/features/asks/answerAsk";
import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { AskDetailCard } from "@/features/asks/ui/AskDetailCard";
import { nativeErrorMessage } from "@/features/factory/lib/nativeErrorMessage";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";

/**
 * The asks this tile's agent is blocked on, answerable where the work is.
 *
 * The answer goes out as the canonical kind 44301 resolution through
 * `answerAsk`, with the same dependencies the action center supplies, so a
 * card answered here closes the ask everywhere — the card disappears on the
 * query invalidation `answerAsk` performs, not on any local state of its own.
 *
 * The thread-reply route the action center also offers is deliberately absent:
 * this surface is the agent's own pane, so "reply in the origin thread" is
 * what the composer below already is.
 */
export function AgentTileAsks({
  agentName,
  asks,
}: {
  agentName: string;
  asks: readonly OpenAsk[];
}): React.JSX.Element | null {
  if (asks.length === 0) return null;

  return (
    // Capped and scrollable: an ask with several long options must not push
    // the transcript out of the pane entirely, which is the one thing the
    // owner needs in order to judge the ask.
    <div
      className="flex max-h-[75%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-border/60 px-3 py-2"
      data-testid="agent-tile-asks"
    >
      {asks.map((ask) => (
        <AgentTileAskCard agentName={agentName} ask={ask} key={ask.id} />
      ))}
    </div>
  );
}

function AgentTileAskCard({
  agentName,
  ask,
}: {
  agentName: string;
  ask: OpenAsk;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const handleAnswer = React.useCallback(
    async (answer: AskAnswerInput) => {
      setIsSubmitting(true);
      try {
        await answerAsk(ask, answer, {
          invalidateQueries: (queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          publishEvent: (event, timeoutMessage, sendErrorMessage) =>
            relayClient.publishEvent(event, timeoutMessage, sendErrorMessage),
          signRelayEvent,
        });
        toast.success("Ask answered");
      } catch (cause) {
        toast.error(nativeErrorMessage(cause, "Failed to answer the ask."));
      } finally {
        setIsSubmitting(false);
      }
    },
    [ask, queryClient],
  );

  return (
    <div
      className="rounded-md border border-warning/50 bg-warning-bg"
      data-ask-id={ask.id}
      data-testid="agent-tile-ask"
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 text-xs font-medium text-warning">
        <CircleAlert aria-hidden className="h-3.5 w-3.5" />
        {agentName} asks you
      </div>
      <AskDetailCard
        ask={ask}
        compact
        isSubmitting={isSubmitting}
        onAnswer={handleAnswer}
      />
    </div>
  );
}
