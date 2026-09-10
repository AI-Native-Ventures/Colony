import * as React from "react";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import type { TabKindDefinition, TabKindContext } from "@/features/workspace/lib/tabKindRegistry";
import {
  parseTileTree,
  createInitialTree,
  serializeTileTree,
  insertPaneAtEdge,
  findPaneById,
  findPanePath,
  moveTabToPane,
  getNodeAtPath,
  replacePane,
  type TileLayoutNode,
} from "@/features/factory/lib/tileTree";
import { useFactoryTree } from "@/features/factory/ui/useFactoryTree";
import { FactoryCanvas } from "@/features/factory/ui/FactoryCanvas";
import { FactoryToolbar } from "@/features/factory/ui/FactoryToolbar";
import {
  isProjectChannel,
} from "@/features/factory/lib/projectChannel";
import { getTabKind } from "@/features/workspace/lib/tabKindRegistry";
import {
  useWorkspace,
  closeTab,
} from "@/features/workspace/lib/workspaceTabs";


export const factoryKindDefinition: TabKindDefinition = {
  kind: "factory",
  label: "Factory",
  createTitle: () => "Factory",
  createPayload: () => {
    const paneId = `factory-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    const initialState = createInitialTree(paneId);
    return serializeTileTree(initialState);
  },
  canCreateFromNewTabPage: true,
  isAvailable: (context: TabKindContext) =>
    isProjectChannel(context.projects, context.channelId),
  ownedTabIds: (tab) => {
    const parsed = parseTileTree(tab.payload);
    if (!parsed) return [];
    const ids: string[] = [];
    function collect(node: TileLayoutNode): void {
      if (node.kind === "pane") {
        ids.push(...node.tabIds);
      } else {
        for (const child of node.children) collect(child);
      }
    }
    collect(parsed.root);
    return ids;
  },
};

export function FactoryBody({
  channelId,
  tab,
}: TabBodyProps): React.JSX.Element {
  const { state, commit } = useFactoryTree(channelId, tab);
  const workspace = useWorkspace(channelId);

  // Handle pane focus.
  const handlePaneFocus = React.useCallback(
    (paneId: string) => {
      const updated = { ...state, focusedPaneId: paneId };
      commit(updated);
    },
    [state, commit],
  );

  // Handle split actions.
  const handlePaneSplitRight = React.useCallback(
    (paneId: string) => {
      const newPaneId = `pane-${Math.random().toString(36).slice(2)}`;
      const result = insertPaneAtEdge(state, paneId, "right", newPaneId, null);
      if (result) {
        commit({
          ...state,
          root: result.root,
          sizesByGroupId: result.sizesByGroupId,
        });
      }
    },
    [state, commit],
  );

  const handlePaneSplitDown = React.useCallback(
    (paneId: string) => {
      const newPaneId = `pane-${Math.random().toString(36).slice(2)}`;
      const result = insertPaneAtEdge(state, paneId, "bottom", newPaneId, null);
      if (result) {
        commit({
          ...state,
          root: result.root,
          sizesByGroupId: result.sizesByGroupId,
        });
      }
    },
    [state, commit],
  );

  // Handle pane close: move tabs to nearest sibling, then remove pane.
  const handlePaneClose = React.useCallback(
    (paneId: string) => {
      const panePath = findPanePath(state.root, paneId);
      if (!panePath) return;

      const parentPath = panePath.slice(0, -1);
      let siblingPaneId: string | null = null;

      if (parentPath.length > 0) {
        const parentNode = getNodeAtPath(state.root, parentPath);
        if (parentNode.kind === "group") {
          const paneIndex = panePath[panePath.length - 1];
          for (let i = 0; i < parentNode.children.length; i++) {
            if (i !== paneIndex && parentNode.children[i].kind === "pane") {
              siblingPaneId = (parentNode.children[i] as import("@/features/factory/lib/tileTree").TilePane).id;
              break;
            }
          }
        }
      }

      // For root pane with no siblings: just keep it empty (clear tabs).
      if (!siblingPaneId) {
        const pane = findPaneById(state.root, paneId);
        if (!pane) return;
        for (const tabId of [...pane.tabIds]) {
          const workspaceTab = workspace.tabs.find((t) => t.id === tabId);
          if (workspaceTab) {
            const definition = getTabKind(workspaceTab.kind);
            void Promise.resolve(definition?.dispose?.(workspaceTab)).catch(() => {});
          }
          closeTab(channelId, tabId);
        }
        return;
      }

      // Move all tabs from this pane to sibling.
      let nextState = state;
      const pane = findPaneById(state.root, paneId);
      if (pane) {
        for (const tabId of [...pane.tabIds]) {
          const moved = moveTabToPane(nextState, tabId, siblingPaneId);
          if (moved) nextState = moved;
        }
      }

      // After moving all tabs, if pane is still non-empty or needs cleanup,
      // apply final commit with the updated tree.
      commit({
        ...nextState,
        focusedPaneId: nextState.focusedPaneId ?? siblingPaneId ?? nextState.focusedPaneId,
      });
    },
    [state, commit, workspace.tabs, channelId],
  );

  // Handle active tab change within a pane.
  const handlePaneActiveTabChange = React.useCallback(
    (paneId: string, tabId: string | null) => {
      const newRoot = replacePane(state.root, paneId, (pane) => ({
        ...pane,
        activeTabId: tabId ?? (pane.tabIds[0] ?? null),
      }));
      commit({ ...state, root: newRoot });
    },
    [state, commit],
  );

  // Handle tab close from pane: close through workspace mechanism so dispose runs.
  const handlePaneCloseTab = React.useCallback(
    (_paneId: string, tabId: string) => {
      const workspaceTab = workspace.tabs.find((t) => t.id === tabId);
      if (workspaceTab) {
        const definition = getTabKind(workspaceTab.kind);
        void Promise.resolve(definition?.dispose?.(workspaceTab)).catch(() => {});
      }
      closeTab(channelId, tabId);
    },
    [workspace.tabs, channelId],
  );

  // Handle group resize from splitters.
  const handleGroupResize = React.useCallback(
    (groupId: string, sizes: ReadonlyArray<number>) => {
      // Basic resize: apply normalized sizes from splitter drag.
      // The Splitter passes delta fractions; we translate to absolute sizes
      // based on current group sizes.
      // For a basic implementation we just use the passed sizes directly if
      // they look like full arrays, otherwise we adjust current sizes.
      if (sizes.length >= 2) {
        // If the passed array has the right length for the group, use it.
        const group = (function findGroup(
          root: import("@/features/factory/lib/tileTree").TileLayoutNode,
          gid: string,
        ): import("@/features/factory/lib/tileTree").TileGroup | null {
          if (root.kind === "group" && root.id === gid) return root;
          if (root.kind === "group") {
            for (const child of root.children) {
              const found = findGroup(child, gid);
              if (found) return found;
            }
          }
          return null;
        })(state.root, groupId);
        if (group && sizes.length === group.children.length) {
          const updated = {
            ...state,
            sizesByGroupId: { ...state.sizesByGroupId, [groupId]: sizes },
          };
          commit(updated);
          return;
        }
      }
      // Fallback for delta-style updates: adjust current sizes proportionally.
      const currentSizes: ReadonlyArray<number> = state.sizesByGroupId[groupId] ?? [];
      if (currentSizes.length === 0) return;
      const updated = {
        ...state,
        sizesByGroupId: {
          ...state.sizesByGroupId,
          [groupId]: currentSizes.map((s: number, i: number) => Math.max(0.05, s + (sizes[i] ?? 0))),
        },
      };
      commit(updated);
    },
    [state, commit],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="workspace-factory-body">
      <FactoryToolbar channelId={channelId} state={state} commit={commit} />
      <FactoryCanvas
        state={state}
        workspaceTabs={workspace.tabs}
        channelId={channelId}
        isFocusedPaneId={state.focusedPaneId}
        onPaneFocus={handlePaneFocus}
        onPaneSplitRight={handlePaneSplitRight}
        onPaneSplitDown={handlePaneSplitDown}
        onPaneClose={handlePaneClose}
        onPaneActiveTabChange={handlePaneActiveTabChange}
        onPaneCloseTab={handlePaneCloseTab}
        onGroupResize={handleGroupResize}
        commit={commit}
      />
    </div>
  );
}
