export type DiscoveryEntitlementState =
  | "loading"
  | "entitled"
  | "not_entitled"
  | "error";

export type DiscoveryEntitlement = {
  feature: "discovery_engine";
  state: DiscoveryEntitlementState;
  manageUrl?: string;
  /** Whether this read model is the cost-free preview or persisted live data. */
  experience?: "demo" | "live";
};

export function canStartDiscovery(
  entitlement: Pick<DiscoveryEntitlement, "state">,
): boolean {
  return entitlement.state === "entitled";
}
