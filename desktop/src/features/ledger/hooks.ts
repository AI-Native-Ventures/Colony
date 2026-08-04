import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
export function useLedgerReport(communityId: string) {
  return useQuery<LedgerReport>({
    queryKey: ledgerReportQueryKey(communityId),
    queryFn: loadLedgerReport,
    enabled: communityId.length > 0,
    staleTime: 60_000,
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
