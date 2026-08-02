import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { newestHead } from "@/features/company/contracts";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_ATTRIBUTION_RULEBOOK,
  KIND_CORRECTION_BOOK,
  KIND_LEDGER_BUDGET,
  KIND_PRICE_BOOK,
} from "@/shared/constants/kinds";

import type { Budget, CorrectionBook, PriceBook, Rulebook } from "./contracts";
import {
  CORRECTION_BOOK_D_TAG,
  parseBudget,
  parseCorrectionBook,
  parsePriceBook,
  parseRulebook,
  PRICE_BOOK_D_TAG,
  RULEBOOK_D_TAG,
} from "./contracts";

/**
 * Reading a community's cost ledger books.
 *
 * Every query names its kinds and pins `authors` to the tenant relay signer,
 * because a book is only canonical if that key wrote it. Nothing is cached to
 * disk: this is what a company spends, and it outliving a community switch is
 * a leak rather than a performance win.
 *
 * Usage records are deliberately absent. They are NIP-44 ciphertext addressed
 * to the owner, so decrypting them needs the owner's secret key, which the
 * renderer does not hold. Computing a report belongs in the Tauri backend
 * against `buzz_core::ledger`, not here; putting a second engine in TypeScript
 * would let the two disagree about what a company spent.
 */

const MAX_BUDGETS = 500;

/**
 * Bumped whenever community-scoped state must be abandoned.
 *
 * A response that was in flight across a community switch belongs to the old
 * relay, and showing the old company's spend under the new one is exactly the
 * leak `resetCommunityState` exists to prevent.
 */
let generation = 0;

/** Abandon in-flight reads and any derived state. */
export function resetLedgerRepositoryState(): void {
  generation += 1;
}

function currentGeneration(): number {
  return generation;
}

function isStale(startedAt: number): boolean {
  return startedAt !== generation;
}

async function fetchHead(
  kind: number,
  dTag: string,
  relayPubkey: string,
): Promise<RelayEvent | null> {
  const events = await relayClient.fetchEvents({
    kinds: [kind],
    authors: [relayPubkey],
    "#d": [dTag],
    limit: 1,
  });
  return newestHead(events) ?? null;
}

/**
 * The current price book, or `null` when none has been published.
 *
 * `null` genuinely means "no prices yet", which is why an unpriced model is a
 * reviewable exception rather than a zero.
 */
export async function loadPriceBook(): Promise<PriceBook | null> {
  const startedAt = currentGeneration();
  const relayPubkey = await getRelaySelf();
  if (!relayPubkey || isStale(startedAt)) return null;

  const event = await fetchHead(KIND_PRICE_BOOK, PRICE_BOOK_D_TAG, relayPubkey);
  if (!event || isStale(startedAt)) return null;
  return parsePriceBook(event, relayPubkey);
}

/** The current attribution rulebook, or `null` when none has been published. */
export async function loadRulebook(): Promise<Rulebook | null> {
  const startedAt = currentGeneration();
  const relayPubkey = await getRelaySelf();
  if (!relayPubkey || isStale(startedAt)) return null;

  const event = await fetchHead(
    KIND_ATTRIBUTION_RULEBOOK,
    RULEBOOK_D_TAG,
    relayPubkey,
  );
  if (!event || isStale(startedAt)) return null;
  return parseRulebook(event, relayPubkey);
}

/** The current correction book, or `null` when none has been published. */
export async function loadCorrectionBook(): Promise<CorrectionBook | null> {
  const startedAt = currentGeneration();
  const relayPubkey = await getRelaySelf();
  if (!relayPubkey || isStale(startedAt)) return null;

  const event = await fetchHead(
    KIND_CORRECTION_BOOK,
    CORRECTION_BOOK_D_TAG,
    relayPubkey,
  );
  if (!event || isStale(startedAt)) return null;
  return parseCorrectionBook(event, relayPubkey);
}

/**
 * Every budget the relay currently holds.
 *
 * A budget that fails to parse is skipped rather than failing the whole read:
 * one malformed head should not hide every other cost centre's limit. The
 * count of skipped heads is returned so a caller can say so instead of
 * silently showing fewer budgets than exist.
 */
export async function loadBudgets(): Promise<{
  budgets: Budget[];
  unreadable: number;
}> {
  const startedAt = currentGeneration();
  const relayPubkey = await getRelaySelf();
  if (!relayPubkey || isStale(startedAt)) return { budgets: [], unreadable: 0 };

  const events = await relayClient.fetchEvents({
    kinds: [KIND_LEDGER_BUDGET],
    authors: [relayPubkey],
    limit: MAX_BUDGETS,
  });
  if (isStale(startedAt)) return { budgets: [], unreadable: 0 };

  const budgets: Budget[] = [];
  let unreadable = 0;
  for (const event of events) {
    try {
      budgets.push(parseBudget(event, relayPubkey));
    } catch {
      unreadable += 1;
    }
  }
  return { budgets, unreadable };
}
