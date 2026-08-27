import type { ObserverEvent } from "./ui/agentSessionTypes";
import type { LivenessLedgerSnapshot } from "./agentLivenessLedger";
import type { ActiveTurn } from "./activeAgentTurnsStore";

/**
 * Community-switch snapshot serialization for `activeAgentTurnsStore`.
 *
 * The store keeps the live turn maps; this module knows how to freeze them
 * into a self-contained snapshot and thaw one back. Split out so the store
 * file holds turn bookkeeping and this holds only the round-trip shape.
 */

export type ActiveTurnsCommunitySnapshot = {
  turns: Map<string, Map<string, ActiveTurn>>;
  offsets: Map<string, number>;
  watermarks: Map<string, Map<string, ObserverEvent>>;
  terminals: Map<string, Map<string, number>>;
  /** Departure records. Carried across the round trip because losing them
   * would silently downgrade "Not responding" back to "Idle" -- the exact
   * lie the ledger exists to stop telling -- for anyone who switched
   * community and switched back. */
  ledger: LivenessLedgerSnapshot;
};

/** The live maps the store freezes from, or thaws into. */
export type ActiveTurnsCommunityState = {
  turns: Map<string, Map<string, ActiveTurn>>;
  offsets: Map<string, number>;
  watermarks: Map<string, Map<string, ObserverEvent>>;
  terminals: Map<string, Map<string, number>>;
};

/**
 * Deep-clone the store's live maps into a self-contained snapshot so
 * subsequent mutations on the live maps do not corrupt it.
 */
export function cloneActiveTurnsState(
  state: ActiveTurnsCommunityState,
  ledger: LivenessLedgerSnapshot,
): ActiveTurnsCommunitySnapshot {
  // Outer map + inner per-agent maps + turn objects (plain structs, no
  // nested references beyond primitives).
  const turns = new Map<string, Map<string, ActiveTurn>>();
  for (const [agentKey, agentTurns] of state.turns) {
    const clonedAgent = new Map<string, ActiveTurn>();
    for (const [turnId, turn] of agentTurns) {
      clonedAgent.set(turnId, { ...turn });
    }
    turns.set(agentKey, clonedAgent);
  }

  // Shallow-clone the offsets map (primitives as values).
  const offsets = new Map(state.offsets);

  // Outer map + inner per-agent maps (ObserverEvent values are treated as
  // immutable).
  const watermarks = new Map<string, Map<string, ObserverEvent>>();
  for (const [agentKey, channelMarks] of state.watermarks) {
    watermarks.set(agentKey, new Map(channelMarks));
  }

  // Outer map + inner per-agent maps.
  const terminals = new Map<string, Map<string, number>>();
  for (const [agentKey, tombstones] of state.terminals) {
    terminals.set(agentKey, new Map(tombstones));
  }

  return { turns, offsets, watermarks, terminals, ledger };
}

/**
 * Build fresh live maps from a snapshot.
 *
 * `lastActivityAt` is refreshed so the prune does not immediately kill a
 * turn saved more than REMOVE_AFTER_MS ago; `lastOutputAt` is NOT, because
 * it records when the agent last said something and a community switch
 * did not make it say anything.
 */
export function reviveActiveTurnsState(
  snapshot: ActiveTurnsCommunitySnapshot,
  now: number,
): ActiveTurnsCommunityState {
  const turns = new Map<string, Map<string, ActiveTurn>>();
  for (const [agentKey, agentTurns] of snapshot.turns) {
    const restored = new Map<string, ActiveTurn>();
    for (const [turnId, turn] of agentTurns) {
      restored.set(turnId, { ...turn, lastActivityAt: now });
    }
    turns.set(agentKey, restored);
  }

  const offsets = new Map(snapshot.offsets);

  const watermarks = new Map<string, Map<string, ObserverEvent>>();
  for (const [agentKey, channelMarks] of snapshot.watermarks) {
    watermarks.set(agentKey, new Map(channelMarks));
  }

  const terminals = new Map<string, Map<string, number>>();
  for (const [agentKey, tombstones] of snapshot.terminals) {
    terminals.set(agentKey, new Map(tombstones));
  }

  return { turns, offsets, watermarks, terminals };
}
