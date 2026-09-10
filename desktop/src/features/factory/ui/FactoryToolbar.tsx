import * as React from "react";
import { LayoutGrid, Columns2, Rows2, Focus, Network } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import {
  addTabToPane,
  applyPreset,
  collectPanes,
  findPaneByTabId,
  replacePane,
  type TileTreeState,
  type TileLayoutNode,
} from "@/features/factory/lib/tileTree";
import {
  COMM_GRAPH_TAB_KIND,
  COMM_GRAPH_TAB_TITLE,
} from "@/features/factory/lib/commGraphTab";
import { projectChipLabel } from "../lib/projectChannel";
import { useProjectsQuery } from "@/features/projects/hooks";
import { findProjectForChannel } from "@/features/factory/lib/projectChannel";
import { collectAgentTabPubkeys } from "@/features/factory/lib/agentTabPayload";
import {
  LaunchAgentDialog,
  type LaunchedAgent,
} from "@/features/factory/ui/LaunchAgentDialog";
import {
  getActiveTurnsForAgent,
  subscribeActiveAgentTurns,
} from "@/features/agents/activeAgentTurnsStore";
import { openAgentTab } from "@/features/workspace/kinds/agentKind";
import {
  openTab,
  setActiveTab,
  useWorkspace,
} from "@/features/workspace/lib/workspaceTabs";

function hasActiveTurn(pubkey: string): boolean {
  return getActiveTurnsForAgent(pubkey).length > 0;
}

export type FactoryToolbarProps = {
  channelId: string;
  /** The factory tab itself, so opening a tile can hand focus back to it. */
  factoryTabId: string;
  state: TileTreeState;
  commit: (next: TileTreeState) => void;
  preset: "single" | "columns" | "grid" | "focus" | null;
  onPresetChange: (
    preset: "single" | "columns" | "grid" | "focus" | null,
  ) => void;
};

export function FactoryToolbar({
  channelId,
  factoryTabId,
  state,
  commit,
  preset,
  onPresetChange,
}: FactoryToolbarProps): React.JSX.Element {
  const projects = useProjectsQuery();
  const project = findProjectForChannel(projects.data, channelId);
  const workspace = useWorkspace(channelId);
  const [launchOpen, setLaunchOpen] = React.useState(false);

  // Open the graph, or focus the one that is already open. A second graph tile
  // would show the same derived view twice, so the button is idempotent.
  //
  // Every path ends by making the factory tab active again: `openTab` activates
  // what it creates, and an active graph tab would render standalone in the
  // workspace shell instead of inside the pane that now owns it.
  const openGraph = React.useCallback(() => {
    const existing = workspace.tabs.find(
      (tab) => tab.kind === COMM_GRAPH_TAB_KIND,
    );
    if (existing) {
      const pane = findPaneByTabId(state.root, existing.id);
      if (pane) {
        commit({
          ...state,
          root: replacePane(state.root, pane.id, (candidate) => ({
            ...candidate,
            activeTabId: existing.id,
          })),
          focusedPaneId: pane.id,
        });
        setActiveTab(channelId, factoryTabId);
        return;
      }
      commit(
        addTabToPane(state, state.focusedPaneId, existing.id, {
          activate: true,
        }),
      );
      setActiveTab(channelId, factoryTabId);
      return;
    }
    const tabId = openTab(channelId, {
      kind: COMM_GRAPH_TAB_KIND,
      title: COMM_GRAPH_TAB_TITLE,
      createdBy: "local",
      payload: {},
    });
    commit(addTabToPane(state, state.focusedPaneId, tabId, { activate: true }));
    setActiveTab(channelId, factoryTabId);
  }, [workspace.tabs, state, commit, channelId, factoryTabId]);

  const paneCount = collectPanes(state.root).length;
  const tabIdsInTree: string[] = [];
  function collectTabs(node: TileLayoutNode): void {
    if (node.kind === "pane") {
      tabIdsInTree.push(...node.tabIds);
    } else {
      for (const child of node.children) collectTabs(child);
    }
  }
  collectTabs(state.root);

  const agentPubkeys = collectAgentTabPubkeys(workspace.tabs, tabIdsInTree);
  // A joined key so the snapshot reader is stable while the tiles are: a fresh
  // array every render would resubscribe the store on every render.
  const agentKey = agentPubkeys.join(",");
  const readWorkingCount = React.useCallback(
    () =>
      agentKey
        .split(",")
        .filter((pubkey) => pubkey.length > 0 && hasActiveTurn(pubkey)).length,
    [agentKey],
  );
  const workingCount = React.useSyncExternalStore(
    subscribeActiveAgentTurns,
    readWorkingCount,
  );

  const handleLaunched = React.useCallback(
    ({ name, pubkey, threadRootId }: LaunchedAgent) => {
      const tabId = openAgentTab(channelId, pubkey, name, threadRootId);
      // `openTab` makes the new tab the workspace's active one, which would
      // replace the canvas with the bare tile. The canvas owns it instead.
      setActiveTab(channelId, factoryTabId);
      // Adopting it here rather than leaving it to the tree reconcile is what
      // makes the new tile the focused pane's visible tab.
      commit(
        addTabToPane(state, state.focusedPaneId, tabId, { activate: true }),
      );
    },
    [channelId, commit, factoryTabId, state],
  );

  const chipText = project
    ? projectChipLabel(project)
    : "Unknown project · main";

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/30 px-3 py-2">
      <span
        className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
        data-testid="factory-project-chip"
      >
        {chipText}
      </span>
      <span
        className="text-xs text-muted-foreground"
        data-testid="factory-tile-count"
      >
        {paneCount} pane{paneCount !== 1 ? "s" : ""} · {tabIdsInTree.length}{" "}
        tile{tabIdsInTree.length !== 1 ? "s" : ""}
      </span>
      {agentPubkeys.length > 0 ? (
        <span
          className="text-xs text-muted-foreground"
          data-testid="factory-agent-count"
        >
          {agentPubkeys.length} agent{agentPubkeys.length !== 1 ? "s" : ""} ·{" "}
          {workingCount} working
        </span>
      ) : null}
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <Tabs
          value={preset ?? "single"}
          onValueChange={(v) => {
            onPresetChange(v as "single" | "columns" | "grid" | "focus");
            const tabIds = tabIdsInTree;
            const updated = applyPreset(
              state,
              v as "single" | "columns" | "grid" | "focus",
              tabIds,
            );
            commit(updated);
          }}
          className="w-auto"
        >
          <TabsList className="h-7 bg-muted p-0.5">
            <TabsTrigger
              value="single"
              className="h-5 px-2 py-0.5 text-badge"
              title="Single"
              data-testid="factory-preset-single"
            >
              <LayoutGrid className="mr-1 h-3 w-3" />
              Single
            </TabsTrigger>
            <TabsTrigger
              value="columns"
              className="h-5 px-2 py-0.5 text-badge"
              title="Columns"
              data-testid="factory-preset-columns"
            >
              <Columns2 className="mr-1 h-3 w-3" />
              Columns
            </TabsTrigger>
            <TabsTrigger
              value="grid"
              className="h-5 px-2 py-0.5 text-badge"
              title="Grid"
              data-testid="factory-preset-grid"
            >
              <Rows2 className="mr-1 h-3 w-3" />
              Grid
            </TabsTrigger>
            <TabsTrigger
              value="focus"
              className="h-5 px-2 py-0.5 text-badge"
              title="Focus"
              data-testid="factory-preset-focus"
            >
              <Focus className="mr-1 h-3 w-3" />
              Focus
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Button
        size="xs"
        variant="outline"
        title="Communication graph"
        data-testid="factory-open-graph"
        onClick={openGraph}
      >
        <Network className="mr-1 h-3 w-3" />
        Graph
      </Button>
      <Button
        size="xs"
        variant="outline"
        onClick={() => setLaunchOpen(true)}
        title="Launch an agent into this project"
        data-testid="factory-add-agent-btn"
      >
        + Agent
      </Button>
      <LaunchAgentDialog
        channelId={channelId}
        onLaunched={handleLaunched}
        onOpenChange={setLaunchOpen}
        open={launchOpen}
      />
    </div>
  );
}
