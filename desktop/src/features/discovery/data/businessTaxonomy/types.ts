export type BusinessTaxonomyVertical = {
  /** Stable lowercase identifier. Unique within its industry only, so a
   * mentionable vertical ID composes as `<industry-id>/<vertical-id>`. */
  id: string;
  label: string;
  description?: string;
};

export type BusinessTaxonomyIndustry = {
  /** Stable lowercase identifier; globally unique in the canonical file. */
  id: string;
  label: string;
  description?: string;
  verticals: BusinessTaxonomyVertical[];
};
