import * as React from "react";

import type { OpenAsk } from "@/features/asks/lib/askEvent";
import type { AskAnswerRoute } from "../lib/answerRouting";

export type AskComposerAnswer = {
  decision: string;
  rationale: string;
};

/**
 * The inline composer an expanded ask row answers from.
 *
 * Free-text only for now: option buttons (spec "Answering", item 4 of the
 * in-thread-answering ticket) are a later step. Where the answer actually
 * goes — an ordinary thread reply, or the kind 44301 card as a thread-less
 * fallback — is decided by `route`, computed by the caller via
 * `resolveAskAnswerRoute`; this component only renders what that routing
 * implies and never decides it itself.
 */
export function ActionCenterAskComposer({
  ask,
  route,
  isSubmitting,
  isResolving,
  onSubmit,
}: {
  ask: OpenAsk;
  route: AskAnswerRoute;
  isSubmitting: boolean;
  /** True once a threaded reply was sent and the ask is waiting for the
   * relay's auto-resolve to confirm on the next open-asks refetch. */
  isResolving: boolean;
  onSubmit: (answer: AskComposerAnswer) => Promise<void>;
}) {
  const [decision, setDecision] = React.useState("");
  const [rationale, setRationale] = React.useState("");

  // Selection belongs to one ask. Moving to another must not carry a stale
  // draft across (React's documented "adjusting state when a prop changes"
  // pattern, mirroring the same reset AskDetailCard already did).
  const [answeringAskId, setAnsweringAskId] = React.useState(ask.id);
  if (answeringAskId !== ask.id) {
    setAnsweringAskId(ask.id);
    setDecision("");
    setRationale("");
  }

  const disabled = isSubmitting || isResolving;
  const canSubmit = decision.trim().length > 0 && !disabled;

  const submit = () => {
    void onSubmit({ decision: decision.trim(), rationale: rationale.trim() });
  };

  if (isResolving) {
    return (
      <div
        className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground"
        data-testid="action-center-ask-resolving"
      >
        Reply sent. This ask leaves your queue once the relay confirms it —
        usually within moments.
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="action-center-ask-composer"
    >
      {route.kind === "resolution-card" ? (
        <p
          className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          data-testid="action-center-ask-no-thread-note"
        >
          This ask has no origin thread, so answering here publishes a
          resolution directly — answered directly (no thread).
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Your answer</span>
        <textarea
          className="min-h-24 rounded-md border border-border bg-background p-2 text-sm outline-none"
          data-testid="action-center-ask-decision"
          disabled={disabled}
          onChange={(event) => setDecision(event.target.value)}
          placeholder="What you decided."
          value={decision}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Why (optional)</span>
        <textarea
          className="min-h-16 rounded-md border border-border bg-background p-2 text-sm outline-none"
          data-testid="action-center-ask-rationale"
          disabled={disabled}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="Reasoning the agent should carry forward."
          value={rationale}
        />
      </label>

      <button
        className="self-start rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        data-testid="action-center-ask-submit"
        disabled={!canSubmit}
        onClick={submit}
        type="button"
      >
        {isSubmitting
          ? "Sending…"
          : route.kind === "thread-reply"
            ? "Reply and unblock"
            : "Answer and unblock"}
      </button>
    </div>
  );
}
