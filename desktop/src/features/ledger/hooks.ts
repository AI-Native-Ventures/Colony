import { useQuery } from "@tanstack/react-query";

import type { Budget, CorrectionBook, PriceBook, Rulebook } from "./contracts";
import {
  loadBudgets,
  loadCorrectionBook,
  loadPriceBook,
  loadRulebook,
} from "./ledgerRepository";

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
