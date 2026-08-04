import * as React from "react";

import { useAgentNameProfiles } from "@/features/agents/useAgentNameProfiles";
import { useEphemeralChannelDisplay } from "@/features/channels/useEphemeralChannelDisplay";
import { usePresenceQuery } from "@/features/presence/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { resolveChannelDisplayLabel } from "@/features/sidebar/lib/channelLabels";
import type { Channel, PresenceStatus } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type ActiveDmHeaderParticipant = {
  pubkey: string;
  displayName: string;
  avatarUrl: string | null;
};

export function useActiveChannelHeader(
  activeChannel: Channel | null,
  currentPubkey?: string,
) {
  const activeDmParticipants = React.useMemo(() => {
    if (activeChannel?.channelType !== "dm") {
      return [];
    }

    const normalizedCurrentPubkey = currentPubkey
      ? normalizePubkey(currentPubkey)
      : null;

    return activeChannel.participantPubkeys
      .map((pubkey, index) => ({
        fallbackName: activeChannel.participants[index] ?? null,
        pubkey,
      }))
      .filter(
        (participant) =>
          normalizePubkey(participant.pubkey) !== normalizedCurrentPubkey,
      );
  }, [activeChannel, currentPubkey]);
  const activeDmParticipantPubkeys = React.useMemo(
    () => activeDmParticipants.map((participant) => participant.pubkey),
    [activeDmParticipants],
  );
  const activeDmPresenceQuery = usePresenceQuery(activeDmParticipantPubkeys, {
    enabled: activeDmParticipantPubkeys.length > 0,
  });
  const activeDmProfilesQuery = useUsersBatchQuery(activeDmParticipantPubkeys, {
    enabled: activeDmParticipantPubkeys.length > 0,
  });
  // Registry overlay: an agent peer whose kind:0 hasn't reached this relay
  // yet must still resolve to its registry name, not its raw pubkey.
  const activeDmProfiles = useAgentNameProfiles(
    activeDmProfilesQuery.data?.profiles,
    currentPubkey,
  );
  const activeChannelEphemeralDisplay =
    useEphemeralChannelDisplay(activeChannel);
  const activeDmPresenceStatus: PresenceStatus | null =
    activeDmParticipantPubkeys.length > 0
      ? (activeDmPresenceQuery.data?.[
          activeDmParticipantPubkeys[0]?.toLowerCase()
        ] ?? null)
      : null;
  const activeDmAvatarUrl =
    activeDmParticipantPubkeys.length > 0
      ? (activeDmProfiles?.[
          normalizePubkey(activeDmParticipantPubkeys[0] ?? "")
        ]?.avatarUrl ?? null)
      : null;
  const activeDmHeaderParticipants = React.useMemo(
    () =>
      activeDmParticipants.map((participant) => {
        const profile =
          activeDmProfiles?.[normalizePubkey(participant.pubkey)] ?? null;

        return {
          pubkey: participant.pubkey,
          displayName: resolveUserLabel({
            currentPubkey,
            fallbackName: participant.fallbackName,
            profiles: activeDmProfiles,
            pubkey: participant.pubkey,
          }),
          avatarUrl: profile?.avatarUrl ?? null,
        };
      }),
    [activeDmParticipants, activeDmProfiles, currentPubkey],
  );

  return {
    activeChannelTitle: activeChannel
      ? resolveChannelDisplayLabel(
          activeChannel,
          currentPubkey,
          activeDmProfiles,
        )
      : "Channels",
    activeDmAvatarUrl,
    activeDmHeaderParticipants,
    activeDmPresenceStatus,
    activeChannelEphemeralDisplay,
  };
}
