/**
 * Local images used by the fixture-backed Discovery hierarchy.
 *
 * Keep this registry keyed by the stable `imageKey` values in the discovery
 * read models. Components should not derive public paths from labels or slugs;
 * that keeps the fixture contract safe to replace with a provider later.
 */
export const DISCOVERY_ASSETS = {
  "industry.automotive": "/discovery/industries/automotive.png",
  "industry.professional-services":
    "/discovery/industries/professional-services.png",
  "industry.agriculture": "/discovery/industries/agriculture.png",
  "industry.aviation-airlines": "/discovery/industries/aviation-airlines.png",
  "vertical.auto-repair": "/discovery/verticals/auto-repair.png",
  "vertical.car-dealerships": "/discovery/verticals/car-dealerships.png",
  "vertical.collision-repair": "/discovery/verticals/collision-repair.png",
} as const;

export const DISCOVERY_ASSET_FALLBACK = "/discovery/industries/automotive.png";

/** Resolve a fixture image key to a local public asset. */
export function resolveDiscoveryAsset(key: string): string {
  return (
    DISCOVERY_ASSETS[key as keyof typeof DISCOVERY_ASSETS] ??
    DISCOVERY_ASSET_FALLBACK
  );
}
