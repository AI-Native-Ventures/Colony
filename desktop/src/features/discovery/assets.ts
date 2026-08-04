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
    "/discovery/industries/professional-services-premium.png",
  "industry.agriculture": "/discovery/industries/agriculture.png",
  "industry.aviation-airlines": "/discovery/industries/aviation-airlines.png",
  "industry.aerospace-defense": "/discovery/industries/aerospace-defense.png",
  "industry.beauty-wellness": "/discovery/industries/beauty-wellness.png",
  "industry.chemicals": "/discovery/industries/chemicals.png",
  "industry.construction": "/discovery/industries/construction.png",
  "industry.education": "/discovery/industries/education-premium.png",
  "industry.energy": "/discovery/industries/energy.png",
  "industry.environmental-services":
    "/discovery/industries/environmental-services.png",
  "industry.fashion-apparel":
    "/discovery/industries/fashion-apparel-premium.png",
  "industry.home-living": "/discovery/industries/home-living-premium.png",
  "industry.financial-services": "/discovery/industries/finance.png",
  "industry.finance": "/discovery/industries/finance.png",
  "industry.food-beverage": "/discovery/industries/food-beverage-premium.png",
  "industry.gambling-casinos": "/discovery/industries/gambling-casinos.png",
  "industry.government-public-sector":
    "/discovery/industries/government-public-sector.png",
  "industry.healthcare": "/discovery/industries/healthcare-premium.png",
  "industry.human-resources": "/discovery/industries/human-resources.png",
  "industry.insurance": "/discovery/industries/insurance.png",
  "industry.legal": "/discovery/industries/legal-premium.png",
  "industry.manufacturing": "/discovery/industries/manufacturing.png",
  "industry.marine-ports": "/discovery/industries/marine-ports.png",
  "industry.marketing-advertising":
    "/discovery/industries/marketing-advertising-premium.png",
  "industry.media-entertainment":
    "/discovery/industries/media-entertainment.png",
  "industry.mining": "/discovery/industries/mining.png",
  "industry.mining-resources": "/discovery/industries/mining.png",
  "industry.non-profit": "/discovery/industries/non-profit.png",
  "industry.pharmaceuticals-life-sciences":
    "/discovery/industries/pharmaceuticals-life-sciences.png",
  "industry.real-estate": "/discovery/industries/real-estate-premium.png",
  "industry.retail": "/discovery/industries/retail.png",
  "industry.security": "/discovery/industries/security.png",
  "industry.technology": "/discovery/industries/technology-premium.png",
  "industry.telecommunications": "/discovery/industries/telecommunications.png",
  "industry.tourism": "/discovery/industries/tourism.png",
  "industry.hospitality": "/discovery/industries/tourism.png",
  "industry.transportation": "/discovery/industries/transportation.png",
  // SalesTeams uses the parent Automotive image for the vertical catalog and
  // its campaign drawer. Keep that visual contract until vertical-specific
  // artwork exists in the source product.
  "vertical.auto-repair": "/discovery/industries/automotive.png",
  "vertical.auto-manufacturing": "/discovery/industries/automotive.png",
  "vertical.auto-parts-stores": "/discovery/industries/automotive.png",
  "vertical.auto-parts-suppliers": "/discovery/industries/automotive.png",
  "vertical.car-dealerships": "/discovery/industries/automotive.png",
  "vertical.car-rentals": "/discovery/industries/automotive.png",
  "vertical.engine-repair-garages": "/discovery/industries/automotive.png",
  "vertical.fleet-vehicle-leasing-services":
    "/discovery/industries/automotive.png",
  "vertical.panel-beaters": "/discovery/industries/automotive.png",
  "vertical.petrol-stations": "/discovery/industries/automotive.png",
  "field.engineering": "/discovery/industries/technology-premium.png",
  "field.marketing": "/discovery/industries/marketing-advertising-premium.png",
  "field.medicine": "/discovery/industries/healthcare-premium.png",
  "field.law": "/discovery/industries/legal-premium.png",
  "field.finance": "/discovery/industries/finance.png",
  "field.sales": "/discovery/industries/professional-services-premium.png",
  "field.human-resources": "/discovery/industries/human-resources.png",
  "field.accounting": "/discovery/industries/finance.png",
  "field.agriculture": "/discovery/industries/agriculture.png",
  "field.politics": "/discovery/industries/government-public-sector.png",
  "field.education": "/discovery/industries/education-premium.png",
  "field.design": "/discovery/industries/media-entertainment.png",
  "field.research": "/discovery/industries/pharmaceuticals-life-sciences.png",
  "field.consulting": "/discovery/industries/professional-services-premium.png",
  "field.operations": "/discovery/industries/manufacturing.png",
  "field.product-management": "/discovery/industries/technology-premium.png",
  "field.customer-success":
    "/discovery/industries/professional-services-premium.png",
  "field.data-science": "/discovery/industries/technology-premium.png",
} as const;

export const DISCOVERY_ASSET_FALLBACK = "/discovery/industries/automotive.png";

/** Resolve a fixture image key to a local public asset. */
export function resolveDiscoveryAsset(key: string): string {
  return (
    DISCOVERY_ASSETS[key as keyof typeof DISCOVERY_ASSETS] ??
    DISCOVERY_ASSET_FALLBACK
  );
}
