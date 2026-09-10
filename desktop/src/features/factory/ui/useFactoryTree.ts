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

  const [explicitState, setExplicitState] =
    React.useState<TileTreeState | null>(null);

  const baseState = React.useMemo(() => {
    const parsed = parseTileTree(factoryTab.payload);
    return parsed ?? createInitialTree("factory-root");
  }, [factoryTab.payload]);

  const reconciled = React.useMemo(() => {
    const workspaceIds = workspace.tabs.map((t) => t.id);
    return reconcileTree(baseState, workspaceIds, factoryTab.id);
  }, [baseState, workspace.tabs, factoryTab.id]);

  // When the payload changes externally (e.g. from a commit), drop any
  // explicit override so we stay in sync.
  React.useEffect(() => {
    setExplicitState(null);
  }, [factoryTab.payload]);

  const state = explicitState ?? reconciled;

  const commit = React.useCallback(
    (next: TileTreeState) => {
      updateTabPayload(channelId, factoryTab.id, serializeTileTree(next));
      setExplicitState(next);
    },
    [channelId, factoryTab.id],
  );

  return { state, commit };
}
