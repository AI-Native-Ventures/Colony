import type { DecisionLog } from "./decisionLog";

/**
 * What has actually been decided under each delegation grant.
 *
 * A grant's `cap_nano_usd` is checked one decision at a time and the relay
 * never looks at what came before it (NIP-IQ, kind 30189: "The check is per
 * decision only -- the relay does not sum amounts already logged under the
 * same grant, so a series of individually-under-cap decisions can still add up
 * to far more than the cap over time"). So a running total exists nowhere on
 * the relay. It is derived here, from the decision logs themselves, because it
 * is the only number that tells an owner what a per-decision ceiling has cost
 * them so far.
 *
 * This is a read of the record, not a control. Nothing here refuses anything;
 * the owner's lever is revocation.
 *
 * Money stays `bigint` for the reason the ledger states
 * (`features/ledger/contracts.ts`): 2^53 nanoUSD is about $9,007, a figure a
 * real company passes, and a JS number would round a total away in silence.
 */

export type GrantSpend = {
  /** Every declared `amount_nano_usd` under this grant, summed, in nanoUSD. */
  totalNanoUsd: bigint;
  /**
   * Every decision citing this grant, including any that declared no amount.
   * A capped grant forces an amount on every decision, so the two agree
   * there; an uncapped grant can carry decisions that moved no money.
   */
  decisionCount: number;
};

/** Nothing decided yet. Frozen so callers can share one identity. */
export const NO_GRANT_SPEND: GrantSpend = Object.freeze({
  totalNanoUsd: 0n,
  decisionCount: 0,
});

/** Grant ids compare case-insensitively, exactly as `filterDecisionLogs` does. */
function grantKey(grantId: string): string {
  return grantId.trim().toLowerCase();
}

/**
 * One decision's money as `bigint`. `amountNanoUsd` arrives as a JSON number
 * the parser has already proven to be a non-negative integer, so the widening
 * is exact; only the summing could lose anything, and in `bigint` it does not.
 */
function amountOf(log: DecisionLog): bigint {
  return log.amountNanoUsd === null ? 0n : BigInt(log.amountNanoUsd);
}

/**
 * Total and count per grant id, keyed lowercased. Decisions citing a grant
 * that was later revoked still count: the record stays, and dropping it would
 * understate what the delegation cost while it was live.
 */
export function grantSpendTotals(
  logs: readonly DecisionLog[],
): Map<string, GrantSpend> {
  const totals = new Map<string, GrantSpend>();
  for (const log of logs) {
    const key = grantKey(log.grantId);
    if (key === "") continue;
    const running = totals.get(key) ?? NO_GRANT_SPEND;
    totals.set(key, {
      totalNanoUsd: running.totalNanoUsd + amountOf(log),
      decisionCount: running.decisionCount + 1,
    });
  }
  return totals;
}

/** One grant's running total, or a zeroed reading when it has no decisions. */
export function grantSpendFor(
  totals: ReadonlyMap<string, GrantSpend>,
  grantId: string,
): GrantSpend {
  return totals.get(grantKey(grantId)) ?? NO_GRANT_SPEND;
}

/**
 * The amounts in one already-selected list of decisions, summed. For a view
 * that has filtered the log itself and wants the total of what it is showing.
 */
export function decidedTotalNanoUsd(logs: readonly DecisionLog[]): bigint {
  let total = 0n;
  for (const log of logs) total += amountOf(log);
  return total;
}
