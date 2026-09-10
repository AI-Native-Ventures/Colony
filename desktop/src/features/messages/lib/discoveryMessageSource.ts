import type { DiscoveryDataSource } from "@/features/discovery/data/DiscoveryDataSource";
import { createFixtureDiscoveryDataSource } from "@/features/discovery/data/FixtureDiscoveryDataSource";
import { createRelayDiscoveryDataSource } from "@/features/discovery/data/RelayDiscoveryDataSource";

/**
 * The Discovery source used from the message timeline and the composer.
 *
 * One instance per community, shared by every message row: each one otherwise
 * builds its own broker, and the entitlement read behind every workspace call
 * would be issued once per row on the screen. `e2e` builds serve the fixture
 * workspace so Playwright renders deterministic tiles with no relay.
 *
 * It is a module-level singleton holding community-scoped state, so
 * `resetCommunityState` clears it on a community change (see AGENTS.md,
 * "Community Switching").
 */
let sharedSource: DiscoveryDataSource | null = null;

export function discoveryMessageSource(): DiscoveryDataSource {
  if (!sharedSource) {
    sharedSource =
      import.meta.env.MODE === "e2e"
        ? createFixtureDiscoveryDataSource({ entitlement: "entitled" })
        : createRelayDiscoveryDataSource();
  }
  return sharedSource;
}

/** Drop the cached source so the next read builds one for the new community. */
export function resetDiscoveryMessageSource(): void {
  sharedSource = null;
}
