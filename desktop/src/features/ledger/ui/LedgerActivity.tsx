import { Button } from "@/shared/ui/button";
import { SectionHeader } from "@/shared/ui/PageHeader";

import { formatNanousd } from "../contracts";
import { describeAttribution, recentEntries } from "../lib/summarize";
import type { LedgerEntry, LedgerReport } from "../report";

/**
 * The most recent calls, newest first.
 *
 * Deliberately a sample rather than a full register: this answers "what has
 * been happening", and the auditable record is the ledger itself. An
 * unpriced call shows a dash and a note, never a zero, because zero would
 * claim the call was free.
 */

const ACTIVITY_LIMIT = 25;

/**
 * Whether this cost came from the vendor's list price rather than a rate for
 * the provider that actually served the call.
 *
 * The same model is sold by the lab that trained it and by everyone reselling
 * it, at their own prices, so a list rate applied to a resold call is wrong by
 * the reseller's margin. That is invisible in the number itself, which is the
 * whole reason it is marked.
 */
function atListPrice(entry: LedgerEntry): boolean {
  return entry.priceBasis === "listRow";
}

function describePriceBasis(entry: LedgerEntry): string | undefined {
  switch (entry.priceBasis) {
    case "observed":
      return `${entry.provider} stated this charge on the call itself.`;
    case "providerRow":
      return `Priced at ${entry.provider}'s own rate.`;
    case "listRow":
      return `Priced at the vendor's list rate. No rate is on file for ${entry.provider}, so this is only correct if ${entry.provider} charges list.`;
    default:
      return undefined;
  }
}

function Row({
  entry,
  onAttribute,
}: {
  entry: LedgerEntry;
  onAttribute?: (entry: LedgerEntry) => void;
}) {
  const unattributed = entry.attributedBy.kind === "needsReview";
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">
          {entry.model ?? entry.provider}
          {entry.paymentMode === "imputed" ? (
            <span className="ml-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              subscription
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {entry.day}
          {" · "}
          {entry.effectiveAssignment
            ? entry.effectiveAssignment.costCentreId
            : describeAttribution(entry.attributedBy)}
        </p>
      </div>
      <div className="flex items-baseline gap-3">
        {onAttribute ? (
          <Button
            className="h-auto px-2 py-1 text-xs"
            data-testid={`ledger-attribute-${entry.eventId.slice(0, 8)}`}
            onClick={() => onAttribute(entry)}
            type="button"
            variant="ghost"
          >
            {unattributed ? "Attribute" : "Reattribute"}
          </Button>
        ) : null}
        <p
          className={
            unattributed
              ? "text-sm tabular-nums text-muted-foreground"
              : "text-sm tabular-nums text-foreground"
          }
        >
          {entry.costNanousd === null ? (
            <span title="No price is on file for this model.">not priced</span>
          ) : (
            <span title={describePriceBasis(entry)}>
              {formatNanousd(entry.costNanousd)}
              {atListPrice(entry) ? (
                <span
                  className="ml-1 text-muted-foreground"
                  data-testid={`ledger-list-price-${entry.eventId.slice(0, 8)}`}
                >
                  *
                </span>
              ) : null}
            </span>
          )}
        </p>
      </div>
    </li>
  );
}

export function LedgerActivity({
  onAttribute,
  report,
}: {
  onAttribute?: (entry: LedgerEntry) => void;
  report: LedgerReport;
}) {
  const entries = recentEntries(report.entries, ACTIVITY_LIMIT);

  return (
    <section
      aria-label="Recent activity"
      className="rounded-2xl border border-border/60 bg-card/60 px-5 py-4"
      data-testid="ledger-activity"
    >
      <SectionHeader
        description={
          report.entries.length > entries.length
            ? `The ${entries.length} most recent of ${report.entries.length} recorded calls.`
            : "Every recorded call, newest first."
        }
        title="Recent activity"
      />
      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No agent spend has been recorded yet.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border/50">
          {entries.map((entry) => (
            <Row entry={entry} key={entry.eventId} onAttribute={onAttribute} />
          ))}
        </ul>
      )}
      {entries.some(atListPrice) ? (
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="ledger-list-price-legend"
        >
          * Priced at the vendor&apos;s list rate. No rate is on file for the
          provider that served the call, so the cost is only right if they
          charge list.
        </p>
      ) : null}
    </section>
  );
}
