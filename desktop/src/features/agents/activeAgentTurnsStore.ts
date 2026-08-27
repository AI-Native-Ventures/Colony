import * as React from "react";

import {
  subscribeAgentObserverStore,
  getAgentObserverSnapshot,
  compareObserverEvents,
} from "@/features/agents/observerRelayStore";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/shared/lib/useDocumentVisible";
import type { ObserverEvent } from "./ui/agentSessionTypes";
import {
  clearTurnDepartures,
  noteObserverFrame,
  recordTurnDeparture,
  resetAgentLivenessLedger,
  restoreAgentLivenessLedger,
  setObserverTransportOpen,
  snapshotAgentLivenessLedger,
} from "./agentLivenessLedger";
import type { LiveTurnSample } from "./agentLivenessState";
import {
  cloneActiveTurnsState,
  reviveActiveTurnsState,
  type ActiveTurnsCommunitySnapshot,
} from "./activeAgentTurnsCommunity";

/** Harness emits turn_liveness every ~10s (BUZZ_ACP_TURN_LIVENESS_SECS). */
const LIVENESS_INTERVAL_MS = 10_000;
/** Remove a turn after this long with no activity. Tolerates one fully dropped
 * liveness ping plus slack before pruning a turn whose host died without
 * unwinding (kill -9 / crash) — the only case that reaches this bound, since
 * graceful exits clear via turn_completed and working turns refresh on every
 * stream event. Derived from the interval so it tracks if the interval changes. */
export const REMOVE_AFTER_MS = LIVENESS_INTERVAL_MS * 2.5;
/** Pause pruning for an agent once ALL of its tracked turns have gone this long
 * without activity — the "all at once" signature of that agent's frame stream
 * being down. Set below REMOVE_AFTER_MS so the pause engages before the 25s
 * prune would wipe badges. */
const FRAME_GAP_PAUSE_MS = LIVENESS_INTERVAL_MS * 2;
/** A silent agent is treated as dead after this bounded prune pause. */
const PRUNE_PAUSE_MAX_MS = 3 * 60_000;
/** Maximum concurrent active turns tracked per agent. Purely an unbounded-growth
 * guard, so it sits at the harness's hard upper bound for parallel agent
 * subprocesses (`--agents` / `BUZZ_ACP_AGENTS` accepts `1..=32`) rather than the
 * Desktop default of 24 — any lower value silently evicts a live turn, dropping
 * its working badge. */
const MAX_TURNS_PER_AGENT = 32;
/** Cap on per-agent terminal tombstones (A's resurrection guard). For
 * terminals that carry the turn's channelId (turn_completed / turn_error),
 * the (agent, channel) watermark already gates any liveness emitted before
 * the terminal — both gate on the same channel key and within-channel order
 * is preserved end-to-end — so those tombstones only matter briefly. The
 * tombstones doing durable work are the ones whose creation the channel
 * watermark does NOT witness: null-channel terminals (agent_panic gates on
 * the null bucket) and desktop-initiated clears (`clearActiveTurnsForAgent`).
 * Those are always the newest entries, so evicting the oldest past a small
 * multiple of the live cap preserves them. Worst case for an evicted
 * tombstone (a >128-completions-late liveness beating a quiet channel's
 * watermark) is a ghost badge that the prune reaps within its normal bounds —
 * bounded cosmetic staleness, not state corruption. */
const MAX_TERMINAL_TOMBSTONES = MAX_TURNS_PER_AGENT * 4;
/** Interval for pruning stale/expired turns. */
const PRUNE_INTERVAL_MS = 5_000;
/** Output gap after which the next output frame is worth a notification.
 * Mirrors OUTPUT_QUIET_AFTER_MS in agentLivenessState, which is the threshold
 * the badge actually flips on; kept as a local literal so this store does not
 * take a runtime dependency on the presentation layer. */
const QUIET_EDGE_MS = 60_000;

/** One tracked live turn. Serialization shape shared with the community
 * snapshot sibling; see `activeAgentTurnsCommunity.ts`. */
export type ActiveTurn = {
  turnId: string;
  channelId: string;
  startedAt: number;
  /** Desktop clock: last frame of ANY kind, liveness pings included. The
   * prune's input, and deliberately unchanged. */
  lastActivityAt: number;
  /** Desktop clock: last frame that carried something the owner can read
   * (acp_read / acp_write), or null when the turn has produced none yet.
   *
   * Split out from lastActivityAt because merging them is exactly what made a
   * quietly-working agent indistinguishable from a working one: a liveness
   * ping refreshed the same field a real message did, so "has this agent said
   * anything in six minutes" had no answer anywhere in the store. */
  lastOutputAt: number | null;
};

/** One working channel surfaced to the UI, anchored to the desktop clock. */
export type ActiveTurnSummary = {
  channelId: string;
  anchorAt: number;
};

/** One channel with active agent work, aggregated across agents. */
export type ActiveChannelTurnSummary = {
  channelId: string;
  anchorAt: number;
  agentCount: number;
  agentPubkeys: string[];
  agentNames?: string[];
  /** Per-agent badge anchors (startedAt + that agent's clock offset), built in
   * the store in the same sorted pass as `agentPubkeys` so the two arrays are
   * index-aligned by construction. Optional only because the typing-fallback
   * producer (agentWorkingSignal's typing-only summaries) has no turn anchors
   * to offer; the observer store always populates it. Consumers must fall back
   * to `anchorAt` when it is missing or its length drifts from
   * `agentPubkeys`. */
  agentAnchorsAt?: number[];
};

// Module-level state: agentPubkey → turnId → ActiveTurn. `let` because the
// community restore swaps the maps wholesale (see below).
let activeTurnsByAgent = new Map<string, Map<string, ActiveTurn>>();
const listeners = new Set<() => void>();

// Per-agent clock offset: the desktop clock minus the agent-host clock, in
// milliseconds. Estimated as the running minimum of
// (Date.now() - Date.parse(event.timestamp)) across that agent's events. The
// minimum converges on true skew minus the smallest network/processing delay
// seen — a monotonically tightening estimate immune to per-event jitter. While
// true skew is constant or shrinking it is conservative: elapsed under-reports
// by the minimum delay and never inflates. The minimum never loosens, so under
// GROWING skew (an NTP step forward, or the host clock drifting further behind
// mid-session) the stored estimate goes stale-too-small and elapsed can over-
// report — bounded by how far the skew grows, sub-second over a session. A
// turn's badge anchor is startedAt + offset: the agent's own start, translated
// into desktop-clock terms. Anchors are derived at read time so a later, tighter
// offset retroactively corrects every live turn — distinct agent starts then
// yield distinct anchors (no lockstep) and a turn started long ago anchors into
// the past (large elapsed) instead of resetting to Date.now().
let clockOffsetByAgent = new Map<string, number>();

// Cached snapshots for useSyncExternalStore reference stability.
// Only regenerated when the underlying turn map for an agent actually changes.
const cachedTurnSummaries = new Map<string, ActiveTurnSummary[]>();
let cachedChannelTurnSummaries: ActiveChannelTurnSummary[] | null = null;

// Composite watermark per (agent, channel): the newest observer event
// processed for that channel, by (timestamp, seq) ordering. An event is
// processed only if it is strictly newer than its channel's watermark —
// making full-buffer replays idempotent and post-restart streams (seq resets
// to 1, timestamp keeps climbing) handled for free.
//
// Keyed per channel, not per agent, because the harness's batching packer
// preserves FIFO order only WITHIN a channel: frames for different channels
// may publish in an order that differs from arrival order. A per-agent
// watermark would silently skip a delayed channel's events as stale. This is
// safe because every turn-mutating path is channel-scoped by the event's own
// channelId (endTurn's fallback matches `turn.channelId`, resurrectTurn keys
// on `event.channelId`), so per-channel serialization gives each channel
// exactly the protection per-agent serialization gave the whole agent.
//
// Events with a null channelId (agent_panic-class) gate against a dedicated
// per-agent bucket: the harness treats null-channel events as packing
// barriers, so they never reorder against any channel's events.
//
// The other per-agent maps stay agent-keyed because they are reorder-safe:
// `clockOffsetByAgent` is a running MINIMUM (order-insensitive by
// construction), and `activeTurnsByAgent` / `terminalAtByAgent` are mutated
// only through channel-scoped paths this gate serializes (see the
// MAX_TERMINAL_TOMBSTONES doc for the tombstone-eviction analysis).
const NULL_CHANNEL_KEY = "\u0000null-channel";
let lastProcessed = new Map<string, Map<string, ObserverEvent>>();

function watermarkChannelKey(event: ObserverEvent): string {
  return event.channelId ?? NULL_CHANNEL_KEY;
}

// Per-agent record of when each turn terminally ended (turnId →
// terminal-event timestamp, in agent-host clock ms). endTurn hard-deletes a
// turn with no surviving record, so without this a late liveness frame for an
// already-completed turn would resurrect a dead badge. Resurrection (A) checks
// this: a turn is revived only if the recovered liveness is strictly newer
// than its recorded terminal timestamp.
let terminalAtByAgent = new Map<string, Map<string, number>>();

let pruneInterval: ReturnType<typeof setInterval> | null = null;
let unsubscribePruneVisibility: (() => void) | null = null;

function invalidateCache(agentKey: string) {
  cachedTurnSummaries.delete(agentKey);
  cachedChannelTurnSummaries = null;
}

// Monotonic revision of the turn map. Consumers that derive a value which
// changes with the wall clock (elapsed times, quiet-for windows) cannot use a
// cached array as a useSyncExternalStore snapshot, so they subscribe to this
// scalar instead and read the store during render.
let storeVersion = 0;

/** Current revision. Stable between notifications (useSyncExternalStore-safe). */
export function getActiveAgentTurnsVersion(): number {
  return storeVersion;
}

function notifyListeners() {
  storeVersion += 1;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Refine this agent's clock-offset estimate from one observer event. Samples
 * Date.now() - Date.parse(timestamp) and keeps the running minimum. When the
 * minimum tightens, every live anchor for the agent shifts, so the cache is
 * invalidated. Events with an unparseable timestamp contribute no sample.
 * Returns true when the offset changed.
 */
function sampleClockOffset(agentKey: string, timestamp: string): boolean {
  const sample = Date.now() - Date.parse(timestamp);
  if (Number.isNaN(sample)) return false;
  const prior = clockOffsetByAgent.get(agentKey);
  if (prior !== undefined && sample >= prior) return false;
  clockOffsetByAgent.set(agentKey, sample);
  invalidateCache(agentKey);
  return true;
}

function parseTimestamp(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function startTurn(
  agentPubkey: string,
  channelId: string,
  turnId: string,
  timestamp: string,
) {
  const key = normalizePubkey(agentPubkey);
  let agentTurns = activeTurnsByAgent.get(key);
  if (!agentTurns) {
    agentTurns = new Map();
    activeTurnsByAgent.set(key, agentTurns);
  }

  // Cap at MAX_TURNS_PER_AGENT — evict oldest if exceeded
  if (agentTurns.size >= MAX_TURNS_PER_AGENT && !agentTurns.has(turnId)) {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [tid, turn] of agentTurns) {
      if (turn.startedAt < oldestTime) {
        oldestTime = turn.startedAt;
        oldestKey = tid;
      }
    }
    if (oldestKey) {
      const evicted = agentTurns.get(oldestKey);
      agentTurns.delete(oldestKey);
      if (evicted) {
        recordTurnDeparture(key, {
          turnId: evicted.turnId,
          channelId: evicted.channelId,
          reason: "evicted",
          lastFrameAt: evicted.lastActivityAt,
          lastOutputAt: evicted.lastOutputAt,
          departedAt: Date.now(),
          terminalKind: null,
        });
      }
    }
  }

  const startedAt = parseTimestamp(timestamp) ?? Date.now();
  agentTurns.set(turnId, {
    turnId,
    channelId,
    startedAt,
    lastActivityAt: Date.now(),
    // A turn has produced nothing readable at the instant it starts. Seeding
    // this with "now" would make every turn look like it had just spoken.
    lastOutputAt: null,
  });
  invalidateCache(key);
}

/**
 * Refresh a live turn from one frame.
 *
 * `carriesOutput` separates a liveness ping from an ACP line the owner could
 * actually read. Both keep the turn alive for the prune; only the second
 * counts as the agent having said something.
 *
 * Returns true when a live turn was found and refreshed.
 */
function recordActivity(
  agentPubkey: string,
  turnId: string | null,
  carriesOutput: boolean,
): boolean {
  if (!turnId) return false;
  const key = normalizePubkey(agentPubkey);
  const agentTurns = activeTurnsByAgent.get(key);
  if (!agentTurns) return false;
  const turn = agentTurns.get(turnId);
  if (!turn) return false;

  const now = Date.now();
  turn.lastActivityAt = now;
  if (!carriesOutput) return true;

  // Output ends a quiet stretch. Publishing that transition is worth a
  // notification because it flips a visible badge; publishing every chunk of
  // a chatty turn is not, and the surfaces already re-read on their own clock
  // tick. So notify only on the edge.
  const wasQuiet =
    turn.lastOutputAt === null || now - turn.lastOutputAt > QUIET_EDGE_MS;
  turn.lastOutputAt = now;
  if (wasQuiet) {
    invalidateCache(key);
    notifyListeners();
  }
  return true;
}

/**
 * A — resurrect a badge that was pruned out from under a still-running turn.
 * A recovered liveness/acp frame for a turn no longer in the live map recreates
 * it, UNLESS C's tombstone shows the turn already terminally ended at or after
 * this frame's time (a stale frame must not revive a completed turn). The frame
 * may carry its original `startedAt` envelope field; when valid and not later
 * than the frame, preserve the elapsed timer by anchoring to that timestamp.
 * Old, malformed, or impossible future starts fall back to the recovery
 * timestamp. Returns true on revive.
 */
function resurrectTurn(agentPubkey: string, event: ObserverEvent): boolean {
  if (!event.turnId || !event.channelId) return false;
  const key = normalizePubkey(agentPubkey);
  const terminalAt = terminalAtByAgent.get(key)?.get(event.turnId);
  const frameAt = parseTimestamp(event.timestamp);
  // Only revive when this frame is strictly newer than the recorded terminal.
  if (terminalAt !== undefined && (frameAt === null || frameAt <= terminalAt)) {
    return false;
  }
  const startedAt =
    typeof event.startedAt === "string" &&
    parseTimestamp(event.startedAt) !== null
      ? event.startedAt
      : event.timestamp;
  const startedAtMs = parseTimestamp(startedAt);
  const safeStartedAt =
    frameAt !== null && startedAtMs !== null && startedAtMs <= frameAt
      ? startedAt
      : event.timestamp;
  startTurn(agentPubkey, event.channelId, event.turnId, safeStartedAt);
  return true;
}

function recordTerminal(agentKey: string, turnId: string, terminalAt: number) {
  if (!Number.isFinite(terminalAt)) return;
  let terminals = terminalAtByAgent.get(agentKey);
  if (!terminals) {
    terminals = new Map();
    terminalAtByAgent.set(agentKey, terminals);
  }
  terminals.set(turnId, terminalAt);
  // Bound the tombstone map: only recently-completed turns can be the target of
  // a racing late liveness frame (older ones are already below the watermark).
  // Evict the oldest terminal once past the cap so the map can't grow unbounded
  // across a long session. Insertion order tracks completion order closely
  // enough; the first key is the oldest survivor.
  if (terminals.size > MAX_TERMINAL_TOMBSTONES) {
    const oldest = terminals.keys().next().value;
    if (oldest !== undefined) terminals.delete(oldest);
  }
}

function endTurn(
  agentPubkey: string,
  turnId: string | null,
  channelId: string | null,
  terminalAt: number,
  terminalKind: string,
) {
  const key = normalizePubkey(agentPubkey);
  // Tombstone the terminal time so a late liveness frame can't resurrect a
  // completed turn (A's guard). With an explicit turnId this is recorded even
  // when the turn was already pruned and the agent's live map is gone — the
  // completion is authoritative and must outlive the active record.
  if (turnId) {
    recordTerminal(key, turnId, terminalAt);
  }

  const agentTurns = activeTurnsByAgent.get(key);
  if (!agentTurns) return;

  if (turnId) {
    const ended = agentTurns.get(turnId);
    agentTurns.delete(turnId);
    if (ended) {
      recordTurnDeparture(key, {
        turnId: ended.turnId,
        channelId: ended.channelId,
        reason: "ended",
        lastFrameAt: ended.lastActivityAt,
        lastOutputAt: ended.lastOutputAt,
        departedAt: Date.now(),
        terminalKind,
      });
    }
  } else if (channelId) {
    // Fallback: remove by channelId if turnId not available. Tombstone the
    // resolved turn so a later stale liveness for it can't resurrect a badge.
    for (const [tid, turn] of agentTurns) {
      if (turn.channelId === channelId) {
        agentTurns.delete(tid);
        recordTerminal(key, tid, terminalAt);
        recordTurnDeparture(key, {
          turnId: tid,
          channelId: turn.channelId,
          reason: "ended",
          lastFrameAt: turn.lastActivityAt,
          lastOutputAt: turn.lastOutputAt,
          departedAt: Date.now(),
          terminalKind,
        });
        break;
      }
    }
  }
  if (agentTurns.size === 0) {
    activeTurnsByAgent.delete(key);
  }
  invalidateCache(key);
}

/** True when every tracked turn for one agent is stale, but only until the
 * bounded backstop expires. Other agents' activity intentionally has no effect. */
function shouldPausePrune(
  agentTurns: Map<string, ActiveTurn>,
  now: number,
): boolean {
  let maxActivity = 0;
  for (const turn of agentTurns.values()) {
    if (turn.lastActivityAt > maxActivity) maxActivity = turn.lastActivityAt;
  }
  const silentFor = now - maxActivity;
  return (
    maxActivity > 0 &&
    silentFor > FRAME_GAP_PAUSE_MS &&
    silentFor < PRUNE_PAUSE_MAX_MS
  );
}

function pruneExpired() {
  const now = Date.now();
  let changed = false;
  for (const [agentKey, agentTurns] of activeTurnsByAgent) {
    // A single fresh tracked turn for this agent means a stale sibling is
    // genuinely dead and must still prune at 25s. Conversely, all of this
    // agent's turns going stale together identifies a per-agent frame-stream
    // gap, regardless of whether other agents keep reporting activity.
    if (shouldPausePrune(agentTurns, now)) continue;

    for (const [turnId, turn] of agentTurns) {
      if (now - turn.lastActivityAt > REMOVE_AFTER_MS) {
        agentTurns.delete(turnId);
        // The receipt the prune never wrote. Deleting the turn is correct --
        // it is not live any more -- but deleting it silently is what made a
        // stuck agent indistinguishable from a finished one, because after
        // this line there was no record anywhere that the agent had been
        // mid-turn when it fell quiet. Corroboration is classified now, at
        // departure, while the frame map still describes this moment.
        recordTurnDeparture(agentKey, {
          turnId: turn.turnId,
          channelId: turn.channelId,
          reason: "vanished",
          lastFrameAt: turn.lastActivityAt,
          lastOutputAt: turn.lastOutputAt,
          departedAt: now,
          terminalKind: null,
        });
        invalidateCache(agentKey);
        changed = true;
      }
    }
    if (agentTurns.size === 0) {
      activeTurnsByAgent.delete(agentKey);
    }
  }
  if (changed) {
    notifyListeners();
  }
}

// INVARIANT: events must be sorted by (timestamp, seq) ascending.
// syncAgentTurnsFromEvents receives sorted arrays from observerRelayStore.
// Calling with unsorted events will cause silent data loss.
function processEvent(agentPubkey: string, event: ObserverEvent) {
  const key = normalizePubkey(agentPubkey);

  // Gate every event kind on its (agent, channel) watermark uniformly:
  // process only events strictly newer than the last one seen for this
  // agent+channel. With sorted buffers (the documented invariant), this makes
  // full-buffer replays a complete no-op. Evictions must be gated too —
  // replaying a stale turn_error/agent_panic (emitted with a null turnId)
  // would otherwise fall back to deleting the first turn in the channel,
  // killing the live turn; the gate is per-channel, but so is that fallback
  // (it matches the event's own channelId), so each channel's stream is
  // serialized against exactly the mutations it can perform. Resurrection
  // (the turn_liveness/acp case below) is gated here too: it runs only for a
  // frame that passes its channel's watermark, so replayed stale frames
  // cannot revive a pruned turn, and the per-turn terminal tombstone blocks
  // reviving a turn that already completed.
  //
  // The per-agent map grows one entry per channel the agent has ever emitted
  // on — bounded by real channel membership. Deliberately NOT capped:
  // evicting a channel's watermark would reopen replay-processing for that
  // channel, and a re-run stale eviction is exactly the badge-killing hazard
  // this gate exists to prevent.
  const channelKey = watermarkChannelKey(event);
  let agentWatermarks = lastProcessed.get(key);
  const last = agentWatermarks?.get(channelKey);
  if (last && compareObserverEvents(event, last) <= 0) {
    return;
  }
  if (!agentWatermarks) {
    agentWatermarks = new Map();
    lastProcessed.set(key, agentWatermarks);
  }
  agentWatermarks.set(channelKey, event);

  // This event cleared its channel watermark, so it is genuinely new rather
  // than one of the full-buffer replays the observer store issues on every
  // notification. Only genuinely-new frames may count as evidence that the
  // stream is delivering; recording a replay here would make every stream
  // look permanently alive and corroboration would always read "confirmed".
  noteObserverFrame(key, Date.now());

  // Refine the clock offset from every fresh event. A tighter offset shifts
  // every live anchor for this agent, so a change must reach the UI even when
  // the event itself surfaces no new turn.
  const offsetChanged = sampleClockOffset(key, event.timestamp);

  switch (event.kind) {
    case "turn_started":
      if (event.channelId) {
        // A fresh turn retires every prior "it went quiet" record: an agent
        // that is demonstrably working again must not keep rendering a stall
        // it already recovered from.
        clearTurnDepartures(key);
        startTurn(
          agentPubkey,
          event.channelId,
          event.turnId ?? `seq-${event.seq}`,
          event.timestamp,
        );
        notifyListeners();
        return;
      }
      break;
    case "turn_completed":
    case "turn_error":
    case "agent_panic":
      endTurn(
        agentPubkey,
        event.turnId ?? null,
        event.channelId ?? null,
        Date.parse(event.timestamp),
        event.kind,
      );
      notifyListeners();
      return;
    case "acp_read":
    case "acp_write":
    // turn_liveness keeps a quiet-but-alive turn from being pruned; same
    // refresh-only path as stream activity — no surfaced summary change on its
    // own, so it only notifies when the offset above actually moved. If the
    // turn was pruned out from under a still-running host (a transient drop
    // raced the pause, or the lone-crash residual self-healed), resurrect it.
    case "turn_liveness": {
      const refreshed = recordActivity(
        agentPubkey,
        event.turnId ?? null,
        // acp_read / acp_write carry the raw ACP line -- tool calls, message
        // chunks, plans. turn_liveness carries an empty payload and proves
        // only that the turn task has not been dropped.
        event.kind !== "turn_liveness",
      );
      if (!refreshed && resurrectTurn(agentPubkey, event)) {
        notifyListeners();
        return;
      }
      break;
    }
  }

  if (offsetChanged) {
    notifyListeners();
  }
}

function startPruneInterval() {
  if (pruneInterval || !isDocumentVisible()) return;
  pruneExpired();
  pruneInterval = setInterval(pruneExpired, PRUNE_INTERVAL_MS);
}

function pausePruneInterval() {
  if (!pruneInterval) return;
  clearInterval(pruneInterval);
  pruneInterval = null;
}

function ensurePruneInterval() {
  if (unsubscribePruneVisibility) return;
  startPruneInterval();
  unsubscribePruneVisibility = subscribeDocumentVisibility((visible) => {
    if (visible) startPruneInterval();
    else pausePruneInterval();
  });
}

function stopPruneInterval() {
  pausePruneInterval();
  unsubscribePruneVisibility?.();
  unsubscribePruneVisibility = null;
}

export function subscribeActiveAgentTurns(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    ensurePruneInterval();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPruneInterval();
    }
  };
}

/**
 * Returns the channels where the given agent has active turns, sorted by
 * channelId, each anchored to the earliest `anchorAt` for that channel.
 * The array reference is cached and stable until the turn map mutates — a
 * requirement for `useSyncExternalStore`.
 */
export function getActiveTurnsForAgent(
  agentPubkey: string | null | undefined,
): ActiveTurnSummary[] {
  if (!agentPubkey) return EMPTY_TURNS;
  const key = normalizePubkey(agentPubkey);
  const agentTurns = activeTurnsByAgent.get(key);
  if (!agentTurns || agentTurns.size === 0) return EMPTY_TURNS;

  const cached = cachedTurnSummaries.get(key);
  if (cached) return cached;

  const offset = clockOffsetByAgent.get(key) ?? 0;

  // Collapse multiple turns in one channel to the earliest start — the badge
  // should count from when the channel's oldest live turn began. Anchors are
  // derived here (startedAt + offset) so the latest skew estimate applies.
  const earliestByChannel = new Map<string, number>();
  for (const turn of agentTurns.values()) {
    const prior = earliestByChannel.get(turn.channelId);
    if (prior === undefined || turn.startedAt < prior) {
      earliestByChannel.set(turn.channelId, turn.startedAt);
    }
  }

  const result = [...earliestByChannel.entries()]
    .map(([channelId, startedAt]) => ({
      channelId,
      anchorAt: startedAt + offset,
    }))
    .sort((a, b) => a.channelId.localeCompare(b.channelId));
  cachedTurnSummaries.set(key, result);
  return result;
}

const EMPTY_TURNS: ActiveTurnSummary[] = [];
const EMPTY_CHANNEL_TURNS: ActiveChannelTurnSummary[] = [];

/**
 * Returns active working channels across all tracked agents, sorted by
 * channelId and anchored to the earliest live turn in each channel. Each
 * summary also carries `agentAnchorsAt` — per-agent earliest anchors,
 * index-aligned with `agentPubkeys` (both derived from one sorted pass, so
 * they cannot drift apart).
 */
export function getActiveTurnsByChannel(): ActiveChannelTurnSummary[] {
  if (cachedChannelTurnSummaries) return cachedChannelTurnSummaries;
  if (activeTurnsByAgent.size === 0) return EMPTY_CHANNEL_TURNS;

  const summaries = new Map<
    string,
    { anchorAt: number; earliestAnchorByAgent: Map<string, number> }
  >();

  for (const [agentKey, agentTurns] of activeTurnsByAgent) {
    if (agentTurns.size === 0) continue;
    const offset = clockOffsetByAgent.get(agentKey) ?? 0;

    for (const turn of agentTurns.values()) {
      const anchorAt = turn.startedAt + offset;
      const summary = summaries.get(turn.channelId);
      if (!summary) {
        summaries.set(turn.channelId, {
          anchorAt,
          earliestAnchorByAgent: new Map([[agentKey, anchorAt]]),
        });
        continue;
      }

      const priorAnchor = summary.earliestAnchorByAgent.get(agentKey);
      if (priorAnchor === undefined || anchorAt < priorAnchor) {
        summary.earliestAnchorByAgent.set(agentKey, anchorAt);
      }
      if (anchorAt < summary.anchorAt) {
        summary.anchorAt = anchorAt;
      }
    }
  }

  const result = [...summaries.entries()]
    .map(([channelId, summary]) => {
      // One sorted pass derives both arrays — alignment is structural.
      const sortedAgents = [...summary.earliestAnchorByAgent.entries()].sort(
        ([a], [b]) => a.localeCompare(b),
      );
      return {
        channelId,
        anchorAt: summary.anchorAt,
        agentCount: sortedAgents.length,
        agentPubkeys: sortedAgents.map(([pubkey]) => pubkey),
        agentAnchorsAt: sortedAgents.map(([, anchorAt]) => anchorAt),
      };
    })
    .sort((a, b) => a.channelId.localeCompare(b.channelId));
  cachedChannelTurnSummaries = result;
  return result;
}

/**
 * This agent's desktop-clock offset: add it to an agent-host timestamp to get
 * a desktop-clock one. Zero when no sample has landed yet, which is the same
 * conservative default the summary readers use.
 */
export function getAgentClockOffset(
  agentPubkey: string | null | undefined,
): number {
  if (!agentPubkey) return 0;
  return clockOffsetByAgent.get(normalizePubkey(agentPubkey)) ?? 0;
}

const EMPTY_SAMPLES: LiveTurnSample[] = [];

/**
 * Per-turn liveness detail for one agent, on the desktop clock.
 *
 * Deliberately NOT cached and deliberately NOT a useSyncExternalStore
 * snapshot. `lastOutputAt` changes without a notification (see
 * recordActivity: only the quiet edge notifies), so a cached array would go
 * stale and a fresh array on every read would make useSyncExternalStore
 * loop. Callers subscribe to `getActiveAgentTurnsVersion` for structural
 * changes and call this during render, on their own clock tick.
 *
 * One sample per TURN, not per channel: the channel-collapsing that
 * `getActiveTurnsForAgent` does is right for a badge anchor and wrong here,
 * because two turns in one channel can have very different output histories.
 */
export function getLiveTurnSamplesForAgent(
  agentPubkey: string | null | undefined,
): LiveTurnSample[] {
  if (!agentPubkey) return EMPTY_SAMPLES;
  const key = normalizePubkey(agentPubkey);
  const agentTurns = activeTurnsByAgent.get(key);
  if (!agentTurns || agentTurns.size === 0) return EMPTY_SAMPLES;
  const offset = clockOffsetByAgent.get(key) ?? 0;
  return [...agentTurns.values()].map((turn) => ({
    channelId: turn.channelId,
    anchorAt: turn.startedAt + offset,
    lastFrameAt: turn.lastActivityAt,
    lastOutputAt: turn.lastOutputAt,
  }));
}

/**
 * Synchronize the active-turns store with the latest observer events for a
 * given agent.
 */
export function syncAgentTurnsFromEvents(
  agentPubkey: string,
  events: ObserverEvent[],
) {
  for (const event of events) {
    processEvent(agentPubkey, event);
  }
}

/**
 * Hook: returns the channels where the given agent is currently working, each
 * with the desktop-clock `anchorAt` to anchor a live elapsed counter.
 * Re-renders when the set of channels changes — not when the clock ticks.
 */
export function useActiveAgentTurns(
  agentPubkey: string | null | undefined,
): ActiveTurnSummary[] {
  const getSnapshot = React.useCallback(
    () => getActiveTurnsForAgent(agentPubkey),
    [agentPubkey],
  );

  return React.useSyncExternalStore(subscribeActiveAgentTurns, getSnapshot);
}

/**
 * Hook: returns channels with active agent work across all tracked agents.
 * Re-renders when the channel set changes — not when the clock ticks.
 */
export function useActiveAgentTurnsByChannel(): ActiveChannelTurnSummary[] {
  return React.useSyncExternalStore(
    subscribeActiveAgentTurns,
    getActiveTurnsByChannel,
  );
}

/**
 * Sync every running/deployed agent's observer events into the active-turns
 * store. Extracted from the bridge hook so a regression can drive the exact
 * observer→derived-liveness path without a React renderer.
 */
export function syncActiveAgentTurnsFromObserver(
  agents: readonly { pubkey: string; status: string }[],
) {
  for (const agent of agents) {
    if (agent.status !== "running" && agent.status !== "deployed") continue;
    const snapshot = getAgentObserverSnapshot(agent.pubkey, true);
    // Module-level in the observer store, so every agent's snapshot reports
    // the same value; reading it here avoids a second import path for one
    // boolean. "open" means the observer subscription is established, which
    // is the only transport fact available: frames can still stop arriving
    // over an open socket, which is exactly why it is one input to the
    // corroboration rule rather than the whole of it.
    setObserverTransportOpen(snapshot.connectionState === "open");
    syncAgentTurnsFromEvents(agent.pubkey, snapshot.events);
  }
}

/**
 * Bridge hook: processes observer events into the active-turns store.
 * Should be called by a parent component that has access to the observer events.
 */
export function useActiveAgentTurnsBridge(
  agents: readonly { pubkey: string; status: string }[],
) {
  React.useEffect(() => {
    function syncAll() {
      syncActiveAgentTurnsFromObserver(agents);
    }

    syncAll();
    return subscribeAgentObserverStore(syncAll);
  }, [agents]);
}

/**
 * Immediately clear all active turns for a specific agent — called when
 * Desktop itself stops or restarts the agent, so the turn store doesn't
 * have to wait for the 3-minute prune-pause backstop.
 *
 * Preserves `lastProcessed` (the watermark) so a full-buffer replay after
 * the clear is still a no-op — without the watermark a replayed
 * `turn_started` would immediately resurrect the badge.  Preserves
 * `clockOffsetByAgent` — the offset remains valid and harmless.
 *
 * Tombstones every cleared turn (C) so an in-flight `turn_liveness` frame
 * already on the wire at kill time cannot resurrect the badge via
 * `resurrectTurn`.  A restarted agent's genuinely new turns carry new
 * turnIds / newer timestamps, so the tombstones don't block them.
 */
export function clearActiveTurnsForAgent(agentPubkey: string): void {
  const key = normalizePubkey(agentPubkey);
  const agentTurns = activeTurnsByAgent.get(key);
  if (!agentTurns || agentTurns.size === 0) return;

  const agentClockNow = Date.now() - (clockOffsetByAgent.get(key) ?? 0);
  const departedAt = Date.now();
  for (const [turnId, turn] of agentTurns) {
    recordTerminal(key, turnId, agentClockNow);
    recordTurnDeparture(key, {
      turnId,
      channelId: turn.channelId,
      reason: "cleared",
      lastFrameAt: turn.lastActivityAt,
      lastOutputAt: turn.lastOutputAt,
      departedAt,
      terminalKind: null,
    });
  }

  activeTurnsByAgent.delete(key);
  invalidateCache(key);
  notifyListeners();
}

/**
 * Clears all live turn state (active turns, offsets, watermarks, tombstones).
 * Intentionally preserves `savedByCommunity` — community-switch snapshots
 * must survive the reset that runs between save and restore.
 */
export function resetActiveAgentTurnsStore() {
  // The ledger is a strict satellite of this store, so it resets on the same
  // boundary rather than needing its own entry in resetCommunityState.
  resetAgentLivenessLedger();
  activeTurnsByAgent.clear();
  lastProcessed.clear();
  clockOffsetByAgent.clear();
  cachedTurnSummaries.clear();
  cachedChannelTurnSummaries = null;
  terminalAtByAgent.clear();
  notifyListeners();
}

// ---------------------------------------------------------------------------
// Community-switch save / restore
// ---------------------------------------------------------------------------

/** Per-community snapshots. Keyed by community ID. */
const savedByCommunity = new Map<string, ActiveTurnsCommunitySnapshot>();

/**
 * Snapshot the current active-turns state under `communityId` so it can be
 * restored when the user switches back.  If both the turns map and the
 * tombstone map are empty there is nothing worth restoring — discard any
 * previously-saved snapshot instead.  Serialization lives in
 * `activeAgentTurnsCommunity.ts`.
 */
export function saveActiveAgentTurnsForCommunity(communityId: string): void {
  if (activeTurnsByAgent.size === 0 && terminalAtByAgent.size === 0) {
    savedByCommunity.delete(communityId);
    return;
  }

  savedByCommunity.set(
    communityId,
    cloneActiveTurnsState(
      {
        turns: activeTurnsByAgent,
        offsets: clockOffsetByAgent,
        watermarks: lastProcessed,
        terminals: terminalAtByAgent,
      },
      snapshotAgentLivenessLedger(),
    ),
  );
}

/**
 * Restore a previously saved active-turns snapshot for `communityId` into the
 * module maps.  No-op when no snapshot exists.  Replaces rather than merging
 * (see `reviveActiveTurnsState` for the map rebuilding and the
 * `lastActivityAt` refresh that keeps restored turns past the prune bound).
 *
 * Consumes the snapshot (deletes it from `savedByCommunity`) — a given
 * community's snapshot is only usable once per round-trip.
 */
export function restoreActiveAgentTurnsForCommunity(communityId: string): void {
  const snap = savedByCommunity.get(communityId);
  if (!snap) return;
  savedByCommunity.delete(communityId);

  const revived = reviveActiveTurnsState(snap, Date.now());

  // Replace, not merge: swap the module maps wholesale rather than writing
  // into whatever the caller left behind.
  activeTurnsByAgent = revived.turns;
  clockOffsetByAgent = revived.offsets;
  lastProcessed = revived.watermarks;
  terminalAtByAgent = revived.terminals;

  restoreAgentLivenessLedger(snap.ledger);

  cachedTurnSummaries.clear();
  cachedChannelTurnSummaries = null;
  notifyListeners();
}

/**
 * Discard the saved turn-state snapshot for a community that has been
 * permanently deleted so the entry doesn't sit in memory indefinitely.
 * Call this alongside the other relay-specific GC in `removeCommunity`.
 */
export function clearSavedCommunitySnapshot(communityId: string): void {
  savedByCommunity.delete(communityId);
}
