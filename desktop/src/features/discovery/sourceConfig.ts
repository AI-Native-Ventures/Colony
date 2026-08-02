export const DISCOVERY_SOURCES = [
  { key: "google_maps", label: "Outscraper (Google Maps)" },
  { key: "dataforseo", label: "Business Listings (DataForSEO)" },
  { key: "brave_search", label: "Brave Web Search" },
  { key: "exa_search", label: "Exa Neural Search" },
  { key: "openstreetmap", label: "OpenStreetMap (free)" },
  { key: "directories", label: "Saved Directories" },
  { key: "linkedin_company_search", label: "HarvestAPI (LinkedIn, paid)" },
] as const;

export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number]["key"];

export const DISCOVERY_SOURCE_LABELS: Record<DiscoverySource, string> =
  Object.fromEntries(
    DISCOVERY_SOURCES.map(({ key, label }) => [key, label]),
  ) as Record<DiscoverySource, string>;

export type DiscoveryMode = "concurrent" | "waterfall";

export type CampaignSourceConfig = {
  mode: DiscoveryMode;
  /** Enabled sources, in execution order. */
  order: DiscoverySource[];
  registry?: boolean;
};

export const DEFAULT_SOURCE_CONFIG: CampaignSourceConfig = {
  mode: "waterfall",
  order: [
    "google_maps",
    "dataforseo",
    "brave_search",
    "exa_search",
    "openstreetmap",
    "directories",
  ],
};

const sourceSet = new Set<DiscoverySource>(
  DISCOVERY_SOURCES.map(({ key }) => key),
);

function isDiscoverySource(value: unknown): value is DiscoverySource {
  return typeof value === "string" && sourceSet.has(value as DiscoverySource);
}

export function isValidSourceConfig(
  value: unknown,
): value is CampaignSourceConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CampaignSourceConfig>;
  if (candidate.mode !== "concurrent" && candidate.mode !== "waterfall") {
    return false;
  }
  if (!Array.isArray(candidate.order) || candidate.order.length === 0) {
    return false;
  }
  const unique = new Set(candidate.order);
  return (
    unique.size === candidate.order.length &&
    candidate.order.every(isDiscoverySource) &&
    (candidate.registry === undefined ||
      typeof candidate.registry === "boolean")
  );
}

export function resolveSourceConfig(value?: unknown): CampaignSourceConfig {
  if (!isValidSourceConfig(value)) {
    return {
      mode: DEFAULT_SOURCE_CONFIG.mode,
      order: [...DEFAULT_SOURCE_CONFIG.order],
    };
  }
  return {
    mode: value.mode,
    order: [...value.order],
    ...(value.registry === undefined ? {} : { registry: value.registry }),
  };
}

export function toggleSource(
  config: CampaignSourceConfig,
  source: DiscoverySource,
): CampaignSourceConfig {
  const current = resolveSourceConfig(config);
  const enabled = current.order.includes(source);
  if (enabled && current.order.length === 1) return current;
  return {
    ...current,
    order: enabled
      ? current.order.filter((key) => key !== source)
      : [...current.order, source],
  };
}

export function canReorderSources(config: CampaignSourceConfig): boolean {
  return (
    config.mode === "waterfall" &&
    config.order.length > 1 &&
    config.order.every(isDiscoverySource)
  );
}

export function moveSource(
  config: CampaignSourceConfig,
  source: DiscoverySource,
  target: DiscoverySource,
): CampaignSourceConfig;
export function moveSource(
  config: CampaignSourceConfig,
  fromIndex: number,
  toIndex: number,
): CampaignSourceConfig;
export function moveSource(
  config: CampaignSourceConfig,
  sourceOrIndex: DiscoverySource | number,
  targetOrIndex: DiscoverySource | number,
): CampaignSourceConfig {
  const current = resolveSourceConfig(config);
  if (!canReorderSources(current)) return current;

  const fromIndex =
    typeof sourceOrIndex === "number"
      ? sourceOrIndex
      : current.order.indexOf(sourceOrIndex);
  const toIndex =
    typeof targetOrIndex === "number"
      ? targetOrIndex
      : current.order.indexOf(targetOrIndex);
  if (
    fromIndex < 0 ||
    fromIndex >= current.order.length ||
    toIndex < 0 ||
    toIndex >= current.order.length ||
    fromIndex === toIndex
  ) {
    return current;
  }

  const order = [...current.order];
  const [moved] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, moved);
  return { ...current, order };
}
