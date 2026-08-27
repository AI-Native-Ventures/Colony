import { formatNanousd } from "../contracts";
import type { LedgerReport } from "../report";
import { percentOf } from "../lib/summarize";

/**
 * The headline numbers.
 *
 * Metered and imputed are kept apart on purpose. Metered is money that left
 * the bank; imputed is what subscription-covered work would have cost at API
 * prices. Adding them together would overstate the bill, and reporting only
 * the metered figure would make subscription-backed work look free.
 */

function Figure({
  caption,
  emphasis,
  label,
  value,
}: {
  caption: string;
  emphasis?: boolean;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 px-5 py-4">
      <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={
          emphasis
            ? "mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground"
            : "mt-2 text-2xl font-semibold tracking-tight tabular-nums text-muted-foreground"
        }
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

function ClassificationRow({
  amount,
  label,
  note,
  total,
}: {
  amount: bigint;
  label: string;
  note: string;
  total: bigint;
}) {
  const share = percentOf(amount, total);
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <p className="text-sm tabular-nums text-foreground">
        {formatNanousd(amount)}
        {share === null ? null : (
          <span className="ml-2 text-xs text-muted-foreground">
            {share.toFixed(0)}%
          </span>
        )}
      </p>
    </div>
  );
}

export function LedgerTotals({ report }: { report: LedgerReport }) {
  const classified =
    report.totals.cogs + report.totals.opex + report.totals.needsReview;

  return (
    <section aria-label="Spend totals" data-testid="ledger-totals">
      <div className="grid gap-3 sm:grid-cols-2">
        <Figure
          caption="Billed per token by the providers."
          emphasis
          label="Real money spent"
          value={formatNanousd(report.meteredNanousd)}
        />
        <Figure
          caption="Covered by subscriptions. Priced at the API equivalent so unit economics stay honest."
          label="Subscription equivalent"
          value={formatNanousd(report.imputedNanousd)}
        />
      </div>

      <div className="mt-4 rounded-2xl border border-border/60 bg-card/60 px-5 py-3">
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Where it lands in the accounts
        </p>
        <div className="mt-1 divide-y divide-border/50">
          <ClassificationRow
            amount={report.totals.cogs}
            label="Cost of delivery"
            note="Work done for a named client."
            total={classified}
          />
          <ClassificationRow
            amount={report.totals.opex}
            label="Operating expense"
            note="Internal work: the company running itself."
            total={classified}
          />
          <ClassificationRow
            amount={report.totals.needsReview}
            label="Not attributed"
            note="Counted, but not yet charged to any cost centre."
            total={classified}
          />
        </div>
      </div>
    </section>
  );
}
