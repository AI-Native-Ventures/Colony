import * as React from "react";
import { LayoutGrid, Columns2, Rows2, Focus } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { applyPreset, collectPanes, type TileTreeState } from "@/features/factory/lib/tileTree";
import { projectChipLabel } from "../lib/projectChannel";
import { useProjectsQuery } from "@/features/projects/hooks";
import { findProjectForChannel } from "@/features/factory/lib/projectChannel";

export type FactoryToolbarProps = {
  channelId: string;
  state: TileTreeState;
  commit: (next: TileTreeState) => void;
};

export function FactoryToolbar({
  channelId,
  state,
  commit,
}: FactoryToolbarProps): React.JSX.Element {
  const projects = useProjectsQuery();
  const project = findProjectForChannel(projects.data, channelId);

  const paneCount = collectPanes(state.root).length;
  const tabIdsInTree: string[] = [];
  function collectTabs(node: import("@/features/factory/lib/tileTree").TileLayoutNode): void {
    if (node.kind === "pane") {
      tabIdsInTree.push(...node.tabIds);
    } else {
      for (const child of node.children) collectTabs(child);
    }
  }
  collectTabs(state.root);

  const chipText = project ? projectChipLabel(project) : "Unknown project · main";

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/30 px-3 py-2">
      <span
        className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
        data-testid="factory-project-chip"
      >
        {chipText}
      </span>
      <span className="text-xs text-muted-foreground" data-testid="factory-tile-count">
        {paneCount} pane{paneCount !== 1 ? "s" : ""} · {tabIdsInTree.length} tile{tabIdsInTree.length !== 1 ? "s" : ""}
      </span>
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        <Tabs defaultValue="single" className="w-auto">
          <TabsList className="h-7 bg-muted p-0.5">
            <TabsTrigger
              value="single"
              className="h-5 px-2 py-0.5 text-[10px]"
              onClick={() => {
                const tabIds = tabIdsInTree;
                const updated = applyPreset(state, "single", tabIds);
                commit(updated);
              }}
              title="Single"
            >
              <LayoutGrid className="mr-1 h-3 w-3" />
              Single
            </TabsTrigger>
            <TabsTrigger
              value="columns"
              className="h-5 px-2 py-0.5 text-[10px]"
              onClick={() => {
                const tabIds = tabIdsInTree;
                const updated = applyPreset(state, "columns", tabIds);
                commit(updated);
              }}
              title="Columns"
            >
              <Columns2 className="mr-1 h-3 w-3" />
              Columns
            </TabsTrigger>
            <TabsTrigger
              value="grid"
              className="h-5 px-2 py-0.5 text-[10px]"
              onClick={() => {
                const tabIds = tabIdsInTree;
                const updated = applyPreset(state, "grid", tabIds);
                commit(updated);
              }}
              title="Grid"
            >
              <Rows2 className="mr-1 h-3 w-3" />
              Grid
            </TabsTrigger>
            <TabsTrigger
              value="focus"
              className="h-5 px-2 py-0.5 text-[10px]"
              onClick={() => {
                const tabIds = tabIdsInTree;
                const updated = applyPreset(state, "focus", tabIds);
                commit(updated);
              }}
              title="Focus"
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
        disabled
        title="Coming soon"
        data-testid="factory-add-agent-btn"
      >
        + Agent
      </Button>
    </div>
  );
}
