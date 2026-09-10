import * as React from "react";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";
import { reconcileTree } from "../lib/reconcileTree";
import {
  parseTileTree,
  createInitialTree,
  serializeTileTree,
  type TileTreeState,
} from "../lib/tileTree";
import {
  useWorkspace,
  updateTabPayload,
} from "@/features/workspace/lib/workspaceTabs";

export function useFactoryTree(
  channelId: string,
  factoryTab: WorkspaceTab,
): {
  state: TileTreeState;
  commit: (next: TileTreeState) => void;
} {
  const workspace = useWorkspace(channelId);

  // The tree we last wrote, tagged with the payload we wrote it as. It wins
  // over the parsed payload only while that payload is still the current one,
  // so a change from anywhere else takes over without an effect to clear it.
  const [committed, setCommitted] = React.useState<{
    payload: unknown;
    state: TileTreeState;
  } | null>(null);

  const baseState = React.useMemo(() => {
    const parsed = parseTileTree(factoryTab.payload);
    return parsed ?? createInitialTree("factory-root");
  }, [factoryTab.payload]);

  const reconciled = React.useMemo(() => {
    const workspaceIds = workspace.tabs.map((t) => t.id);
    return reconcileTree(baseState, workspaceIds, factoryTab.id);
  }, [baseState, workspace.tabs, factoryTab.id]);

  const state =
    committed !== null && committed.payload === factoryTab.payload
      ? committed.state
      : reconciled;

  // Reconciliation is what adopts a newly opened workspace tab into a pane, so
  // it has to reach the payload: the workspace shell reads `ownedTabIds` from
  // there to keep an owned tab out of the top strip. `reconcileTree` returns
  // its input unchanged when there is nothing to adopt or drop, so this
  // settles after one write.
  React.useEffect(() => {
    if (reconciled === baseState) return;
    updateTabPayload(channelId, factoryTab.id, serializeTileTree(reconciled));
  }, [reconciled, baseState, channelId, factoryTab.id]);

  const commit = React.useCallback(
    (next: TileTreeState) => {
      const payload = serializeTileTree(next);
      updateTabPayload(channelId, factoryTab.id, payload);
      setCommitted({ payload, state: next });
    },
    [channelId, factoryTab.id],
  );

  return { state, commit };
}
