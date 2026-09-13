import * as React from "react";
import { useCommunities } from "@/features/communities/useCommunities";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import { useWebsiteHeadsForCommunity } from "./useWebsiteHeads";
import { ensureWebsiteEvidenceGrants } from "./websiteEvidenceGrant";

/** Reconcile only the active community's verified jobs, independent of cards. */
export function useWebsiteEvidenceGrantReconciliation(
  channels: readonly { id: string }[],
): void {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? null;
  const relayUrl = activeCommunity?.relayUrl ?? null;
  const relaySelf = useRelaySelfQuery(Boolean(communityId)).data ?? null;
  const channelIds = React.useMemo(() => channels.map((row) => row.id), [channels]);
  const heads = useWebsiteHeadsForCommunity({
    communityId,
    channelIds,
    relaySelfPubkey: relaySelf?.toLowerCase() ?? null,
  });
  React.useEffect(() => {
    if (!communityId || !relayUrl) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconcile = async () => {
      await Promise.allSettled(
        heads.map((head) => ensureWebsiteEvidenceGrants({ communityId, relayUrl, head })),
      );
      // Workers may start after the head arrives. Native authority revalidates
      // assignment and process generation on every request and every use.
      if (!disposed) timer = setTimeout(() => void reconcile(), 10_000);
    };
    if (heads.length > 0) void reconcile();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [communityId, relayUrl, heads]);
}
