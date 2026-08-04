import { BUSINESS_TAXONOMY_PART_1 } from "./part1";
import { BUSINESS_TAXONOMY_PART_2 } from "./part2";
import { BUSINESS_TAXONOMY_PART_3 } from "./part3";
import { BUSINESS_TAXONOMY_PART_4 } from "./part4";
import { BUSINESS_TAXONOMY_PART_5 } from "./part5";
import { BUSINESS_TAXONOMY_PART_6 } from "./part6";

export type {
  BusinessTaxonomyIndustry,
  BusinessTaxonomyVertical,
} from "./types";

export const BUSINESS_TAXONOMY = [
  ...BUSINESS_TAXONOMY_PART_1,
  ...BUSINESS_TAXONOMY_PART_2,
  ...BUSINESS_TAXONOMY_PART_3,
  ...BUSINESS_TAXONOMY_PART_4,
  ...BUSINESS_TAXONOMY_PART_5,
  ...BUSINESS_TAXONOMY_PART_6,
] as const;
