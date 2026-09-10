import * as React from "react";

import { useFeatureEnabled } from "@/shared/features";
import { useStableSet } from "@/shared/hooks/useStableReference";
import { useProjectsQuery } from "./hooks";
import type { Project } from "./projectModels";
import { projectBranchLabel } from "./lib/projectChannels";

/**
 * How long the sidebar waits for project membership before showing channels
 * anyway. A slow or unreachable relay must never hold the channel list
 * hostage; the section simply appears late in that case.
 */
const MEMBERSHIP_WAIT_MS = 1_500;

export type ProjectChannelIndex = {
  /** Ids of channels a project owns; empty when the preview is disabled. */
  channelIds: ReadonlySet<string>;
  /** Owning project per channel id. */
  projectByChannelId: ReadonlyMap<string, Project>;
  /** Default branch per project channel id, for sidebar trailing meta. */
  branchByChannelId: Record<string, string>;
  /**
   * True once membership is known — the query has resolved (or failed), the
   * preview is off, or the wait above has elapsed. Until then a caller that
   * places channels by section should hold its render: a channel that starts
   * in Channels and hops to Projects one frame later is a visible jump, and
   * it tears the row out of the DOM under anything holding a handle on it.
   */
  settled: boolean;
};

const EMPTY_INDEX = {
  channelIds: new Set<string>(),
  projectByChannelId: new Map<string, Project>(),
  branchByChannelId: {} as Record<string, string>,
};

/** Flips to true once `delayMs` has elapsed since mount. */
function useElapsed(delayMs: number): boolean {
  const [elapsed, setElapsed] = React.useState(false);
  React.useEffect(() => {
    const timerId = globalThis.setTimeout(() => setElapsed(true), delayMs);
    return () => globalThis.clearTimeout(timerId);
  }, [delayMs]);
  return elapsed;
}

/**
 * The community's project channels, indexed for the sidebar and the channel
 * header. Gated on `workspaceFactoryTab`: with the preview off nothing is
 * fetched and every channel stays a plain channel.
 */
export function useProjectChannels(): ProjectChannelIndex {
  const enabled = useFeatureEnabled("workspaceFactoryTab");
  const query = useProjectsQuery({ enabled });
  const projects = query.data;
  const waitElapsed = useElapsed(MEMBERSHIP_WAIT_MS);
  const settled = !enabled || query.isFetched || query.isError || waitElapsed;

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
    if (!enabled || !projects || channelIds.size === 0) {
      return { ...EMPTY_INDEX, settled };
    }

    const projectByChannelId = new Map<string, Project>();
    const branchByChannelId: Record<string, string> = {};
    for (const project of projects) {
      const channelId = project.projectChannelId;
      if (!channelId || projectByChannelId.has(channelId)) continue;
      projectByChannelId.set(channelId, project);
      const branch = projectBranchLabel(project, project.repositories);
      if (branch) branchByChannelId[channelId] = branch;
    }

    return { channelIds, projectByChannelId, branchByChannelId, settled };
  }, [channelIds, enabled, projects, settled]);
}
