import { Receipt } from "lucide-react";

import { PageHeader } from "@/shared/ui/PageHeader";
import { Skeleton } from "@/shared/ui/skeleton";

import type { SpendPeriod, UsageSpend } from "../agentSpend";
import { attentionItems } from "../lib/summarize";
import type { LedgerEntry, LedgerReport } from "../report";
import { LedgerActivity } from "./LedgerActivity";
import { LedgerAttention } from "./LedgerAttention";
import { LedgerBreakdown } from "./LedgerBreakdown";
import { LedgerByAgent } from "./LedgerByAgent";
import { LedgerByJob } from "./LedgerByJob";
import { LedgerTotals } from "./LedgerTotals";
import { SpendLimitCard } from "./SpendLimitCard";

/**
 * What the company has spent on agent work.
 *
 * Presentational: the caller owns fetching, so this renders the same way
 * from live data or a fixture. The order of the page is deliberate —
 * anything that makes the totals incomplete appears above them, because a
 * reader who meets a number first has already trusted it.
 *
 * The order below that is a widening of the same question. The totals say
 * what the company spent; the breakdown says which part of the company;
 * "what actually stops spending" says which of the three limits people
 * conflate would have caught it; and then by agent and by job say who and on
 * what. By agent sits outside the "any spend recorded" gate on purpose: the
 * archive can hold an agent's turns on a machine where no signed usage
 * record has landed yet, and a screen that hid that would report a working
 * agent as costing nothing.
 */

function LoadingState() {
  return (
    <div aria-busy="true" aria-label="Loading spend" role="status">
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map((index) => (
          <div
            className="rounded-2xl border border-border/60 bg-card/60 px-5 py-4"
            key={index}
          >
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-3 h-7 w-36" />
            <Skeleton className="mt-2 h-3 w-48" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-4 h-36 w-full rounded-2xl" />
      <Skeleton className="mt-4 h-56 w-full rounded-2xl" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border/70 px-5 py-12 text-center">
      <Receipt
        aria-hidden="true"
        className="mx-auto size-8 text-muted-foreground"
      />
      <h2 className="mt-3 text-base font-semibold text-foreground">
        No agent spend recorded yet
      </h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        Spend appears here once agents start working. Every provider call an
        agent makes inside Colony is metered at the point it crosses the wire,
        so nothing has to be reported by hand.
      </p>
    </div>
  );
}

/** Everything the by-agent section needs, as the caller resolved it. */
export interface AgentSpendView {
  spend: UsageSpend | null;
  isLoading: boolean;
  error: Error | null;
  collectionEnabled: boolean;
}

export function LedgerScreen({
  agentSpend,
  error,
  isLoading,
  onAddPrice,
  onAttribute,
  onOpenCredits,
  onPeriodChange,
  period,
  report,
}: {
  /** Per-agent figures; absent when the host cannot supply them. */
  agentSpend?: AgentSpendView;
  error: Error | null;
  isLoading: boolean;
  /** Absent when the viewer cannot correct, e.g. is not the owner. */
  onAttribute?: (entry: LedgerEntry) => void;
  /** Absent when the viewer cannot publish prices. */
  onAddPrice?: () => void;
  /** Absent when the app cannot route to the Credits screen. */
  onOpenCredits?: () => void;
  onPeriodChange?: (period: SpendPeriod) => void;
  period?: SpendPeriod;
  report: LedgerReport | null;
}) {
  const hasSpend =
    report !== null &&
    (report.entries.length > 0 ||
      report.meteredNanousd > 0n ||
      report.imputedNanousd > 0n);

  return (
    <div
      className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8"
      data-testid="ledger-page"
    >
      <div className="mx-auto w-full max-w-6xl">
        <PageHeader
          description="What this company has spent on agent work, using provider billing records and clearly labeled runtime estimates."
          title="Spend"
        />

        <div className="mt-7 space-y-4">
          {isLoading ? <LoadingState /> : null}

          {!isLoading && error ? (
            <div
              className="rounded-2xl border border-destructive/25 bg-destructive/5 px-5 py-8"
              role="alert"
            >
              <h2 className="text-base font-semibold text-foreground">
                Spend could not be loaded
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {error.message}
              </p>
            </div>
          ) : null}

          {!isLoading && !error && report ? (
            <>
              <LedgerAttention
                items={attentionItems(report)}
                onAddPrice={onAddPrice}
              />
              {hasSpend ? (
                <>
                  <LedgerTotals report={report} />
                  <LedgerBreakdown report={report} />
                </>
              ) : (
                <EmptyState />
              )}

              <SpendLimitCard onOpenCredits={onOpenCredits} />

              {agentSpend && period && onPeriodChange ? (
                <LedgerByAgent
                  collectionEnabled={agentSpend.collectionEnabled}
                  error={agentSpend.error}
                  isLoading={agentSpend.isLoading}
                  onAddPrice={onAddPrice}
                  onPeriodChange={onPeriodChange}
                  period={period}
                  spend={agentSpend.spend}
                />
              ) : null}

              {hasSpend ? (
                <>
                  <LedgerByJob report={report} />
                  <LedgerActivity onAttribute={onAttribute} report={report} />
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
