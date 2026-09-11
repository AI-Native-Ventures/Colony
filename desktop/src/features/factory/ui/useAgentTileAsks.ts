import * as React from "react";

import {
  agentPubkeysWithOpenAsks,
  openAsksForAgent,
} from "@/features/factory/lib/agentTileAsks";
import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { useOpenAsks } from "@/features/asks/useOpenAsks";

/**
 * The open asks one tile's agent raised.
 *
 * `useOpenAsks` is a React Query read keyed by community and owner, so every
 * caller here (each tile, each pane's tab strip, the toolbar count) shares one
 * network read rather than polling the relay per tile.
 */
export function useAgentOpenAsks(agentPubkey: string): OpenAsk[] {
  const { asks } = useOpenAsks();
  return React.useMemo(
    () => openAsksForAgent(asks, agentPubkey),
    [asks, agentPubkey],
  );
}

/** Which of `agentPubkeys` are blocked on the owner, as normalised pubkeys. */
export function useAgentsWithOpenAsks(
  agentPubkeys: readonly string[],
): Set<string> {
  const { asks } = useOpenAsks();
  // A joined key keeps the memo stable while the tiles are: callers build the
  // pubkey list from tabs, which is a fresh array on every render.
  const agentKey = agentPubkeys.join(",");
  return React.useMemo(
    () => agentPubkeysWithOpenAsks(asks, agentKey.split(",")),
    [asks, agentKey],
  );
}
