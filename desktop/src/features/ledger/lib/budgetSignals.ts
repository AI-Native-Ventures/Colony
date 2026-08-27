import { formatNanousd } from "../contracts";
import type { BudgetStatus } from "../report";
import { isOverBudget } from "./summarize";

/**
 * Turning a budget that has been passed into something an owner is told.
 *
 * A budget that only appears as a bar on a screen nobody has open is not a
 * control, it is a decoration. This is the pure half: it decides which
 * budgets warrant an alert and what the alert says. `useBudgetNotifications`
 * owns the React and the delivery, exactly as `askNotificationSignals` and
 * `useAskNotifications` are split, so the wording and the threshold can be
 * tested without a browser.
 *
 * One thing every message here has to keep saying: passing a budget changes
 * nothing on its own. Nothing is stopped, no agent is paused, no call is
 * refused. Colony records spend against the limit and tells the owner. An
 * alert that implied enforcement would be worse than no alert, because it
 * would buy false confidence at exactly the moment money is running.
 */

/** One thing worth telling the owner about a budget. */
export interface BudgetSignal {
  /** Stable dedupe key; one delivery per budget per period, ever. */
  key: string;
  /** Cost centre the budget governs. */
  costCentreId: string;
  /** Month, `YYYY-MM`. */
  period: string;
  /** Notification title. */
  title: string;
  /** Notification body. */
  body: string;
}

/** Dedupe key for one budget's exceeded alert. */
export function budgetExceededKey(status: BudgetStatus): string {
  return `over:${status.costCentreId}:${status.period}`;
}

/**
 * Budgets that have been passed and not yet announced.
 *
 * Only the crossing is announced, once. A budget that keeps climbing past
 * its limit produces one alert, not one per refresh: the owner already knows
 * it is over, and a notification every half hour trains them to dismiss the
 * one that matters.
 *
 * A zero-limit budget is skipped. Zero is how a cost centre is marked as
 * having no allowance rather than a limit of nothing, and every penny would
 * otherwise trip it.
 */
export function budgetExceededSignals(input: {
  statuses: readonly BudgetStatus[];
  delivered: ReadonlySet<string>;
}): BudgetSignal[] {
  const signals: BudgetSignal[] = [];
  for (const status of input.statuses) {
    if (status.budgetNanousd === 0n) continue;
    if (!isOverBudget(status)) continue;
    const key = budgetExceededKey(status);
    if (input.delivered.has(key)) continue;
    signals.push({
      body:
        `${formatNanousd(status.actualNanousd)} spent against a ` +
        `${formatNanousd(status.budgetNanousd)} budget. Nothing has been ` +
        `stopped: Colony records spend against a budget, it does not enforce ` +
        `one.`,
      costCentreId: status.costCentreId,
      key,
      period: status.period,
      title: `${status.costCentreId} is over budget for ${status.period}`,
    });
  }
  return signals;
}

/** Merge newly delivered keys into the stored set, newest last. */
export function mergeBudgetNotificationKeys(
  stored: readonly string[],
  added: readonly string[],
): string[] {
  const merged = new Set(stored);
  let changed = false;
  for (const key of added) {
    if (!merged.has(key)) {
      merged.add(key);
      changed = true;
    }
  }
  return changed ? [...merged] : [...stored];
}
