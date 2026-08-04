import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { formatDmParticipantDisplayName } from "@/features/channels/lib/dmParticipantDisplay";
import type { Channel } from "@/shared/api/types";

/// A DM name that carries no information a person would want to read, and so
/// should give way to the participants' resolved profile names.
///
/// A bare key counts. A DM created before its peer's profile was known is
/// named with that peer's raw pubkey, and the old test only recognised words
/// like "dm" or "group dm", so the header and sidebar rendered
/// `0e74f2eaeb629ba9…` while the conversation's own intro line, which resolves
/// profiles by a different path, said "Chief of Staff" directly underneath.
function isGenericDmChannelName(name: string) {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "dm" ||
    normalized === "direct message" ||
    normalized === "direct messages" ||
    /^group dm\s*(\(\d+\))?$/.test(normalized) ||
    // 64-hex pubkey, or its bech32 npub form.
    /^[0-9a-f]{64}$/.test(normalized) ||
    /^npub1[02-9ac-hj-np-z]{58}$/.test(normalized)
  );
}

export function resolveChannelDisplayLabel(
  channel: Channel,
  currentPubkey: string | undefined,
  profiles: UserProfileLookup | undefined,
) {
  if (channel.channelType !== "dm" || !isGenericDmChannelName(channel.name)) {
    return channel.name;
  }

  const participants = channel.participantPubkeys.map((pubkey, index) => ({
    fallbackName: channel.participants[index] ?? null,
    pubkey,
  }));
  const otherParticipants = currentPubkey
    ? participants.filter(
        (participant) =>
          participant.pubkey.toLowerCase() !== currentPubkey.toLowerCase(),
      )
    : participants;
  const resolvedLabels = (
    otherParticipants.length > 0 ? otherParticipants : participants
  ).map((participant) =>
    resolveUserLabel({
      currentPubkey,
      fallbackName: participant.fallbackName,
      profiles,
      pubkey: participant.pubkey,
    }),
  );
  const uniqueLabels = [...new Set(resolvedLabels)];

  return uniqueLabels.length > 0
    ? formatDmParticipantDisplayName(
        uniqueLabels.map((displayName) => ({ displayName })),
      )
    : channel.name;
}
