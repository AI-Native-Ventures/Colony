import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * How a turn left the live map in `activeAgentTurnsStore`.
 *
 * The live map is deliberately lossy: the prune deletes a turn whose frames
 * stopped, and once it is gone there is nothing left to tell the owner that
 * an agent was mid-turn when it fell silent. That is the structural reason a
 * stuck agent reads as a finished one. This ledger is the receipt the prune
 * never wrote: one record per departed turn, saying which way it left and
 * what the world looked like at that moment.
 *
 * It records; it never decides. Turning a departure into an owner-facing
 * verdict is `agentLivenessState.ts`'s job, because the verdict also depends
 * on presence and process lifecycle, which this module has no business
 * knowing about.
 */
export type TurnDepartureReason =
  /** A terminal frame ended it: turn_completed, turn_error, agent_panic. */
  | "ended"
  /** The prune removed it. Frames stopped and no terminal frame ever came. */
  | "vanished"
  /** Desktop stopped or restarted the agent, so we cleared it ourselves. */
  | "cleared"
  /** Evicted by the per-agent live-turn cap because newer turns arrived. */
  | "evicted";

/**
 * Whether the observer frame stream was demonstrably still delivering while
 * this agent went quiet. The whole point is to keep a stream outage from
 * being reported as a stalled agent.
 *
 * - `confirmed`: some OTHER agent's frame landed after this agent's last one,
 *   so frames were reaching Colony while this one produced none.
 * - `none`: nothing arrived from anyone. A single-agent community always
 *   lands here, and it is genuinely ambiguous, so it must not read as a stall
 *   on its own.
 * - `transport-down`: the observer subscription was not open. Nothing about
 *   the agent can be concluded at all.
 */
export type StreamCorroboration = "confirmed" | "none" | "transport-down";

export type TurnDeparture = {
  turnId: string;
  channelId: string;
  reason: TurnDepartureReason;
  /** Desktop clock: last frame of any kind seen for this turn. */
  lastFrameAt: number;
  /** Desktop clock: last frame that carried visible output, or null. */
  lastOutputAt: number | null;
  /** Desktop clock: when the departure was recorded. */
  departedAt: number;
  /** Observer frame kind for a terminal departure, else null. */
  terminalKind: string | null;
  corroboration: StreamCorroboration;
};

/**
 * Records kept per agent. Small on purpose: the state machine only ever reads
 * the most recent one, and the rest exist so a surface can say "this has
 * happened before" without holding a session's worth of history.
 */
const MAX_DEPARTURES_PER_AGENT = 8;

const departuresByAgent = new Map<string, TurnDeparture[]>();

/** Desktop clock of the newest genuinely-new frame seen per agent. */
const lastFrameAtByAgent = new Map<string, number>();

/**
 * Observer transport state, mirrored in rather than imported, so this module
 * has no dependency on the relay store and stays trivially testable.
 * `activeAgentTurnsStore` pushes it on every sync.
 */
let transportOpen = false;

const listeners = new Set<() => void>();

// Monotonic revision, so consumers have a stable useSyncExternalStore
// snapshot without this module having to cache derived arrays.
let ledgerVersion = 0;

/** Current revision. Stable between notifications. */
export function getAgentLivenessLedgerVersion(): number {
  return ledgerVersion;
}

function notify() {
  ledgerVersion += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe to departure/frame bookkeeping changes (useSyncExternalStore). */
export function subscribeAgentLivenessLedger(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Report whether the observer subscription is currently open. */
export function setObserverTransportOpen(open: boolean) {
  if (transportOpen === open) return;
  transportOpen = open;
  notify();
}

export function isObserverTransportOpen(): boolean {
  return transportOpen;
}

/**
 * Record that a genuinely new frame arrived for one agent.
 *
 * "Genuinely new" is the caller's responsibility and it matters: the observer
 * store replays its whole buffer on every notification, so recording a
 * replayed frame here would make every stream look permanently alive and
 * corroboration would always read `confirmed`. `activeAgentTurnsStore` calls
 * this only after an event clears its watermark.
 */
export function noteObserverFrame(
  agentPubkey: string,
  at: number = Date.now(),
) {
  const key = normalizePubkey(agentPubkey);
  const prior = lastFrameAtByAgent.get(key);
  if (prior !== undefined && prior >= at) return;
  lastFrameAtByAgent.set(key, at);
}

/** Desktop clock of the newest frame from any agent other than `agentPubkey`. */
export function lastFrameAtOtherAgents(agentPubkey: string): number | null {
  const key = normalizePubkey(agentPubkey);
  let newest: number | null = null;
  for (const [otherKey, at] of lastFrameAtByAgent) {
    if (otherKey === key) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

/**
 * Classify the stream at the moment an agent's turn departed.
 *
 * `silentSince` is that turn's last frame. A frame from any other agent after
 * that instant proves frames were still flowing, which is the only evidence
 * that separates "this agent stopped" from "everything stopped".
 */
export function classifyCorroboration(
  agentPubkey: string,
  silentSince: number,
): StreamCorroboration {
  if (!transportOpen) return "transport-down";
  const other = lastFrameAtOtherAgents(agentPubkey);
  return other !== null && other > silentSince ? "confirmed" : "none";
}

/**
 * Record one departed turn.
 *
 * Callers pass the reason they know to be true rather than a timestamp
 * comparison this module would have to guess from. `corroboration` is
 * captured here, at departure time, and never recomputed: half an hour later
 * the frame map has moved on and would answer a different question.
 */
export function recordTurnDeparture(
  agentPubkey: string,
  departure: Omit<TurnDeparture, "corroboration"> & {
    corroboration?: StreamCorroboration;
  },
) {
  const key = normalizePubkey(agentPubkey);
  const record: TurnDeparture = {
    ...departure,
    corroboration:
      departure.corroboration ??
      classifyCorroboration(agentPubkey, departure.lastFrameAt),
  };

  let records = departuresByAgent.get(key);
  if (!records) {
    records = [];
    departuresByAgent.set(key, records);
  }
  records.push(record);
  if (records.length > MAX_DEPARTURES_PER_AGENT) {
    records.splice(0, records.length - MAX_DEPARTURES_PER_AGENT);
  }
  notify();
}

/**
 * The most recent departure for one agent, or null.
 *
 * "Most recent" is by `departedAt`, not array order, because a terminal frame
 * for an already-pruned turn can be recorded after the prune's own record for
 * a different turn.
 */
export function getLastTurnDeparture(
  agentPubkey: string | null | undefined,
): TurnDeparture | null {
  if (!agentPubkey) return null;
  const records = departuresByAgent.get(normalizePubkey(agentPubkey));
  if (!records || records.length === 0) return null;
  let newest = records[0];
  for (const record of records) {
    if (record.departedAt >= newest.departedAt) newest = record;
  }
  return newest;
}

/** Every recorded departure for one agent, oldest first. */
export function getTurnDepartures(
  agentPubkey: string | null | undefined,
): readonly TurnDeparture[] {
  if (!agentPubkey) return EMPTY_DEPARTURES;
  return (
    departuresByAgent.get(normalizePubkey(agentPubkey)) ?? EMPTY_DEPARTURES
  );
}

const EMPTY_DEPARTURES: readonly TurnDeparture[] = [];

/**
 * Forget an agent's departures because it started working again.
 *
 * Called when a turn starts: a fresh turn makes every prior "it went quiet"
 * record stale evidence, and leaving it in place would let an agent that is
 * demonstrably working keep rendering a stall it already recovered from.
 */
export function clearTurnDepartures(agentPubkey: string) {
  const key = normalizePubkey(agentPubkey);
  if (!departuresByAgent.has(key)) return;
  departuresByAgent.delete(key);
  notify();
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export type LivenessLedgerSnapshot = {
  departures: Map<string, TurnDeparture[]>;
  frames: Map<string, number>;
};

/**
 * Snapshot for the community round trip. Taken alongside the turn store's own
 * snapshot so that switching away and back does not erase the evidence that
 * an agent stalled, which would silently downgrade "Not responding" to
 * "Idle" -- exactly the lie this whole module exists to stop telling.
 */
export function snapshotAgentLivenessLedger(): LivenessLedgerSnapshot {
  const departures = new Map<string, TurnDeparture[]>();
  for (const [key, records] of departuresByAgent) {
    departures.set(
      key,
      records.map((record) => ({ ...record })),
    );
  }
  return { departures, frames: new Map(lastFrameAtByAgent) };
}

/** Replace ledger contents from a snapshot. */
export function restoreAgentLivenessLedger(snapshot: LivenessLedgerSnapshot) {
  departuresByAgent.clear();
  lastFrameAtByAgent.clear();
  for (const [key, records] of snapshot.departures) {
    departuresByAgent.set(
      key,
      records.map((record) => ({ ...record })),
    );
  }
  for (const [key, at] of snapshot.frames) {
    lastFrameAtByAgent.set(key, at);
  }
  notify();
}

/** Community-switch reset, driven by `resetActiveAgentTurnsStore`. */
export function resetAgentLivenessLedger() {
  departuresByAgent.clear();
  lastFrameAtByAgent.clear();
  transportOpen = false;
  notify();
}
