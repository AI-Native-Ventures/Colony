import { invokeTauri } from "@/shared/api/tauri";

import type { DiscoveryEntitlement } from "../entitlement";

/** Fallback entitlement when the relay answers NIP-11 and does not advertise
 * the Discovery capability. */
export const DEMO_DISCOVERY_ENTITLEMENT: DiscoveryEntitlement = {
  feature: "discovery_engine",
  state: "not_entitled",
  experience: "demo",
};

/**
 * Ask the active relay whether its NIP-11 document advertises the
 * `colony-discovery` capability.
 *
 * Resolves `false` only when the relay answers and does not advertise it.
 * Rejects when the relay is unreachable, answers with a non-success status,
 * or serves a malformed document, so callers treat "unknown" as an error,
 * never as "does not support".
 */
export function relaySupportsDiscovery(): Promise<boolean> {
  return invokeTauri<boolean>("get_relay_discovery_support");
}
