import { Terminal } from "lucide-react";

import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { SectionHeader } from "@/shared/ui/PageHeader";

import { formatNanousd } from "../contracts";
import {
  budgetsByPressure,
  budgetUsedPercent,
  costCentresBySpend,
  isOverBudget,
  percentOf,
} from "../lib/summarize";
import { NEEDS_REVIEW_COST_CENTRE, type LedgerReport } from "../report";

/**
 * Where the money went, and how it sits against what was allowed.
 *
 * Bar widths are capped at 100% while the number beside them is not: a
 * budget at 140% should read as 140%, but a bar that overflowed its track
 * would just look broken.
 */

const BAR_MAX_PERCENT = 100;

function Bar({ over, percent }: { over: boolean; percent: number | null }) {
  const width = Math.min(percent ?? 0, BAR_MAX_PERCENT);
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={over ? "h-full bg-destructive" : "h-full bg-primary"}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/**
 * How to set a budget, said plainly rather than implied.
 *
 * Setting a budget publishes a relay-brokered ledger action, and the desktop
 * app has a command for a price and a command for a correction but not one
 * for a budget. So the only way to set one today is the CLI, and the honest
 * thing is to say so and hand over the exact line rather than render a button
 * that cannot work. A control that looks live and is not is worse than a
 * documented gap, because the owner walks away believing a limit exists.
 */
function SetBudgetInstructions() {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const command = `buzz ledger budget-set --cost-centre engineering --period ${period} --amount 500`;

  return (
    <div
      className="rounded-xl border border-border/60 bg-background/40 px-3 py-2"
      data-testid="ledger-budget-how-to"
    >
      <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Terminal aria-hidden="true" className="size-3" />
        Setting one
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Budgets are set from the CLI. The app cannot write one yet, so this is
        the whole of it:
      </p>
      <div className="mt-1.5 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-2xs text-foreground">
          {command}
        </code>
        <Button
          aria-label="Copy the command"
          className="h-auto shrink-0 px-2 py-1 text-2xs"
          onClick={() => copyTextToClipboard(command, "Command copied")}
          type="button"
          variant="ghost"
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function CostCentres({ report }: { report: LedgerReport }) {
  const totals = costCentresBySpend(report.byCostCentre);
  const overall = totals.reduce((sum, total) => sum + total.amountNanousd, 0n);

  if (totals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No spend has been attributed to a cost centre yet.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {totals.map((total) => {
        const unattributed = total.costCentreId === NEEDS_REVIEW_COST_CENTRE;
        const share = percentOf(total.amountNanousd, overall);
        return (
          <li key={total.costCentreId}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="min-w-0 truncate text-sm font-medium text-foreground">
                {unattributed ? "Not attributed" : total.costCentreId}
              </p>
              <p className="text-sm tabular-nums text-foreground">
                {formatNanousd(total.amountNanousd)}
                {share === null ? null : (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {share.toFixed(0)}%
                  </span>
                )}
              </p>
            </div>
            <Bar over={false} percent={share} />
          </li>
        );
      })}
    </ul>
  );
}

function Budgets({ report }: { report: LedgerReport }) {
  const statuses = budgetsByPressure(report.budgetStatus);

  if (statuses.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          No budgets have been set. Without one, spend is recorded but nothing
          says when it is too much.
        </p>
        <SetBudgetInstructions />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {statuses.map((status) => {
          const used = budgetUsedPercent(status);
          const over = isOverBudget(status);
          return (
            <li key={`${status.costCentreId}:${status.period}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="min-w-0 truncate text-sm font-medium text-foreground">
                  {status.costCentreId}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {status.period}
                  </span>
                </p>
                <p className="text-sm tabular-nums text-foreground">
                  {formatNanousd(status.actualNanousd)}
                  <span className="text-muted-foreground">
                    {" of "}
                    {formatNanousd(status.budgetNanousd)}
                  </span>
                  {used === null ? null : (
                    <span
                      className={
                        over
                          ? "ml-2 text-xs font-semibold text-destructive"
                          : "ml-2 text-xs text-muted-foreground"
                      }
                    >
                      {used.toFixed(0)}%
                    </span>
                  )}
                </p>
              </div>
              <Bar over={over} percent={used} />
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        A budget records spend against a limit and tells you when it is passed.
        It refuses nothing: no agent stops and no call is declined for going
        over one.
      </p>
      <SetBudgetInstructions />
    </div>
  );
}

export function LedgerBreakdown({ report }: { report: LedgerReport }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section
        aria-label="Spend by cost centre"
        className="rounded-2xl border border-border/60 bg-card/60 px-5 py-4"
        data-testid="ledger-cost-centres"
      >
        <SectionHeader
          description="What each part of the company spent."
          title="By cost centre"
        />
        <div className="mt-4">
          <CostCentres report={report} />
        </div>
      </section>

      <section
        aria-label="Budgets"
        className="rounded-2xl border border-border/60 bg-card/60 px-5 py-4"
        data-testid="ledger-budgets"
      >
        <SectionHeader
          description="Spend against the limits set for this month. Recorded and reported, never enforced."
          title="Budgets"
        />
        <div className="mt-4">
          <Budgets report={report} />
        </div>
      </section>
    </div>
  );
}
