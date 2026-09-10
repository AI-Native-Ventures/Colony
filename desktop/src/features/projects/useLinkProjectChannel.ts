import { useMutation, useQueryClient } from "@tanstack/react-query";

import { type Project, projectsQueryKey } from "@/features/projects/hooks";
import { isUnsupportedProjectKindError } from "@/features/projects/projectCreation";
import { validateProjectEventEnvelope } from "@/features/projects/projectModels";
import { withProjectChannel } from "@/features/projects/lib/projectChannelLink";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { KIND_PROJECT_ANNOUNCEMENT } from "@/shared/constants/kinds";

export type LinkProjectChannelInput = {
  /** The channel to link, or null to unlink the project from its channel. */
  channelId: string | null;
  project: Project;
};

/**
 * Re-publishes a project's announcement with its `buzz-channel` tag set to
 * `channelId` (or removed when null).
 *
 * Patches the live signed head rather than the cached projection, for the same
 * two reasons `useAddProjectRepository` does: a cached projection would erase
 * unknown tags, and a concurrent write from another session or the CLI would
 * be clobbered without the dominated-write guard below.
 */
async function linkProjectChannel({
  channelId,
  project,
}: LinkProjectChannelInput): Promise<Project> {
  const identity = await getIdentity();
  if (identity.pubkey.toLowerCase() !== project.owner.toLowerCase()) {
    throw new Error("Only the project owner can link it to a channel.");
  }
  if (project.legacy) {
    throw new Error(
      "This project predates project announcements and cannot be linked to a channel.",
    );
  }

  const liveHeads = await relayClient.fetchEvents({
    kinds: [KIND_PROJECT_ANNOUNCEMENT],
    authors: [identity.pubkey],
    "#d": [project.dtag],
    limit: 1,
  });
  const liveHead = liveHeads[0];
  if (!liveHead) {
    throw new Error(
      "Could not find this project on the relay. Refresh and try again.",
    );
  }
  if (liveHead.created_at > project.createdAt) {
    throw new Error(
      "This project was updated by another session while you were working. Refresh and try again.",
    );
  }

  const tags = withProjectChannel(liveHead.tags, channelId);
  validateProjectEventEnvelope(tags, liveHead.content);

  const event = await signRelayEvent({
    kind: KIND_PROJECT_ANNOUNCEMENT,
    content: liveHead.content,
    tags,
    createdAt: Math.max(
      Math.floor(Date.now() / 1_000),
      liveHead.created_at + 1,
    ),
  });

  try {
    await relayClient.publishEvent(
      event,
      "Timed out updating the project.",
      "Failed to update the project.",
    );
  } catch (error) {
    if (isUnsupportedProjectKindError(error)) {
      throw new Error(
        `This relay does not support projects (event kind ${KIND_PROJECT_ANNOUNCEMENT}).`,
      );
    }
    throw error;
  }

  return {
    ...project,
    createdAt: event.created_at,
    projectChannelId: channelId?.trim() || null,
  };
}

export function useLinkProjectChannelMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: linkProjectChannel,
    onSuccess: (project) => {
      queryClient.setQueryData<Project[]>(projectsQueryKey, (current = []) =>
        current.map((candidate) =>
          candidate.id === project.id ? project : candidate,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}
