import * as React from "react";

import { useIdentityQuery } from "@/shared/api/hooks";
import { useFeatureEnabled } from "@/shared/features";
import { useProjectsQuery } from "./hooks";
import { linkableProjects } from "./lib/projectChannelLink";
import type { Project } from "./projectModels";
import { useLinkProjectChannelMutation } from "./useLinkProjectChannel";

export type CreateChannelProjectField = {
  /** False when the preview is off — the picker renders nothing. */
  enabled: boolean;
  /** The user's projects that have no channel yet. */
  options: Project[];
  projectId: string | null;
  setProjectId: (projectId: string | null) => void;
  reset: () => void;
  /** Links the chosen project to a channel that was just created. */
  linkCreatedChannel: (channelId: string) => Promise<void>;
};

/**
 * The create-channel dialog's optional "Project" field.
 *
 * Creating the channel and linking the project are two writes: the channel is
 * created first (unchanged, still a plain stream channel), then the project's
 * announcement is re-published with the new channel id. A failed link leaves
 * a perfectly good channel behind, so the error is surfaced on the form
 * rather than rolled back.
 */
export function useCreateChannelProject(): CreateChannelProjectField {
  const enabled = useFeatureEnabled("workspaceFactoryTab");
  const currentPubkey = useIdentityQuery().data?.pubkey;
  const projects = useProjectsQuery({ enabled }).data;
  const linkMutation = useLinkProjectChannelMutation();
  const [projectId, setProjectId] = React.useState<string | null>(null);

  const options = React.useMemo(
    () => (enabled ? linkableProjects(projects, null, currentPubkey) : []),
    [currentPubkey, enabled, projects],
  );

  const reset = React.useCallback(() => setProjectId(null), []);

  const selected = options.find((project) => project.id === projectId) ?? null;
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;
  const { mutateAsync } = linkMutation;

  const linkCreatedChannel = React.useCallback(
    async (channelId: string) => {
      const project = selectedRef.current;
      if (!project) return;
      await mutateAsync({ channelId, project });
    },
    [mutateAsync],
  );

  return {
    enabled,
    options,
    projectId,
    setProjectId,
    reset,
    linkCreatedChannel,
  };
}
