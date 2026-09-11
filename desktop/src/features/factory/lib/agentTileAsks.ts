/**
 * Which of the owner's open asks belong to one agent tile.
 *
 * The asks feature already answers "what is still waiting on me"
 * (`useOpenAsks`). A tile only wants the slice of that list its own agent
 * raised, so the pane can show the block where the work is rather than
 * sending the owner to the Inbox to find it.
 *
 * Kept free of React so the ownership rule is testable under `node --test`.
 */

import { normalizePubkey } from "@/shared/lib/pubkey";

/** The identity fields an ask carries about who raised it. */
export type AskFiler = {
  filerPubkey: string;
  /**
   * Set only on a relay-signed promotion, carrying the ORIGINAL filer: on
   * those events `filerPubkey` is the relay, so ownership must read this
   * first or a promoted ask would belong to no tile at all.
   */
  originalFilerPubkey?: string | null;
};

/** Who an ask belongs to: the original filer when the relay promoted it. */
export function askFilerPubkey(ask: AskFiler): string {
  return normalizePubkey(ask.originalFilerPubkey ?? ask.filerPubkey);
}

/**
 * The asks in `asks` that `agentPubkey` raised, in the order given.
 *
 * `asks` is expected to be an already-open list (what `useOpenAsks` returns):
 * this filters by author only, and never revives a closed ask.
 */
export function openAsksForAgent<Ask extends AskFiler>(
  asks: readonly Ask[],
  agentPubkey: string,
): Ask[] {
  const wanted = normalizePubkey(agentPubkey);
  if (wanted === "") return [];
  return asks.filter((ask) => askFilerPubkey(ask) === wanted);
}

/**
 * The subset of `agentPubkeys` with at least one open ask, as a lookup set of
 * normalised pubkeys. Used by the toolbar count and the pane tab dots, which
 * both ask the same question of many agents at once.
 */
export function agentPubkeysWithOpenAsks(
  asks: readonly AskFiler[],
  agentPubkeys: readonly string[],
): Set<string> {
  const raisers = new Set(asks.map(askFilerPubkey));
  return new Set(
    agentPubkeys
      .map(normalizePubkey)
      .filter((pubkey) => pubkey !== "" && raisers.has(pubkey)),
  );
}
