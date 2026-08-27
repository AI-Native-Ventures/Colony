import type { PresenceStatus } from "@/shared/api/types";
import type { TurnDeparture } from "./agentLivenessLedger";

/**
 * The honest answer to "what is this agent doing right now".
 *
 * The badge this replaces had two settings: Working, or the process status.
 * Both lie in the same direction. An agent running one long tool call emits
 * liveness pings but nothing readable for minutes at a time, and the old
 * badge dropped to the process status, so a working agent read as a finished
 * one. An agent whose telemetry stopped entirely kept reporting `ready`,
 * because `ready` describes a subprocess and not the work, so a dead agent
 * read as a healthy one.
 *
 * Every phase below is derived from turn liveness, never from process
 * lifecycle alone, and every phase that is not actively producing output
 * carries the time since it last did. "Last active 40 minutes ago" is the
 * whole product here.
 */
export type AgentLivenessPhase =
  /** Output is arriving right now. */
  | "working"
  /**
   * Liveness pings are arriving, readable output is not. In practice this is
   * one long tool call: a build, a test run, a wide search. The harness
   * publishes every ACP line it reads, so a gap here is a real gap in what
   * the agent is saying rather than a hole in the telemetry.
   */
  | "working-quietly"
  /** Had a turn, frames stopped, nothing terminal, and the stream was proven up. */
  | "stalled"
  /** Had a turn, frames stopped, and the agent's own presence went cold. */
  | "went-offline"
  /** Something is silent and Colony genuinely cannot say what. Never "fine". */
  | "cannot-tell"
  /** No turn in flight and no unresolved silence. */
  | "idle"
  | "waking"
  | "needs-setup"
  | "unavailable";

export type AgentLivenessTone = "active" | "quiet" | "warning" | "neutral";

/** How the `sinceAt` anchor should be read aloud. */
export type AgentLivenessSinceKind = "working-for" | "last-active" | null;

export type AgentLivenessState = {
  phase: AgentLivenessPhase;
  /** Short badge label, sentence case, no jargon. */
  label: string;
  /** One sentence for the owner, or null when the label says it all. */
  detail: string | null;
  /** Desktop-clock anchor for a live elapsed counter, or null. */
  sinceAt: number | null;
  sinceKind: AgentLivenessSinceKind;
  /** Channel ids with work in flight. Empty unless working or working quietly. */
  channels: readonly string[];
  tone: AgentLivenessTone;
  /** True when the owner should look at this agent. */
  needsAttention: boolean;
};

/** One live turn as the turn store knows it, translated to the desktop clock. */
export type LiveTurnSample = {
  channelId: string;
  /** Turn start, desktop clock. */
  anchorAt: number;
  /** Last frame of any kind, desktop clock. */
  lastFrameAt: number;
  /** Last frame carrying visible output, desktop clock, or null. */
  lastOutputAt: number | null;
};

/**
 * The tool call the agent is still inside, when there is one.
 *
 * This is what turns "Working quietly" from an admission into an answer. The
 * harness already publishes `tool_call` and `tool_call_update` verbatim
 * inside `acp_read` frames, so a tool that started and has not reported a
 * terminal status is a fact the desktop already holds. Naming it costs
 * nothing and is the difference between "no idea" and "running the tests".
 */
export type InFlightTool = {
  /** Human-facing title, as the transcript already renders it. */
  title: string;
  /** Desktop clock when the tool call started. */
  startedAt: number;
};

/**
 * Process lifecycle, flattened from `ManagedAgentRuntimeStatus`. `unknown`
 * covers an agent Colony does not run locally: a remote deployment, or one
 * whose runtime row has not arrived. It must not be read as "not running".
 */
export type AgentProcessState =
  | "unknown"
  | "needs-setup"
  | "waking"
  | "ready"
  | "stopped"
  | "failed";

export type AgentLivenessInput = {
  liveTurns: readonly LiveTurnSample[];
  lastDeparture: TurnDeparture | null;
  inFlightTool: InFlightTool | null;
  presence: PresenceStatus | undefined;
  presenceLoaded: boolean;
  process: AgentProcessState;
  now: number;
};

/**
 * Output silence that turns "Working" into "Working quietly".
 *
 * A minute, because that is roughly the point at which a person watching a
 * frozen transcript starts to wonder whether it died. Below it, ordinary
 * think-then-speak gaps would flicker the badge for no reason.
 */
export const OUTPUT_QUIET_AFTER_MS = 60_000;

/**
 * Frame silence after which a still-tracked turn stops being reportable as
 * working at all.
 *
 * Must equal `REMOVE_AFTER_MS` in `activeAgentTurnsStore` (asserted by
 * `agentLivenessState.test.mjs`). Below it the turn store considers the turn
 * live; above it the store is either pruning the turn or holding it under
 * the bounded frame-gap pause, and in both cases the honest answer is that
 * nothing is arriving. This is the window that must render as "cannot tell"
 * and never as "stalled": the pause exists precisely because an all-at-once
 * silence is the signature of a broken frame stream, not a dead agent.
 */
export const FRAME_STALE_AFTER_MS = 25_000;

const NO_CHANNELS: readonly string[] = [];

function idleState(
  label: string,
  sinceAt: number | null,
  detail: string | null = null,
): AgentLivenessState {
  return {
    phase: "idle",
    label,
    detail,
    sinceAt,
    sinceKind: sinceAt === null ? null : "last-active",
    channels: NO_CHANNELS,
    tone: "neutral",
    needsAttention: false,
  };
}

/**
 * Newest activity across an agent's live turns.
 *
 * Deliberately a maximum rather than a per-turn verdict: an agent with three
 * turns, two quiet and one producing output, is working. Reporting the
 * quietest turn would flag a demonstrably busy agent.
 */
function newestActivity(turns: readonly LiveTurnSample[]): {
  lastFrameAt: number;
  lastOutputAt: number | null;
  earliestAnchorAt: number;
} {
  let lastFrameAt = Number.NEGATIVE_INFINITY;
  let lastOutputAt: number | null = null;
  let earliestAnchorAt = Number.POSITIVE_INFINITY;
  for (const turn of turns) {
    if (turn.lastFrameAt > lastFrameAt) lastFrameAt = turn.lastFrameAt;
    if (
      turn.lastOutputAt !== null &&
      (lastOutputAt === null || turn.lastOutputAt > lastOutputAt)
    ) {
      lastOutputAt = turn.lastOutputAt;
    }
    if (turn.anchorAt < earliestAnchorAt) earliestAnchorAt = turn.anchorAt;
  }
  return { lastFrameAt, lastOutputAt, earliestAnchorAt };
}

function channelsOf(turns: readonly LiveTurnSample[]): readonly string[] {
  if (turns.length === 0) return NO_CHANNELS;
  return [...new Set(turns.map((turn) => turn.channelId))].sort();
}

/**
 * Derive the agent's state.
 *
 * Order matters and is deliberate:
 *
 * 1. A device that cannot run this agent trumps everything, because nothing
 *    else is even possible until the owner fixes it.
 * 2. A live turn is answered from the turn's own frames. Process lifecycle is
 *    not consulted at all here, which is the entire correction: `ready` is a
 *    statement about a subprocess, not about whether work is happening.
 * 3. Only with no live turn does process lifecycle get to speak, and even
 *    then a stopped or failed process outranks an unresolved silence. A crash
 *    already renders honestly elsewhere through `turn_error` / `agent_panic`
 *    and must not be relabelled a stall.
 */
export function deriveAgentLivenessState(
  input: AgentLivenessInput,
): AgentLivenessState {
  const {
    liveTurns,
    lastDeparture,
    inFlightTool,
    presence,
    presenceLoaded,
    process,
    now,
  } = input;

  if (process === "needs-setup") {
    return {
      phase: "needs-setup",
      label: "Needs setup on this device",
      detail: "Set this agent up on this device to start it.",
      sinceAt: null,
      sinceKind: null,
      channels: NO_CHANNELS,
      tone: "warning",
      needsAttention: true,
    };
  }

  if (liveTurns.length > 0) {
    return liveTurnState(liveTurns, inFlightTool, now);
  }

  if (process === "stopped") {
    return {
      phase: "unavailable",
      label: "Stopped",
      detail: "Stopped by you.",
      sinceAt: null,
      sinceKind: null,
      channels: NO_CHANNELS,
      tone: "neutral",
      needsAttention: false,
    };
  }

  if (process === "failed") {
    return {
      phase: "unavailable",
      label: "Unavailable",
      detail: "This agent could not connect.",
      sinceAt: null,
      sinceKind: null,
      channels: NO_CHANNELS,
      tone: "warning",
      needsAttention: true,
    };
  }

  if (lastDeparture !== null) {
    const departed = departureState(
      lastDeparture,
      presence,
      presenceLoaded,
      process,
    );
    if (departed !== null) return departed;
  }

  if (process === "waking") {
    return {
      phase: "waking",
      label: "Starting up",
      detail: null,
      sinceAt: null,
      sinceKind: null,
      channels: NO_CHANNELS,
      tone: "quiet",
      needsAttention: false,
    };
  }

  return idleState(
    process === "unknown" ? "Idle" : "Ready",
    lastDeparture?.departedAt ?? null,
  );
}

function liveTurnState(
  liveTurns: readonly LiveTurnSample[],
  inFlightTool: InFlightTool | null,
  now: number,
): AgentLivenessState {
  const { lastFrameAt, lastOutputAt, earliestAnchorAt } =
    newestActivity(liveTurns);
  const channels = channelsOf(liveTurns);

  // Frames have stopped while the turn store still holds the turn. That is
  // the bounded pause window, and the store's own reasoning is that an
  // all-at-once silence looks like a broken frame stream. Saying "stalled"
  // here would convict a healthy agent of a transport fault.
  if (now - lastFrameAt > FRAME_STALE_AFTER_MS) {
    return {
      phase: "cannot-tell",
      label: "No signal",
      detail: "Colony has stopped receiving updates from this agent.",
      sinceAt: lastOutputAt ?? lastFrameAt,
      sinceKind: "last-active",
      channels,
      tone: "warning",
      needsAttention: true,
    };
  }

  // Frames are arriving. The only question left is whether any of them
  // carried something the owner can see.
  const quietSince = lastOutputAt ?? earliestAnchorAt;
  if (now - quietSince > OUTPUT_QUIET_AFTER_MS) {
    return {
      phase: "working-quietly",
      label: "Working quietly",
      detail:
        inFlightTool === null
          ? "Still running. It has not had anything to report for a while."
          : `Still running: ${inFlightTool.title}.`,
      // Anchor to the tool's own start when there is one. That is the number
      // the owner actually wants: how long this step has been going, not how
      // long since some earlier line of chat.
      sinceAt: inFlightTool?.startedAt ?? quietSince,
      sinceKind: "last-active",
      channels,
      tone: "quiet",
      needsAttention: false,
    };
  }

  return {
    phase: "working",
    label: "Working",
    detail: null,
    sinceAt: earliestAnchorAt,
    sinceKind: "working-for",
    channels,
    tone: "active",
    needsAttention: false,
  };
}

/**
 * Turn a departed turn into a verdict, or null to let process lifecycle
 * answer instead.
 *
 * `ended`, `cleared` and `evicted` all mean the silence is explained, so they
 * return null and the caller falls through to Idle or Starting up. Only
 * `vanished` (frames stopped, nothing terminal ever came) is an unexplained
 * silence, and even then the verdict depends on independent evidence rather
 * than on the absence itself.
 */
function departureState(
  departure: TurnDeparture,
  presence: PresenceStatus | undefined,
  presenceLoaded: boolean,
  process: AgentProcessState,
): AgentLivenessState | null {
  if (departure.reason !== "vanished") return null;

  const sinceAt = departure.lastOutputAt ?? departure.lastFrameAt;

  // Presence rides the agent's own relay socket on a schedule the harness's
  // main loop owns, which makes it independent evidence rather than a second
  // reading of the same telemetry. A cold presence says the process or its
  // connection is gone; that is a different fact from a wedged turn loop and
  // deserves different words.
  if (presenceLoaded && presence === "offline") {
    return {
      phase: "went-offline",
      label: "Went offline",
      detail: "This agent disconnected while it was still working.",
      sinceAt,
      sinceKind: "last-active",
      channels: NO_CHANNELS,
      tone: "warning",
      needsAttention: true,
    };
  }

  if (departure.corroboration === "transport-down") {
    return cannotTellDeparture(sinceAt);
  }

  // Two independent ways to know the silence belongs to this agent alone:
  // another agent's frames kept arriving, or this agent's own presence
  // heartbeat kept arriving while its telemetry did not.
  const isolatedToThisAgent =
    departure.corroboration === "confirmed" ||
    (presenceLoaded && presence === "online");

  if (!isolatedToThisAgent) {
    return cannotTellDeparture(sinceAt);
  }

  return {
    phase: "stalled",
    label: "Not responding",
    detail:
      process === "unknown"
        ? "This agent stopped reporting in the middle of a task."
        : "This agent is still running but stopped reporting in the middle of a task.",
    sinceAt,
    sinceKind: "last-active",
    channels: NO_CHANNELS,
    tone: "warning",
    needsAttention: true,
  };
}

function cannotTellDeparture(sinceAt: number): AgentLivenessState {
  return {
    phase: "cannot-tell",
    label: "No signal",
    detail:
      "Colony stopped receiving updates from this agent and cannot tell whether it is still working.",
    sinceAt,
    sinceKind: "last-active",
    channels: NO_CHANNELS,
    tone: "warning",
    needsAttention: true,
  };
}

/**
 * Coarse "how long ago" copy. Deliberately never shows seconds: the
 * underlying signals are a 10 second liveness ping and a 3 minute presence
 * TTL, so a ticking seconds display would promise a precision Colony does not
 * have.
 */
export function formatLastActive(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The whole status in one string, for surfaces with a single line to spend.
 * Returns the label alone when there is no anchor worth reading out.
 */
export function describeAgentLiveness(
  state: AgentLivenessState,
  now: number,
): string {
  if (state.sinceAt === null || state.sinceKind === null) return state.label;
  if (state.sinceKind === "working-for") return state.label;
  return `${state.label} · last active ${formatLastActive(now - state.sinceAt)}`;
}
