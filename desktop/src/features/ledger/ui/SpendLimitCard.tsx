import { Gauge } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { SectionHeader } from "@/shared/ui/PageHeader";

/**
 * The three things people confuse for each other, said apart.
 *
 * A budget, a burn cap and a credit balance are not three strengths of the
 * same control. Two of them stop work and one of them does not, and which is
 * which is the difference between an owner who is protected and an owner who
 * thinks they are.
 *
 * So this card is the one place all three are stated together, in the order
 * of how much they actually do. The wording is load-bearing. A cap measured
 * per hour that reads as a monthly allowance is worse than no cap at all: it
 * would have someone believe a month is protected by a ceiling that resets
 * every hour, twenty-four times a day.
 *
 * The burn cap is deliberately shown without a value. It is a per-account
 * column the relay's gateway reads at admission
 * (`crates/buzz-relay/src/gateway/mod.rs`), and nothing exposes it for
 * reading or writing: no event kind, no HTTP route, no CLI. Printing a
 * plausible-looking number would be inventing one. Saying what it is, what
 * it does, and who holds it is the whole truth available today.
 */

function LimitRow({
  action,
  detail,
  strength,
  title,
}: {
  action?: React.ReactNode;
  detail: string;
  strength: string;
  title: string;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {title}
          <span className="ml-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            {strength}
          </span>
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

export function SpendLimitCard({
  onOpenCredits,
}: {
  /** Absent when the app cannot route to the Credits screen. */
  onOpenCredits?: () => void;
}) {
  return (
    <section
      aria-label="What limits spending"
      className="rounded-2xl border border-border/60 bg-card/60 px-5 py-4"
      data-testid="ledger-spend-limits"
    >
      <SectionHeader
        description="Two of these refuse work when they are reached. One only tells you afterwards. It is worth knowing which is which."
        title="What actually stops spending"
      />

      <ul className="mt-2 divide-y divide-border/50">
        <LimitRow
          action={
            onOpenCredits ? (
              <Button
                className="h-auto px-2 py-1 text-xs"
                data-testid="ledger-open-credits"
                onClick={onOpenCredits}
                type="button"
                variant="outline"
              >
                Add credits
              </Button>
            ) : undefined
          }
          detail="When the balance runs out, the gateway refuses the next call outright. This is the hard floor, and it is the one you control directly."
          strength="Stops work"
          title="Your credit balance"
        />
        <LimitRow
          detail="A ceiling on how fast money can leave, measured over a rolling hour. Reach it and further calls are refused with a retry time until the hour drains, then work resumes. It is a speed limit, not a monthly allowance: it caps a bad minute, and it will let the same amount through again next hour. Whoever operates this relay sets it, and it cannot be read or changed from here yet."
          strength="Stops work"
          title="The hourly burn cap"
        />
        <LimitRow
          detail="A budget records spend against a limit and reports how far through it you are. It refuses nothing. Passing one changes what this screen says and sends you a notification, and no agent stops working."
          strength="Reports only"
          title="Budgets"
        />
      </ul>

      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <Gauge aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        An hour of spending at the cap and a month inside a budget are different
        questions. Neither answers the other.
      </p>
    </section>
  );
}
