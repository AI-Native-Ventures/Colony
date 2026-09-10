import type * as React from "react";
import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  createInitialTree,
  parseTileTree,
} from "@/features/factory/lib/tileTree";
import {
  findProjectForChannel,
  isProjectChannel,
} from "@/features/factory/lib/projectChannel";
import { useProjectsQuery } from "@/features/projects/hooks";
import type { Repository } from "@/features/projects/projectModels";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";

export const factoryKindDefinition: TabKindDefinition = {
  kind: "factory",
  label: "Factory",
  createTitle: () => "Factory",
  createPayload: () => {
    const paneId = `factory-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    const initialState = createInitialTree(paneId);
    return {
      v: 1,
      root: initialState.root,
      sizesByGroupId: initialState.sizesByGroupId,
      focusedPaneId: initialState.focusedPaneId,
    };
  },
  canCreateFromNewTabPage: true,
  isAvailable: (
    context: import("@/features/workspace/lib/tabKindRegistry").TabKindContext,
  ) => isProjectChannel(context.projects, context.channelId),
};

export function FactoryBody({
  channelId,
  tab,
}: TabBodyProps): React.JSX.Element {
  const projects = useProjectsQuery();
  const project = findProjectForChannel(projects.data, channelId);
  const payload = tab.payload;
  const parsedState = parseTileTree(payload);

  const primaryRepo: Repository | null = project
    ? (project.repositories.find(
        (repo) => repo.repoAddress === project.primaryRepositoryAddress,
      ) ??
      project.repositories[0] ??
      null)
    : null;
  const chipText = project
    ? `${project.name} · ${primaryRepo?.defaultBranch ?? "main"}`
    : "Unknown project · main";

  if (!parsedState) {
    return (
      <div
        className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground"
        data-testid="workspace-factory-body"
      >
        <div className="flex flex-col items-center gap-2">
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            {chipText}
          </span>
          <span>This Factory tab needs a newer version of the app.</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col p-4"
      data-testid="workspace-factory-body"
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
          {chipText}
        </span>
      </div>
      <div className="flex-1 text-sm text-muted-foreground">No tiles yet</div>
    </div>
  );
}
