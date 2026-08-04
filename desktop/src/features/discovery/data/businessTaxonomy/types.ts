export type BusinessTaxonomyVertical = {
  slug: string;
  name: string;
  description?: string;
};

export type BusinessTaxonomyIndustry = {
  slug: string;
  name: string;
  description?: string;
  verticals: readonly BusinessTaxonomyVertical[];
};
