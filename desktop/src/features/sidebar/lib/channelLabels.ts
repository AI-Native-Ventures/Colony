import {
  resolveUserLabel,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";
import { formatDmParticipantDisplayName } from "@/features/channels/lib/dmParticipantDisplay";
import type { Channel } from "@/shared/api/types";

/// A DM name that is just an identity key: the peer's 64-hex pubkey, or its
/// bech32 npub form.
function isPubkeyName(name: string) {
  const normalized = name.trim().toLowerCase();
  return (
    /^[0-9a-f]{64}$/.test(normalized) ||
    /^npub1[02-9ac-hj-np-z]{58}$/.test(normalized)
  );
}

/// A DM name that carries no information a person would want to read, and so
/// should give way to the participants' resolved profile names.
///
/// A bare key counts. A DM created before its peer's profile is known is named
/// with that peer's raw pubkey, and the old test only recognised words like
/// "dm" or "group dm", so the header and sidebar rendered
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
    isPubkeyName(normalized)
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

  const participants = channel.participantPubkeys.map((pubkey, index) => {
    const fallbackName = channel.participants[index] ?? null;
    return {
      // A key is not a name. Producers have handed this array raw pubkeys
      // (the Tauri channel decoder did exactly that), and `resolveUserLabel`
      // returns a non-empty fallback before it ever consults profiles or
      // truncates — so one bad producer prints 64 characters where a name
      // belongs. Treating a key-shaped fallback as absent keeps that local to
      // whoever produced it.
      fallbackName:
        fallbackName && isPubkeyName(fallbackName) ? null : fallbackName,
      pubkey,
    };
  });
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

  if (uniqueLabels.length > 0) {
    return formatDmParticipantDisplayName(
      uniqueLabels.map((displayName) => ({ displayName })),
    );
  }

  // No participants to resolve. That happens for real: a DM can arrive with an
  // empty `participantPubkeys`, and this fallback then handed back the raw
  // name — which for these channels is the peer's 64-hex key, printed in full
  // across the header and the sidebar.
  //
  // The name is itself the peer's pubkey, so it is enough to resolve from. A
  // known profile gives the person's name; an unknown one gives a truncated
  // key, which is what every other unidentified account in the app shows.
  if (isPubkeyName(channel.name)) {
    return resolveUserLabel({
      currentPubkey,
      profiles,
      pubkey: channel.name.trim().toLowerCase(),
    });
  }

  return channel.name;
}
