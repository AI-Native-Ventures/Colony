import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  type AgentUsageSeries,
  getAgentUsageSeries,
  onAgentMetricsChanged,
} from "@/shared/api/tauriArchive";

import {
  localMidnightBoundaries,
  priceUsageSeries,
  type UsageSpend,
} from "./agentSpend";
import type { Budget, CorrectionBook, PriceBook, Rulebook } from "./contracts";
import {
  loadBudgets,
  loadCorrectionBook,
  loadPriceBook,
  loadRulebook,
} from "./ledgerRepository";
import { type CorrectionRequest, submitCorrection } from "./corrections";
import { type PriceRequest, publishPrice } from "./prices";
import { type LedgerReport, loadLedgerReport } from "./report";

/**
 * React Query access to a community's cost ledger books.
 *
 * Every key starts with the community ID. Switching community remounts the
 * subtree but the query cache survives, so a key that omitted it would serve
 * the previous company's prices and spend to the next one.
 */

const LEDGER_ROOT = "colony-ledger" as const;

export function priceBookQueryKey(communityId: string) {
  return [LEDGER_ROOT, communityId, "pricebook"] as const;
}

export function rulebookQueryKey(communityId: string) {
  return [LEDGER_ROOT, communityId, "rulebook"] as const;
}

export function correctionBookQueryKey(communityId: string) {
  return [LEDGER_ROOT, communityId, "corrections"] as const;
}

export function budgetsQueryKey(communityId: string) {
  return [LEDGER_ROOT, communityId, "budgets"] as const;
}

export function ledgerReportQueryKey(communityId: string) {
  return [LEDGER_ROOT, communityId, "report"] as const;
}

export function usePriceBook(communityId: string) {
  return useQuery<PriceBook | null>({
    queryKey: priceBookQueryKey(communityId),
    queryFn: loadPriceBook,
    enabled: communityId.length > 0,
  });
}

export function useRulebook(communityId: string) {
  return useQuery<Rulebook | null>({
    queryKey: rulebookQueryKey(communityId),
    queryFn: loadRulebook,
    enabled: communityId.length > 0,
  });
}

export function useCorrectionBook(communityId: string) {
  return useQuery<CorrectionBook | null>({
    queryKey: correctionBookQueryKey(communityId),
    queryFn: loadCorrectionBook,
    enabled: communityId.length > 0,
  });
}

export function useBudgets(communityId: string) {
  return useQuery<{ budgets: Budget[]; unreadable: number }>({
    queryKey: budgetsQueryKey(communityId),
    queryFn: loadBudgets,
    enabled: communityId.length > 0,
  });
}

/**
 * The computed ledger.
 *
 * Unlike the book reads above, this one decrypts every usage record and
 * folds them through the pricing engine, so it is the expensive query here.
 * `staleTime` is generous because spend is a running total, not a live
 * feed: a number a minute old is still the right number to act on.
 */
export function useLedgerReport(
  communityId: string,
  options?: {
    /**
     * Re-run the report on an interval, for a caller that is watching rather
     * than reading: the budget alerter needs a figure that keeps moving even
     * though nobody is looking at the Spend screen.
     *
     * Not free. Each run re-reads and decrypts every usage record addressed
     * to this identity, so an interval here is a real cost paid on a timer.
     * Anything watching should choose an interval matched to how fast the
     * thing it watches actually changes; a monthly budget does not need
     * minutes. React Query does not refetch on an interval while the window
     * is in the background, so a closed laptop costs nothing.
     */
    refetchIntervalMs?: number;
  },
) {
  return useQuery<LedgerReport>({
    queryKey: ledgerReportQueryKey(communityId),
    queryFn: loadLedgerReport,
    enabled: communityId.length > 0,
    staleTime: 60_000,
    ...(options?.refetchIntervalMs
      ? { refetchInterval: options.refetchIntervalMs }
      : {}),
  });
}

/**
 * Record a correction, then refetch the ledger.
 *
 * The refetch is the point: a correction changes what the totals say, and a
 * screen still showing the pre-correction figures would leave the owner
 * unsure whether it took effect.
 */
export function useRecordCorrection(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CorrectionRequest) => submitCorrection(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ledgerReportQueryKey(communityId),
      });
      void queryClient.invalidateQueries({
        queryKey: correctionBookQueryKey(communityId),
      });
    },
  });
}

/**
 * Publish a price, then refetch the ledger.
 *
 * A price makes previously unpriced calls countable, so the totals change
 * the moment it lands. Leaving the old figures on screen would make it look
 * as though nothing had happened.
 */
export function usePublishPrice(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: PriceRequest) => publishPrice(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ledgerReportQueryKey(communityId),
      });
      void queryClient.invalidateQueries({
        queryKey: priceBookQueryKey(communityId),
      });
    },
  });
}

// ── Per-agent spend, from the local archive ─────────────────────────────────

/**
 * How long a priced usage window stays fresh.
 *
 * The archive is a local SQLite read, so this is cheap, but the answer is a
 * running total rather than a live feed: a figure a minute old is still the
 * figure to act on. Newly archived metrics invalidate it immediately through
 * `onAgentMetricsChanged`, so freshness does not depend on the interval.
 */
const USAGE_STALE_TIME_MS = 60_000;

export function agentUsageQueryKey(
  communityId: string,
  days: number,
  agentPubkey: string | null,
) {
  return [LEDGER_ROOT, communityId, "agent-usage", days, agentPubkey] as const;
}

/**
 * The locally archived usage series for a window.
 *
 * Bucket boundaries are rebuilt per fetch rather than held in the key, so a
 * window that spans midnight refreshes onto the new day instead of pinning
 * the boundaries it was first mounted with.
 */
export function useAgentUsageSeries(
  communityId: string,
  days: number,
  agentPubkey?: string,
) {
  const queryClient = useQueryClient();
  const key = agentUsageQueryKey(communityId, days, agentPubkey ?? null);

  // Archiving a batch of kind 44200 metrics changes this answer. Without
  // this the screen would keep serving the pre-turn figure until something
  // else happened to remount it.
  React.useEffect(
    () =>
      onAgentMetricsChanged(() => {
        void queryClient.invalidateQueries({
          queryKey: [LEDGER_ROOT, communityId, "agent-usage"],
        });
      }),
    [communityId, queryClient],
  );

  return useQuery<AgentUsageSeries>({
    queryKey: key,
    queryFn: () =>
      getAgentUsageSeries({
        bucketBoundaries: localMidnightBoundaries(days),
        ...(agentPubkey ? { agentPubkey } : {}),
      }),
    enabled: communityId.length > 0,
    staleTime: USAGE_STALE_TIME_MS,
  });
}

/** What `useAgentSpend` hands its callers. */
export interface AgentSpendResult {
  /**
   * The priced window, or `null` while it is still being worked out or when
   * it could not be read.
   *
   * `null` rather than an empty result on purpose. A screen that rendered a
   * pending or failed read as `$0.00` would be telling an owner their agents
   * cost nothing, which is the single most reassuring way to be wrong about
   * money.
   */
  spend: UsageSpend | null;
  isLoading: boolean;
  error: Error | null;
  /** False when kind 44200 archiving is off, so there is nothing to read. */
  collectionEnabled: boolean;
  /** True when the archive holds metrics for this agent outside the window. */
  hasArchivedEvidence: boolean | null;
}

/**
 * What agents cost over a window, in money.
 *
 * Joins the local usage archive to the published price book. Both have to
 * arrive: usage without prices is tokens, and prices without usage is a rate
 * card. Either one still loading leaves `spend` null rather than producing
 * a total that is missing half its inputs.
 */
export function useAgentSpend(
  communityId: string,
  days: number,
  agentPubkey?: string,
): AgentSpendResult {
  const usageQuery = useAgentUsageSeries(communityId, days, agentPubkey);
  const priceQuery = usePriceBook(communityId);

  const isLoading = usageQuery.isLoading || priceQuery.isLoading;
  const error =
    usageQuery.error instanceof Error
      ? usageQuery.error
      : priceQuery.error instanceof Error
        ? priceQuery.error
        : null;

  const series = usageQuery.data ?? null;
  const book = priceQuery.data ?? null;
  const ready = !isLoading && error === null && series !== null;

  const spend = React.useMemo(
    () =>
      ready
        ? priceUsageSeries(series, book, Math.floor(Date.now() / 1000))
        : null,
    [book, ready, series],
  );

  return {
    collectionEnabled: series?.collectionEnabled ?? true,
    error,
    hasArchivedEvidence: series?.hasArchivedEvidence ?? null,
    isLoading,
    spend,
  };
}
