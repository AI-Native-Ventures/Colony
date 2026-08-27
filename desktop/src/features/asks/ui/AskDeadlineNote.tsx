import type * as React from "react";

import {
  askDeadlineBadgeLabel,
  askDeadlineBadgeVariant,
  askDeadlineUrgency,
  describeAskExpiry,
  formatAskDeadline,
  type AskState,
} from "@/features/asks/lib/askState";
import { Badge } from "@/shared/ui/badge";
import { useNow } from "@/shared/lib/useNow";

/**
 * How often the countdown re-renders.
 *
 * Thirty seconds, and the copy never shows seconds. Two reasons, both about
 * honesty rather than performance alone: the relay's own due-ask sweep runs
 * on `BUZZ_INTERRUPT_SWEEP_SECS` (60 by default), so a ticking seconds
 * display would promise precision the relay does not honour; and a
 * minute-granularity label is at most 30 seconds stale at this interval,
 * which nobody can perceive.
 *
 * The cost is bounded by construction. `useNow` owns one interval, it pauses
 * entirely while the document is hidden, and this component is a leaf: it is
 * the only thing that re-renders on a tick. Nothing above it (the ask card,
 * the inbox list, the message timeline) sees the clock at all, which is the
 * whole reason the countdown lives in its own component rather than in
 * `AskDetailCard`.
 */
const DEADLINE_TICK_MS = 30_000;

type AskDeadlineNoteProps = {
  state: AskState | null;
  /**
   * When the ask was filed. Only the re-arm branch uses it, to turn "still
   * waiting" into a number: an ask that has been parked for eleven days calls
   * for a different reaction from one filed this morning.
   */
  askCreatedAt: number;
  isLoading: boolean;
  error: Error | null;
};

/**
 * The deadline, what happens when it passes, and how much of it is left.
 *
 * Renders nothing when the ask has no live deadline to show (a closed head, a
 * head that never arrived, or one not signed by this relay). The one thing it
 * will not do is invent a number: `deadlineAt` is the relay's own value or
 * there is no countdown.
 */
export function AskDeadlineNote({
  state,
  askCreatedAt,
  isLoading,
  error,
}: AskDeadlineNoteProps): React.JSX.Element | null {
  if (error) {
    return (
      <p
        className="text-xs leading-4 text-muted-foreground"
        data-testid="ask-deadline-error"
      >
        Colony could not read this ask's deadline. Answering still works, but
        the countdown is unavailable until the relay responds.
      </p>
    );
  }

  if (isLoading) {
    return (
      <p
        className="text-xs leading-4 text-muted-foreground"
        data-testid="ask-deadline-loading"
      >
        Checking the deadline…
      </p>
    );
  }

  if (state?.status !== "open" || state.deadlineAt === null) {
    return null;
  }

  // The clock lives one level down so it only exists when there is genuinely
  // something to count. A closed ask, or one whose head never arrived, mounts
  // no interval at all rather than ticking against a value it never renders.
  return (
    <AskDeadlineClock
      askCreatedAt={askCreatedAt}
      deadlineAt={state.deadlineAt}
      state={state}
    />
  );
}

function AskDeadlineClock({
  askCreatedAt,
  deadlineAt,
  state,
}: {
  askCreatedAt: number;
  deadlineAt: number;
  state: AskState;
}): React.JSX.Element {
  const now = useNow(DEADLINE_TICK_MS);
  const urgency = askDeadlineUrgency(deadlineAt, now);
  const expiry = describeAskExpiry(
    state,
    askCreatedAt,
    Math.floor(now / 1_000),
  );

  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2"
      data-testid="ask-deadline"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          data-testid="ask-deadline-badge"
          variant={askDeadlineBadgeVariant(urgency)}
        >
          {askDeadlineBadgeLabel(deadlineAt, now)}
        </Badge>
        <span
          className="text-xs leading-4 text-muted-foreground"
          data-testid="ask-deadline-when"
        >
          {formatAskDeadline(deadlineAt, now)}
        </span>
      </div>
      {expiry ? (
        <p
          className="text-xs leading-4 text-muted-foreground"
          data-testid="ask-deadline-expiry"
        >
          {expiry}
        </p>
      ) : null}
      {state.rearmedAt !== null ? (
        <p
          className="text-2xs uppercase tracking-wide text-muted-foreground"
          data-testid="ask-deadline-rearmed"
        >
          Clock restarted by Colony
        </p>
      ) : null}
    </div>
  );
}
