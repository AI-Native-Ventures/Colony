import { useQuery } from "@tanstack/react-query";
import { relaySupportsDiscovery } from "@/features/discovery/data/relayDiscoverySupport";
import { canStartDiscovery } from "@/features/discovery/entitlement";
import { assertFirstJobScope } from "./firstJobScope";
import type { FirstJobScope } from "./firstJobStart";

/** Keep an optional starter's availability inside the current account and business. */
export function firstJobDiscoveryKey(
  scope: FirstJobScope,
  communityId: string,
) {
  return [
    "first-job-discovery",
    scope.ownerPubkey,
    scope.relayUrl,
    communityId,
  ] as const;
}

/** Read existing Discovery access; this never creates a campaign or starts work. */
export function useFirstJobDiscovery(
  scope: FirstJobScope,
  communityId: string,
  enabled: boolean,
) {
  const query = useQuery({
    queryKey: firstJobDiscoveryKey(scope, communityId),
    enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      await assertFirstJobScope(scope);
      const supported = await relaySupportsDiscovery();
      await assertFirstJobScope(scope);
      if (!supported) return false;
      const { createRelayDiscoveryDataSource } = await import(
        "@/features/discovery/data/RelayDiscoveryDataSource"
      );
      await assertFirstJobScope(scope);
      const entitlement =
        await createRelayDiscoveryDataSource().getEntitlement();
      await assertFirstJobScope(scope);
      return canStartDiscovery(entitlement);
    },
  });
  return query.isSuccess && query.data === true;
}
