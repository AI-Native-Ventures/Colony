/**
 * Mo's Auto Repairs in Soweto, the example business in explainer 6. Its new
 * page follows the car repair sites picked on Pinterest (2026-10-12): a
 * charcoal page, one red for action, tall condensed capitals, the price
 * and the opening hours up front, a call strip on top.
 */
export const MO = {
  name: "Mo's Auto Repairs",
  domain: "mosautorepairs.co.za",
  phone: "011 345 6789",
  place: "Soweto",
  since: 2009,
} as const;

/** What the old page still says. */
export const MO_OLD = {
  service: "R1,250",
  hours: "Mon to Fri, 8:00 to 17:00",
} as const;

/** What the owner told the employee: the new price, and Saturdays. */
export const MO_NOW = {
  service: "R1,450",
  saturday: "8:00 to 13:00",
} as const;

export const MO_COLORS = {
  page: "#15171c",
  panel: "#1f2229",
  line: "#2d3139",
  red: "#e53935",
  redDeep: "#b3261e",
  text: "#ffffff",
  muted: "#a9afba",
} as const;

/** The service tiles under the prices. */
export const MO_SERVICES = [
  { title: "Brakes", price: "From R650" },
  { title: "Tyres", price: "From R899" },
  { title: "Diagnostics", price: "R350" },
  { title: "Aircon regas", price: "R550" },
] as const;
