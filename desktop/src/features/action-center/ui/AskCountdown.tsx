import * as React from "react";

import { formatCountdownMinutes } from "../lib/durationFormat";

/**
 * Live countdown text for a tier-1 ask ("defaults to <option> in 1h 40m"),
 * minute granularity (spec, resolved question 3).
 *
 * Isolated into its own leaf component so a tick only re-renders this span,
 * never the row or the list around it -- the whole point of avoiding a
 * per-second re-render is that most rows in a long queue are not counting
 * down at all, and they should never notice this one ticking. A plain
 * `setInterval(..., 60_000)` is the cheapest thing that is honest at
 * minute granularity: minute granularity IS the coarsest "live" refresh
 * that still qualifies as live, so there is nothing cheaper to reach for.
 * Each tick reads `Date.now()` fresh rather than incrementing a counter, so
 * a backgrounded tab that misses ticks self-corrects the moment it renders
 * again instead of drifting.
 */
export function AskCountdown({
  defaultOption,
  deadlineAt,
}: {
  defaultOption: string;
  /** Unix seconds, computed exactly as the broker computes it (see lib/askDeadline.ts). */
  deadlineAt: number;
}) {
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const remainingSeconds = deadlineAt - Math.floor(nowMs / 1_000);
  return (
    <span
      className="text-2xs font-medium text-destructive"
      data-testid="action-center-ask-countdown"
    >
      defaults to &ldquo;{defaultOption}&rdquo; in{" "}
      {formatCountdownMinutes(remainingSeconds)}
    </span>
  );
}
