//! The observer→active-turns bridge: the effect that feeds observer frames
//! into the turn store, and the listener it installs.
//!
//! Split out of `activeAgentTurnsStore.ts` so that file stays under the
//! desktop file-size ratchet. The store owns the state; this file owns the
//! wiring to the observer store.

import * as React from "react";

import {
  getAgentObserverSnapshot,
  subscribeAgentObserverStore,
  type AgentObserverStoreUpdate,
} from "@/features/agents/observerRelayStore";
import { setObserverTransportOpen } from "./agentLivenessLedger";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { syncAgentTurnsFromEvents } from "./activeAgentTurnsStore";

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
 * Build the steady-state observer listener once per agent-list revision. Observer
 * publications carry only newly admitted events for one agent, so this callback
 * does not revisit unrelated agents or their retained journals.
 */
export function createActiveAgentTurnsObserverListener(
  agents: readonly { pubkey: string; status: string }[],
): (update?: AgentObserverStoreUpdate) => void {
  const activeAgentPubkeys = new Set(
    agents
      .filter(
        (agent) => agent.status === "running" || agent.status === "deployed",
      )
      .map((agent) => normalizePubkey(agent.pubkey)),
  );

  return (update?: AgentObserverStoreUpdate) => {
    if (
      !update ||
      !activeAgentPubkeys.has(normalizePubkey(update.agentPubkey))
    ) {
      return;
    }
    syncAgentTurnsFromEvents(update.agentPubkey, [...update.events]);
  };
}

export function useActiveAgentTurnsBridge(
  agents: readonly { pubkey: string; status: string }[],
) {
  React.useEffect(() => {
    syncActiveAgentTurnsFromObserver(agents);
    return subscribeAgentObserverStore(
      createActiveAgentTurnsObserverListener(agents),
    );
  }, [agents]);
}
