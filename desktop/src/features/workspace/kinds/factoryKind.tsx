import * as React from "react";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import type {
  TabKindDefinition,
  TabKindContext,
} from "@/features/workspace/lib/tabKindRegistry";
import {
  parseTileTree,
  addTabToPane,
  createInitialTree,
  serializeTileTree,
  insertPaneAtEdge,
  findPaneById,
  findPaneByTabId,
  findPanePath,
  moveTabToPane,
  getNodeAtPath,
  paneRightOf,
  replacePane,
  type TileLayoutNode,
} from "@/features/factory/lib/tileTree";
import { parseAgentTabPayload } from "@/features/factory/lib/agentTabPayload";
import {
  FactoryTileProvider,
  type FactoryTileActions,
} from "@/features/factory/ui/FactoryTileContext";
import { openAgentTab } from "@/features/workspace/kinds/agentKind";
import { openTerminalTab } from "@/features/workspace/kinds/terminalKind";
import { setActiveTab } from "@/features/workspace/lib/workspaceTabs";
import { useFactoryTree } from "@/features/factory/ui/useFactoryTree";
import { useTabDrag } from "@/features/factory/ui/useTabDrag";
import {
  clearStripDragHandler,
  setStripDragHandler,
  type StripDragHandler,
} from "@/features/factory/lib/factoryDragBridge";
import { FactoryCanvas } from "@/features/factory/ui/FactoryCanvas";
import { FactoryToolbar } from "@/features/factory/ui/FactoryToolbar";
import { isProjectChannel } from "@/features/factory/lib/projectChannel";
import { getTabKind } from "@/features/workspace/lib/tabKindRegistry";
import { useWorkspace } from "@/features/workspace/lib/workspaceTabs";
import { closeWorkspaceTab } from "@/features/workspace/lib/closeWorkspaceTab";

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
  const [preset, setPreset] = React.useState<
    "single" | "columns" | "grid" | "focus" | null
  >(null);
  const [launcher, setLauncher] = React.useState<{
    open: boolean;
    briefPrefill: string;
  }>({ open: false, briefPrefill: "" });

  // A drop rearranges the tree by hand, so no preset describes the layout
  // any more.
  const handleDrop = React.useCallback(() => setPreset(null), []);
  const drag = useTabDrag({ state, commit, onDrop: handleDrop });

  // Let the workspace tab strip start a drag into a pane. The strip knows
  // nothing about panes; it forwards a pointer down to whatever body is
  // mounted, which is this one while the factory tab is active.
  const workspaceTabsRef = React.useRef(workspace.tabs);
  workspaceTabsRef.current = workspace.tabs;
  const startTabDrag = drag.startTabDrag;
  React.useEffect(() => {
    const handler: StripDragHandler = (tabId, event) => {
      const tab = workspaceTabsRef.current.find(
        (candidate) => candidate.id === tabId,
      );
      startTabDrag(tabId, tab?.title ?? tabId, event);
    };
    setStripDragHandler(handler);
    return () => clearStripDragHandler(handler);
  }, [startTabDrag]);

  // Handle pane focus.
  const handlePaneFocus = React.useCallback(
    (paneId: string) => {
      // Focus follows the pointer, so this runs on every press in a pane:
      // only write when it actually changes something.
      if (state.focusedPaneId === paneId) return;
      commit({ ...state, focusedPaneId: paneId });
    },
    [state, commit],
  );

  // Handle split actions.
  const handlePaneSplitRight = React.useCallback(
    (paneId: string) => {
      setPreset(null);
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
      setPreset(null);
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
      setPreset(null);
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
              siblingPaneId = (
                parentNode.children[
                  i
                ] as import("@/features/factory/lib/tileTree").TilePane
              ).id;
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
            void Promise.resolve(definition?.dispose?.(workspaceTab)).catch(
              () => {},
            );
          }
          void closeWorkspaceTab(channelId, tabId);
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
        focusedPaneId:
          nextState.focusedPaneId ?? siblingPaneId ?? nextState.focusedPaneId,
      });
    },
    [state, commit, workspace.tabs, channelId],
  );

  // Handle active tab change within a pane.
  const handlePaneActiveTabChange = React.useCallback(
    (paneId: string, tabId: string | null) => {
      setPreset(null);
      const newRoot = replacePane(state.root, paneId, (pane) => ({
        ...pane,
        activeTabId: tabId ?? pane.tabIds[0] ?? null,
      }));
      commit({ ...state, root: newRoot });
    },
    [state, commit],
  );

  // Handle tab close from pane: close through workspace mechanism so dispose runs.
  const handlePaneCloseTab = React.useCallback(
    (_paneId: string, tabId: string) => {
      setPreset(null);
      const workspaceTab = workspace.tabs.find((t) => t.id === tabId);
      if (workspaceTab) {
        const definition = getTabKind(workspaceTab.kind);
        void Promise.resolve(definition?.dispose?.(workspaceTab)).catch(
          () => {},
        );
      }
      void closeWorkspaceTab(channelId, tabId);
    },
    [workspace.tabs, channelId],
  );

  // The seam every tile inside the canvas reaches the tree through. A tile is
  // rendered by the kind registry, far below this component, so the delegate
  // menu cannot be handed the tree by props.
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const factoryTabId = tab.id;
  const agentsInTree = React.useMemo(() => {
    const inTree = new Set<string>();
    (function collect(node: TileLayoutNode): void {
      if (node.kind === "pane") {
        for (const tabId of node.tabIds) inTree.add(tabId);
      } else {
        for (const child of node.children) collect(child);
      }
    })(state.root);
    return workspace.tabs
      .filter(
        (candidate) => candidate.kind === "agent" && inTree.has(candidate.id),
      )
      .flatMap((candidate) => {
        const payload = parseAgentTabPayload(candidate.payload);
        return payload
          ? [
              {
                tabId: candidate.id,
                pubkey: payload.agentPubkey,
                title: candidate.title,
              },
            ]
          : [];
      });
  }, [state.root, workspace.tabs]);

  const openAgentBeside = React.useCallback<
    FactoryTileActions["openAgentBeside"]
  >(
    (sourceTabId, agent) => {
      const current = stateRef.current;
      const sourcePane = findPaneByTabId(current.root, sourceTabId);
      if (!sourcePane) return;
      setPreset(null);

      // An agent already on a tile is focused rather than opened twice: two
      // tiles for one agent would each own a composer bound to the same thread.
      const existing = agentsInTree.find(
        (candidate) => candidate.pubkey === agent.pubkey,
      );
      if (existing) {
        const pane = findPaneByTabId(current.root, existing.tabId);
        if (!pane) return;
        commit({
          ...current,
          root: replacePane(current.root, pane.id, (target) => ({
            ...target,
            activeTabId: existing.tabId,
          })),
          focusedPaneId: pane.id,
        });
        return;
      }

      const tabId = openAgentTab(
        channelId,
        agent.pubkey,
        agent.name,
        agent.threadRootId,
      );
      // `openTab` activates the new tab in the workspace, which would replace
      // the canvas with the bare tile; the canvas owns it instead.
      setActiveTab(channelId, factoryTabId);

      const neighbour = paneRightOf(current.root, sourcePane.id);
      if (neighbour) {
        const next = addTabToPane(current, neighbour.id, tabId, {
          activate: true,
        });
        if (next) commit({ ...next, focusedPaneId: neighbour.id });
        return;
      }
      const newPaneId = `pane-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      const result = insertPaneAtEdge(
        current,
        sourcePane.id,
        "right",
        newPaneId,
        tabId,
      );
      if (!result) return;
      commit({
        ...current,
        root: result.root,
        sizesByGroupId: result.sizesByGroupId,
        focusedPaneId: newPaneId,
      });
    },
    [agentsInTree, channelId, commit, factoryTabId],
  );

  const openTerminalHere = React.useCallback<
    FactoryTileActions["openTerminalHere"]
  >(
    (sourceTabId, { cwd, title }) => {
      const current = stateRef.current;
      const sourcePane = findPaneByTabId(current.root, sourceTabId);
      if (!sourcePane) return;
      setPreset(null);
      const tabId = openTerminalTab(channelId, { cwd, title });
      setActiveTab(channelId, factoryTabId);
      const next = addTabToPane(current, sourcePane.id, tabId, {
        activate: true,
      });
      if (next) commit({ ...next, focusedPaneId: sourcePane.id });
    },
    [channelId, commit, factoryTabId],
  );

  const openLauncher = React.useCallback((briefPrefill: string) => {
    setLauncher({ open: true, briefPrefill });
  }, []);

  const tileActions = React.useMemo<FactoryTileActions>(
    () => ({
      agents: agentsInTree,
      openAgentBeside,
      openLauncher,
      openTerminalHere,
    }),
    [agentsInTree, openAgentBeside, openLauncher, openTerminalHere],
  );

  // Handle group resize from splitters.
  const handleGroupResize = React.useCallback(
    (groupId: string, sizes: ReadonlyArray<number>) => {
      setPreset(null);
      // Basic resize: apply normalized sizes from splitter drag.
      // The Splitter passes delta fractions; we translate to absolute sizes
      // based on current group sizes.
      // For a basic implementation we just use the passed sizes directly if
      // they look like full arrays, otherwise we adjust current sizes.
      if (sizes.length >= 2) {
        // If the passed array has the right length for the group, use it.
        const group = (function findGroup(
          root: TileLayoutNode,
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
      const currentSizes: ReadonlyArray<number> =
        state.sizesByGroupId[groupId] ?? [];
      if (currentSizes.length === 0) return;
      const updated = {
        ...state,
        sizesByGroupId: {
          ...state.sizesByGroupId,
          [groupId]: currentSizes.map((s: number, i: number) =>
            Math.max(0.05, s + (sizes[i] ?? 0)),
          ),
        },
      };
      commit(updated);
    },
    [state, commit],
  );

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="workspace-factory-body"
    >
      <FactoryToolbar
        channelId={channelId}
        factoryTabId={tab.id}
        state={state}
        commit={commit}
        preset={preset}
        onPresetChange={setPreset}
        launchOpen={launcher.open}
        launchBriefPrefill={launcher.briefPrefill}
        onLaunchOpenChange={(open) =>
          setLauncher((current) => ({ ...current, open }))
        }
      />
      <FactoryTileProvider actions={tileActions}>
        <FactoryCanvas
          state={state}
          workspaceTabs={workspace.tabs}
          channelId={channelId}
          drag={drag}
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
      </FactoryTileProvider>
    </div>
  );
}
