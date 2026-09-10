import * as React from "react";

import { useFeatureEnabled } from "@/shared/features";
import { useStableSet } from "@/shared/hooks/useStableReference";
import { useProjectsQuery } from "./hooks";
import type { Project } from "./projectModels";
import { projectBranchLabel } from "./lib/projectChannels";

export type ProjectChannelIndex = {
  /** Ids of channels a project owns; empty when the preview is disabled. */
  channelIds: ReadonlySet<string>;
  /** Owning project per channel id. */
  projectByChannelId: ReadonlyMap<string, Project>;
  /** Default branch per project channel id, for sidebar trailing meta. */
  branchByChannelId: Record<string, string>;
};

const EMPTY_INDEX: ProjectChannelIndex = {
  channelIds: new Set(),
  projectByChannelId: new Map(),
  branchByChannelId: {},
};

/**
 * The community's project channels, indexed for the sidebar and the channel
 * header. Gated on `workspaceFactoryTab`: with the preview off nothing is
 * fetched and every channel stays a plain channel.
 */
export function useProjectChannels(): ProjectChannelIndex {
  const enabled = useFeatureEnabled("workspaceFactoryTab");
  const projects = useProjectsQuery({ enabled }).data;

  const channelIds = useStableSet(
    React.useMemo(() => {
      if (!enabled || !projects) return new Set<string>();
      return new Set(
        projects
          .map((project) => project.projectChannelId)
          .filter((channelId): channelId is string => Boolean(channelId)),
      );
    }, [enabled, projects]),
  );

  return React.useMemo(() => {
    if (!enabled || !projects || channelIds.size === 0) return EMPTY_INDEX;

    const projectByChannelId = new Map<string, Project>();
    const branchByChannelId: Record<string, string> = {};
    for (const project of projects) {
      const channelId = project.projectChannelId;
      if (!channelId || projectByChannelId.has(channelId)) continue;
      projectByChannelId.set(channelId, project);
      const branch = projectBranchLabel(project, project.repositories);
      if (branch) branchByChannelId[channelId] = branch;
    }

    return { channelIds, projectByChannelId, branchByChannelId };
  }, [channelIds, enabled, projects]);
}
