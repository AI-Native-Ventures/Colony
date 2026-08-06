import type { DiscoveryEntitlement } from "../entitlement";

/** Entitlement fallback when the relay predates Discovery kinds, else null. */
export function unsupportedDiscoveryEntitlement(
  error: unknown,
): DiscoveryEntitlement | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.toLowerCase().includes("unknown event kind")) return null;
  return {
    feature: "discovery_engine",
    state: "not_entitled",
    experience: "demo",
  };
}
