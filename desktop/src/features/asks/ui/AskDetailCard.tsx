import * as React from "react";

import type { OpenAsk } from "@/features/asks/lib/askEvent";

type AskDetailCardProps = {
  ask: OpenAsk;
  onAnswer: (decision: string, rationale: string) => Promise<void>;
  isSubmitting: boolean;
};

/**
 * The card the founder answers an ask from.
 *
 * `ask_broker` already accepts an owner answering by replying in the thread;
 * this is the other half it was written against, so a founder does not have to
 * find the thread to unblock somebody.
 */
export function AskDetailCard({
  ask,
  onAnswer,
  isSubmitting,
}: AskDetailCardProps): React.JSX.Element {
  const [decision, setDecision] = React.useState("");
  const [rationale, setRationale] = React.useState("");
  const canSubmit = decision.trim().length > 0 && !isSubmitting;

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="ask-detail-card">
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

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Your answer</span>
        <textarea
          className="min-h-24 rounded-md border border-border bg-background p-2 text-sm outline-none"
          data-testid="ask-answer-decision"
          onChange={(event) => setDecision(event.target.value)}
          placeholder="What you decided."
          value={decision}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Why (optional)</span>
        <textarea
          className="min-h-16 rounded-md border border-border bg-background p-2 text-sm outline-none"
          data-testid="ask-answer-rationale"
          onChange={(event) => setRationale(event.target.value)}
          placeholder="Reasoning the agent should carry forward."
          value={rationale}
        />
      </label>

      <button
        className="self-start rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        data-testid="ask-answer-submit"
        disabled={!canSubmit}
        onClick={() => void onAnswer(decision.trim(), rationale.trim())}
        type="button"
      >
        {isSubmitting ? "Sending…" : "Answer and unblock"}
      </button>
    </div>
  );
}
