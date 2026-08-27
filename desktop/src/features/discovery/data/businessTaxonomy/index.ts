import canonicalTaxonomy from "../../../../../../crates/buzz-core/assets/discovery/business_taxonomy.json";

import type { BusinessTaxonomyIndustry } from "./types";

export type {
  BusinessTaxonomyIndustry,
  BusinessTaxonomyVertical,
} from "./types";

/**
 * The canonical Business Discovery taxonomy, imported from the crate that
 * also embeds it (`crates/buzz-core/assets/discovery/business_taxonomy.json`).
 * It lives crate-side because container builds ship only `crates/`, while
 * this bundle can import across the repo. One editable copy either way: any
 * edit must update the parity hash in `discovery_taxonomy.rs` in the same
 * commit, so a one-sided change fails CI instead of drifting.
 */
export const BUSINESS_TAXONOMY =
  canonicalTaxonomy as BusinessTaxonomyIndustry[];
