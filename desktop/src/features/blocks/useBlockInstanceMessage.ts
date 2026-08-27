import { useQuery } from "@tanstack/react-query";

import type { TimelineMessage } from "@/features/messages/types";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_BLOCK_ACTION,
  KIND_BLOCK_RECEIPT,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";

import { buildBlockInstanceState } from "./blockInstanceState";
import { isBlockMessage } from "./blockTags";

const AUX_LIMIT = 200;

export type BlockInstanceMessageRequest = {
  communityId: string;
  eventId: string;
};

export function blockInstanceMessageQueryKey(
  request: BlockInstanceMessageRequest | null,
) {
  return [
    "block-instance-message",
    request?.communityId ?? "",
    request?.eventId ?? "",
  ] as const;
}

function timelineMessageFor(
  instanceEvent: RelayEvent,
  auxEvents: readonly RelayEvent[],
): TimelineMessage {
  const blockState = buildBlockInstanceState(instanceEvent, auxEvents);
  return {
    id: instanceEvent.id,
    createdAt: instanceEvent.created_at,
    signerPubkey: instanceEvent.pubkey.toLowerCase(),
    pubkey: instanceEvent.pubkey,
    author: "",
    time: "",
    body: instanceEvent.content,
    depth: 0,
    kind: instanceEvent.kind,
    tags: instanceEvent.tags,
    blockEvent: instanceEvent,
    ...(blockState ? { blockState } : {}),
  };
}

/**
 * Loads one Block instance as a timeline message so a surface outside a channel
 * can hand it to the ordinary Block renderer.
 *
 * The home feed carries a Block only as its plain-text fallback plus tags, with
 * no signature, and {@link isAuthorizedBlockReceipt} will not admit a receipt
 * whose instance event cannot be verified. So the signed instance is refetched
 * by id, together with the actions and receipts that reference it, and the
 * result goes through the same authority gauntlet the timeline uses.
 *
 * Returns `null` when the relay no longer holds the event or it is not a Block,
 * which callers should surface as "no longer available" rather than an error.
 */
export function useBlockInstanceMessage(
  request: BlockInstanceMessageRequest | null,
) {
  return useQuery<TimelineMessage | null>({
    queryKey: blockInstanceMessageQueryKey(request),
    queryFn: async () => {
      if (!request) throw new Error("Block instance request is unavailable");
      const [instances, auxEvents] = await Promise.all([
        relayClient.fetchEvents({
          ids: [request.eventId],
          kinds: [KIND_STREAM_MESSAGE],
          limit: 1,
        }),
        relayClient.fetchEvents({
          kinds: [KIND_BLOCK_ACTION, KIND_BLOCK_RECEIPT],
          "#e": [request.eventId],
          limit: AUX_LIMIT,
        }),
      ]);
      const instanceEvent = instances.find(
        (event) =>
          event.id.toLowerCase() === request.eventId.toLowerCase() &&
          isBlockMessage(event),
      );
      if (!instanceEvent) return null;
      return timelineMessageFor(instanceEvent, auxEvents);
    },
    enabled: request !== null,
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}
