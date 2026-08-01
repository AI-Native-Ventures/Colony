export type DiscoveryEntitlementState =
  | "loading"
  | "entitled"
  | "not_entitled"
  | "error";

export type DiscoveryEntitlement = {
  feature: "discovery_engine";
  state: DiscoveryEntitlementState;
  planName?: string;
  manageUrl?: string;
};

export function canStartDiscovery(
  entitlement: Pick<DiscoveryEntitlement, "state">,
): boolean {
  return entitlement.state === "entitled";
}
