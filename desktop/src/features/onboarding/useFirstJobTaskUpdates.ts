import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { taskQueryKey } from "@/features/company/hooks";
import { loadActiveCommunityId } from "@/features/communities/communityStorage";
import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import { assertFirstJobScope } from "./firstJobScope";
import type { FirstJobScope } from "./firstJobStart";
import { createFirstJobTaskUpdates } from "./firstJobTaskUpdates";

const updatesByClient = new WeakMap<
  QueryClient,
  ReturnType<typeof createFirstJobTaskUpdates>
>();

/** Keep both mounted copies of a sent job current through the existing Task query. */
export function useFirstJobTaskUpdates(
  scope: FirstJobScope,
  communityId: string,
  taskId: string | null,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const { ownerPubkey, relayUrl, channelId, threadRootId, requestId } = scope;
  useEffect(() => {
    if (!enabled || !taskId || !communityId) return;
    let updates = updatesByClient.get(queryClient);
    if (!updates) {
      updates = createFirstJobTaskUpdates({
        assertCurrent: async (captured) => {
          await assertFirstJobScope(captured);
          if (loadActiveCommunityId() !== captured.communityId)
            throw new Error("The active business has changed.");
        },
        relaySelf: getRelaySelf,
        subscribe: (filter, onEvent, onReady) =>
          relayClient.subscribeLive(filter, onEvent, onReady),
        invalidate: (captured) =>
          queryClient.invalidateQueries({
            queryKey: taskQueryKey(captured.communityId, captured.taskId),
            exact: true,
          }),
      });
      updatesByClient.set(queryClient, updates);
    }
    return updates.retain({
      ownerPubkey,
      relayUrl,
      channelId,
      threadRootId,
      requestId,
      communityId,
      taskId,
    });
  }, [
    queryClient,
    ownerPubkey,
    relayUrl,
    channelId,
    threadRootId,
    requestId,
    communityId,
    taskId,
    enabled,
  ]);
}
