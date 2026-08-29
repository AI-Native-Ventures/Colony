import * as React from "react";

import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { readAskOptions } from "@/features/asks/lib/askOptions";
import { Badge } from "@/shared/ui/badge";
import {
  buildFreeTextAnswer,
  buildOptionAnswer,
  type AskComposerAnswer,
} from "../lib/askComposerAnswer";
import type { AskAnswerRoute } from "../lib/answerRouting";

export type { AskComposerAnswer } from "../lib/askComposerAnswer";

/**
 * The inline composer an expanded ask row answers from.
 *
 * Where the answer actually goes (an ordinary thread reply, or the kind
 * 44301 card as a thread-less fallback) is decided by `route`, computed by
 * the caller via `resolveAskAnswerRoute`; this component only renders what
 * that routing implies and never decides it itself. Same for the shape of
 * the answer: an option tap and a free-text submit both produce the same
 * `AskComposerAnswer`, so the caller never needs a third path for options.
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
  const { options } = React.useMemo(
    () => readAskOptions(ask.rawContent),
    [ask.rawContent],
  );
  const hasOptions = options.length > 0;

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
  // A decision/question ask still refuses an empty answer (the relay
  // requires a non-null answer either way, and a blank free-text box is not
  // one); `buildFreeTextAnswer` returning null is that check.
  const canSubmitFreeText =
    buildFreeTextAnswer(decision, rationale) !== null && !disabled;

  const submitFreeText = () => {
    const answer = buildFreeTextAnswer(decision, rationale);
    if (!answer) return;
    void onSubmit(answer);
  };

  // An option tap with no typed rationale must still work (spec: "Option tap
  // with empty rationale works") -- buildOptionAnswer never validates,
  // because picking an option IS the answer.
  const submitOption = (label: string) => {
    void onSubmit(buildOptionAnswer(label, rationale));
  };

  if (isResolving) {
    return (
      <div
        className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground"
        data-testid="action-center-ask-resolving"
      >
        Reply sent. This ask leaves your queue once the relay confirms it,
        usually within moments.
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="action-center-ask-composer"
    >
      {ask.askType === "credential" ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          data-testid="action-center-ask-credential-warning"
        >
          Never paste the credential itself here. Answering only confirms it was
          delivered out of band: resolutions and messages are stored unencrypted
          and fan out to the whole community, and NIP-IQ gives asks no field
          meant to carry a secret value.
        </p>
      ) : null}

      {route.kind === "resolution-card" ? (
        <p
          className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          data-testid="action-center-ask-no-thread-note"
        >
          This ask has no origin thread, so answering here publishes a
          resolution directly: answered directly (no thread).
        </p>
      ) : null}

      {hasOptions ? (
        <fieldset
          className="flex flex-col gap-2"
          data-testid="action-center-ask-options"
        >
          <legend className="mb-1 text-xs text-muted-foreground">
            Pick one. Tapping sends it immediately.
          </legend>
          {options.map((option) => (
            <button
              className="flex flex-col items-start gap-1 rounded-md border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid={`action-center-ask-option-${option.label}`}
              disabled={disabled}
              key={option.label}
              onClick={() => submitOption(option.label)}
              type="button"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  {option.label}
                </span>
                {option.recommended ? (
                  <Badge
                    data-testid="action-center-ask-option-recommended"
                    variant="success"
                  >
                    Recommended
                  </Badge>
                ) : null}
                {option.isDefault ? (
                  <Badge
                    data-testid="action-center-ask-option-default"
                    variant="warning"
                  >
                    Happens if you do not answer
                  </Badge>
                ) : null}
              </span>
              <span className="text-xs leading-4 text-muted-foreground">
                {option.consequence ??
                  "The agent did not say what this choice causes."}
              </span>
            </button>
          ))}
        </fieldset>
      ) : (
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
      )}

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

      {hasOptions ? null : (
        <button
          className="self-start rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          data-testid="action-center-ask-submit"
          disabled={!canSubmitFreeText}
          onClick={submitFreeText}
          type="button"
        >
          {isSubmitting
            ? "Sending…"
            : route.kind === "thread-reply"
              ? "Reply and unblock"
              : "Answer and unblock"}
        </button>
      )}
    </div>
  );
}
