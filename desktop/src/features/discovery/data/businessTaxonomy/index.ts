import canonicalTaxonomy from "./business_taxonomy.json";

import type { BusinessTaxonomyIndustry } from "./types";

export type {
  BusinessTaxonomyIndustry,
  BusinessTaxonomyVertical,
} from "./types";

/**
 * The canonical Business Discovery taxonomy, loaded verbatim from the shared
 * repo asset that the Rust relay embeds (`crates/buzz-core/src/
 * discovery_taxonomy.rs`). Neither runtime may edit its copy: a one-sided
 * change fails the parity hash test on the Rust side instead of drifting.
 */
export const BUSINESS_TAXONOMY =
  canonicalTaxonomy as BusinessTaxonomyIndustry[];
