import type { ChannelMember, RelayEvent } from "@/shared/api/types";
import type { OpenDmInput } from "@/shared/api/types";
import {
  dmPeerPubkeysFromMembers,
  isIncomingChannelMessageFromOther,
  relayEventChannelId,
} from "./dmResurface";

type HiddenDmResurfaceActionOptions = {
  event: RelayEvent;
  expectedSignerPubkey: string;
  hiddenDmIds: ReadonlySet<string>;
  fetchMembers: (channelId: string) => Promise<readonly ChannelMember[]>;
  isCurrent: () => boolean;
  reopen: (input: OpenDmInput) => Promise<{ id: string }>;
};

export async function resurfaceHiddenDmMessage({
  event,
  expectedSignerPubkey,
  hiddenDmIds,
  fetchMembers,
  isCurrent,
  reopen,
}: HiddenDmResurfaceActionOptions): Promise<boolean> {
  if (!isIncomingChannelMessageFromOther(event, expectedSignerPubkey)) {
    return false;
  }
  const channelId = relayEventChannelId(event);
  if (!channelId || !hiddenDmIds.has(channelId)) return false;

  const members = await fetchMembers(channelId);
  if (!isCurrent()) return false;
  const pubkeys = dmPeerPubkeysFromMembers(members, expectedSignerPubkey);
  if (pubkeys.length === 0) return false;

  // Colony's open_dm takes only `pubkeys` (upstream's tenant fence on the
  // command is not ported), so the scope check stays on this side.
  const opened = await reopen({ pubkeys });
  if (!isCurrent()) return false;
  if (opened.id !== channelId) {
    throw new Error("Relay reopened a different DM conversation.");
  }
  return true;
}
