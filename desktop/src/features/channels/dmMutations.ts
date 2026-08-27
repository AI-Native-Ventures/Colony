import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import { dmVisibilityQueryKeyFor } from "@/features/channels/useHiddenDmIds";
import { useIdentityQuery } from "@/shared/api/hooks";
import { hideDm, openDm } from "@/shared/api/tauriChannels";
import type { Channel, OpenDmInput } from "@/shared/api/types";
import * as React from "react";

import {
  channelsQueryKey,
  reconcileRefreshedCachedChannel,
  upsertCachedChannel,
} from "@/features/channels/hooks";

/**
 * DM visibility mutations: opening a DM clears its hidden flag, hiding one sets
 * it, and both reconcile the cached visibility set so a live message can
 * resurface the conversation (#6885). Split out of `hooks.ts` for the desktop
 * file-size ratchet.
 */
export function useOpenDmMutation() {
  const queryClient = useQueryClient();
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const dmVisibilityKey = dmVisibilityQueryKeyFor(
    activeCommunity?.relayUrl,
    identityQuery.data?.pubkey,
  );

  return useMutation({
    mutationFn: (input: OpenDmInput) => openDm(input),
    onSuccess: (openedChannel) => {
      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current) =>
        upsertCachedChannel(current, openedChannel),
      );
      queryClient.setQueryData<Set<string>>(dmVisibilityKey, (current) => {
        const next = new Set(current);
        next.delete(openedChannel.id);
        return next;
      });
    },
    onSettled: () => {
      // The relay-returned DM is already in the cache. Mark the list stale so
      // the normal live/poll refresh can reconcile it later without putting a
      // full get_channels round-trip on the critical path to the conversation.
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKey,
        refetchType: "none",
      });
      void queryClient.invalidateQueries({ queryKey: dmVisibilityKey });
    },
  });
}

/**
 * Reasserts a relay-returned channel in the shared cache before a caller
 * depends on it for navigation. The open-DM mutation already made the relay
 * write authoritative, so cancel any older list read and stay local rather
 * than blocking on a read-after-write channel-list refresh.
 */
export function useUpsertCachedChannel() {
  const queryClient = useQueryClient();

  return React.useCallback(
    async (channel: Channel) => {
      await queryClient.cancelQueries({
        queryKey: channelsQueryKey,
        exact: true,
      });
      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current) =>
        reconcileRefreshedCachedChannel(current, channel),
      );
    },
    [queryClient],
  );
}

export function useHideDmMutation() {
  const queryClient = useQueryClient();
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const dmVisibilityKey = dmVisibilityQueryKeyFor(
    activeCommunity?.relayUrl,
    identityQuery.data?.pubkey,
  );

  return useMutation({
    mutationFn: (channelId: string) => hideDm(channelId),
    onMutate: async (channelId) => {
      await queryClient.cancelQueries({ queryKey: channelsQueryKey });
      const previous = queryClient.getQueryData<Channel[]>(channelsQueryKey);
      queryClient.setQueryData<Channel[]>(channelsQueryKey, (current = []) =>
        current.filter((channel) => channel.id !== channelId),
      );
      return { previous };
    },
    onError: (_error, _channelId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(channelsQueryKey, context.previous);
      }
    },
    onSuccess: (_data, channelId) => {
      queryClient.setQueryData<Set<string>>(dmVisibilityKey, (current) =>
        new Set(current).add(channelId),
      );
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: channelsQueryKey }),
        queryClient.invalidateQueries({ queryKey: dmVisibilityKey }),
      ]);
    },
  });
}
