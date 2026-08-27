import * as React from "react";

import type { PresenceStatus } from "@/shared/api/types";
import { useNow } from "@/shared/lib/useNow";
import {
  getActiveAgentTurnsVersion,
  getAgentClockOffset,
  getLiveTurnSamplesForAgent,
  subscribeActiveAgentTurns,
} from "./activeAgentTurnsStore";
import {
  getAgentLivenessLedgerVersion,
  getLastTurnDeparture,
  subscribeAgentLivenessLedger,
} from "./agentLivenessLedger";
import {
  deriveAgentLivenessState,
  type AgentLivenessState,
  type AgentProcessState,
  type InFlightTool,
} from "./agentLivenessState";
import {
  getAgentTranscript,
  subscribeAgentObserverStore,
} from "./observerRelayStore";

/**
 * How often a mounted liveness surface re-reads the clock.
 *
 * Thirty seconds, matching `AskDeadlineNote`, and for the same reason: this
 * copy is minute-granular, so a faster tick would buy nothing but renders.
 * The one place seconds appear is an actively-working badge, and that owns
 * its own faster tick down at the leaf.
 *
 * `useNow` pauses entirely while the document is hidden and each consumer
 * owns exactly one interval, so a screen full of agent rows costs one
 * interval per visible row and none in the background.
 */
export const LIVENESS_TICK_MS = 30_000;

export type UseAgentLivenessOptions = {
  /** Process lifecycle, when the caller has it. Defaults to `unknown`. */
  process?: AgentProcessState;
  presence?: PresenceStatus;
  presenceLoaded?: boolean;
  /**
   * Scope live turns to one channel. Without it, work in any channel counts,
   * which is the all-channels rule the agent list and profile surfaces use.
   */
  channelId?: string | null;
};

/**
 * Find the tool call the agent is still inside.
 *
 * The transcript already holds this. The harness publishes every ACP line
 * verbatim inside `acp_read` frames, so a `tool_call` with no terminal
 * `tool_call_update` is a fact sitting in the store rather than something
 * that needs inventing. Scanning from the end finds the most recent one,
 * which is the one the owner is waiting on.
 *
 * Returns null when nothing is executing. That is what keeps this from
 * becoming a fabricated progress indicator: no running tool means no claim
 * about a running tool.
 */
function findInFlightTool(
  agentPubkey: string | null | undefined,
  channelId: string | null | undefined,
  clockOffset: number,
): InFlightTool | null {
  if (!agentPubkey) return null;
  const items = getAgentTranscript(agentPubkey);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "tool") continue;
    if (channelId && item.channelId && item.channelId !== channelId) continue;
    if (item.status !== "executing" || item.completedAt !== null) continue;
    const startedAt = Date.parse(item.startedAt || item.timestamp);
    if (!Number.isFinite(startedAt)) return null;
    const action = item.descriptor.action;
    return {
      // Same phrasing the transcript row uses ("Edited pricing.tsx"), so the
      // badge and the activity list name the step identically.
      title: action
        ? `${action.verb} ${action.object ?? ""}`.trim()
        : item.title,
      startedAt: startedAt + clockOffset,
    };
  }
  return null;
}

function sameState(a: AgentLivenessState, b: AgentLivenessState): boolean {
  return (
    a.phase === b.phase &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.sinceAt === b.sinceAt &&
    a.sinceKind === b.sinceKind &&
    a.tone === b.tone &&
    a.needsAttention === b.needsAttention &&
    a.channels.length === b.channels.length &&
    a.channels.every((channel, index) => channel === b.channels[index])
  );
}

/**
 * The agent's current state, refreshed on its own clock.
 *
 * Subscribes to version scalars rather than derived arrays. `lastOutputAt`
 * moves without a notification on purpose (only the quiet edge notifies, so a
 * chatty turn does not publish once per chunk), which means a cached snapshot
 * would go stale and a freshly-built one would make `useSyncExternalStore`
 * loop. So the stores are read during render and the result is passed through
 * a content-equality cache, which gives downstream `React.memo` boundaries a
 * stable reference on every render that did not actually change anything.
 */
export function useAgentLiveness(
  agentPubkey: string | null | undefined,
  options: UseAgentLivenessOptions = {},
): AgentLivenessState {
  const {
    process = "unknown",
    presence,
    presenceLoaded = presence !== undefined,
    channelId = null,
  } = options;

  // Read purely for their side effect of subscribing this component to the
  // three stores that can change the answer. The values themselves are not
  // inputs; the reads below are.
  React.useSyncExternalStore(
    subscribeActiveAgentTurns,
    getActiveAgentTurnsVersion,
  );
  React.useSyncExternalStore(
    subscribeAgentLivenessLedger,
    getAgentLivenessLedgerVersion,
  );
  React.useSyncExternalStore(
    subscribeAgentObserverStore,
    () => getAgentTranscript(agentPubkey).length,
  );
  const now = useNow(LIVENESS_TICK_MS);

  const samples = getLiveTurnSamplesForAgent(agentPubkey);
  const next = deriveAgentLivenessState({
    liveTurns: channelId
      ? samples.filter((sample) => sample.channelId === channelId)
      : samples,
    lastDeparture: getLastTurnDeparture(agentPubkey),
    inFlightTool: findInFlightTool(
      agentPubkey,
      channelId,
      getAgentClockOffset(agentPubkey),
    ),
    presence,
    presenceLoaded,
    process,
    now,
  });

  const previous = React.useRef(next);
  if (previous.current !== next && !sameState(previous.current, next)) {
    previous.current = next;
  }
  return previous.current;
}
