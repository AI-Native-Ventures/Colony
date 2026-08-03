import type {
  AttributionMethod,
  BudgetStatus,
  LedgerEntry,
  LedgerReport,
} from "../report";
import { describeException, NEEDS_REVIEW_COST_CENTRE } from "../report";

/**
 * Turning a computed ledger into the few things a company owner acts on.
 *
 * Every function here is pure and works in `bigint`, because these numbers
 * are money. Percentages are the one place a `number` appears: they are for
 * the width of a bar, never for an amount.
 */

/** How urgently something wants the owner's attention. */
export type AttentionSeverity = "blocking" | "warning";

/** One thing standing between the owner and a trustworthy total. */
export interface AttentionItem {
  /** Stable key for rendering. */
  id: string;
  /** What is wrong, in one line. */
  title: string;
  /** Why it matters and what fixes it. */
  detail: string;
  /** Blocking means the totals shown are known to be incomplete. */
  severity: AttentionSeverity;
}

/**
 * A percentage for display, to two decimal places.
 *
 * Computed by scaling in `bigint` before the single conversion to `number`,
 * so a total past `Number.MAX_SAFE_INTEGER` still yields the right ratio.
 * Returns `null` when the denominator is zero, which is not 0% but "no
 * ratio exists".
 */
export function percentOf(part: bigint, whole: bigint): number | null {
  if (whole === 0n) return null;
  return Number((part * 10_000n) / whole) / 100;
}

/** Budget usage as a percentage, or `null` for a zero-limit budget. */
export function budgetUsedPercent(status: BudgetStatus): number | null {
  return percentOf(status.actualNanousd, status.budgetNanousd);
}

/** Whether spend has passed the limit. */
export function isOverBudget(status: BudgetStatus): boolean {
  return status.actualNanousd > status.budgetNanousd;
}

/**
 * Budgets ordered by how close they are to their limit, worst first.
 *
 * An owner opening this screen wants the budget about to break, not the
 * alphabetically first one. Zero-limit budgets sort last: they cannot be
 * exceeded in any meaningful sense.
 */
export function budgetsByPressure(
  statuses: readonly BudgetStatus[],
): BudgetStatus[] {
  return [...statuses].sort((left, right) => {
    const leftUsed = budgetUsedPercent(left);
    const rightUsed = budgetUsedPercent(right);
    if (leftUsed === null && rightUsed === null) return 0;
    if (leftUsed === null) return 1;
    if (rightUsed === null) return -1;
    return rightUsed - leftUsed;
  });
}

/**
 * Cost centres ordered by spend, largest first, with unattributed money
 * last regardless of size.
 *
 * `needs-review` is not a cost centre; it is the absence of one. Ranking it
 * among real cost centres would read as though the company had a department
 * called "needs review".
 */
export function costCentresBySpend(
  totals: LedgerReport["byCostCentre"],
): LedgerReport["byCostCentre"] {
  return [...totals].sort((left, right) => {
    const leftUnattributed = left.costCentreId === NEEDS_REVIEW_COST_CENTRE;
    const rightUnattributed = right.costCentreId === NEEDS_REVIEW_COST_CENTRE;
    if (leftUnattributed !== rightUnattributed)
      return leftUnattributed ? 1 : -1;
    if (left.amountNanousd === right.amountNanousd) {
      return left.costCentreId.localeCompare(right.costCentreId);
    }
    return left.amountNanousd > right.amountNanousd ? -1 : 1;
  });
}

/**
 * The most recent entries, newest first.
 *
 * The engine returns entries oldest-first because that is the order it
 * counted them in; a reader wants the opposite.
 */
export function recentEntries(
  entries: readonly LedgerEntry[],
  limit: number,
): LedgerEntry[] {
  return [...entries].reverse().slice(0, limit);
}

/** A plain-language reading of how an entry got its attribution. */
export function describeAttribution(method: AttributionMethod): string {
  switch (method.kind) {
    case "explicit":
      return "Recorded with the work it belonged to";
    case "rule":
      return "Matched an attribution rule";
    case "correction":
      return "Corrected by hand";
    case "needsReview":
      return "Not attributed yet";
  }
}

/**
 * Everything that makes the headline totals less than the whole truth.
 *
 * Ordered blocking-first. The distinction is whether the number on screen
 * is known to be wrong (money the ledger could not price or could not read)
 * or merely unfinished (money it could price but not attribute).
 */
export function attentionItems(report: LedgerReport): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (report.unreadableRecords > 0) {
    const plural = report.unreadableRecords === 1 ? "record" : "records";
    items.push({
      detail:
        "These were addressed to this company but could not be decrypted, so their spend is missing from every total on this page. This usually means they were written for a different identity.",
      id: "unreadable",
      severity: "blocking",
      title: `${report.unreadableRecords} spend ${plural} could not be read`,
    });
  }

  if (report.priceBookMissing) {
    items.push({
      detail:
        "No prices have been published, so no usage can be costed. Add prices with `buzz ledger prices-add` and every recorded call becomes countable, with no need to re-record anything.",
      id: "no-price-book",
      severity: "blocking",
      title: "No price list has been published",
    });
  } else {
    const unpricedModels = new Set(
      report.exceptions
        .filter((exception) => exception.type === "unpricedModel")
        .map((exception) => String(exception.detail.model ?? "unknown")),
    );
    for (const model of unpricedModels) {
      items.push({
        detail: `Calls to ${model} are recorded but have no price, so their cost is unknown and excluded from the totals. Adding a price for it counts them, retroactively.`,
        id: `unpriced:${model}`,
        severity: "blocking",
        title: `${model} has no price on file`,
      });
    }
  }

  for (const exception of report.exceptions) {
    if (exception.type === "unpricedModel") continue;
    items.push({
      detail: describeException(exception),
      id: `${exception.type}:${String(exception.detail.eventId ?? exception.detail.key ?? exception.detail.day ?? "")}`,
      severity: exception.type === "duplicateConflict" ? "warning" : "warning",
      title: exceptionTitle(exception.type),
    });
  }

  if (report.totals.needsReview > 0n) {
    items.push({
      detail:
        "This spend is counted in the total but not charged to any cost centre, so it cannot be billed to a client or measured against a budget. Attributing it needs either a rule or a correction.",
      id: "needs-review",
      severity: "warning",
      title: "Some spend is not attributed to a cost centre",
    });
  }

  return items.sort((left, right) => {
    if (left.severity === right.severity) return 0;
    return left.severity === "blocking" ? -1 : 1;
  });
}

function exceptionTitle(type: string): string {
  switch (type) {
    case "duplicateConflict":
      return "Two records disagree about the same call";
    case "badTimestamp":
      return "A record had an unreadable timestamp";
    case "reconcileDrift":
      return "The ledger and the provider disagree about a day";
    case "reconcileMissingDay":
      return "A day appears on only one side of the comparison";
    default:
      return "The ledger flagged something";
  }
}
