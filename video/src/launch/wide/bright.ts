/**
 * Bright Plumbing, the example business in the film. Its posts and website
 * follow the plumbing designs the owner pointed to on Pinterest (2026-10-11):
 * navy and royal blue with an orange call to action, tall bold capitals,
 * a phone number and a booking button on everything.
 */
export const BRIGHT = {
  name: "Bright Plumbing",
  phone: "011 234 5678",
  domain: "brightplumbing.co.za",
} as const;

export const BRIGHT_COLORS = {
  navy: "#0b1f44",
  blue: "#1d5bff",
  deep: "#0f3fc4",
  sky: "#eaf1ff",
  mist: "#f5f8fd",
  orange: "#ff7a1a",
  muted: "#5b6782",
  line: "#e3e9f3",
  steelLight: "#eef2f7",
  steel: "#b9c4d2",
  steelDark: "#7b8899",
} as const;

export type ServiceIcon = "drop" | "drain" | "geyser";

export type Service = { title: string; price: string; icon: ServiceIcon };

/** The winter geyser check, as the post and the site both price it. */
export const GEYSER_PRICE = "R450";

/** What the new site offers, with prices, as the posts promise. */
export const SITE_SERVICES: readonly Service[] = [
  { title: "Leak repair", price: "From R350", icon: "drop" },
  { title: "Geyser service", price: `From ${GEYSER_PRICE}`, icon: "geyser" },
  { title: "Drain cleaning", price: "From R400", icon: "drain" },
];

/** The trust strip under the hero. */
export const SITE_TRUST = [
  "Licensed and insured",
  "12 years in Sandton",
  "Same-day call-outs",
  "Upfront prices",
] as const;

/** The website card, in panel pixels; the page sits under a browser bar. */
export const SITE_CARD = { x: 860, y: 150, w: 940, h: 760 };
export const SITE_BAR = 64;
export const PAGE_H = SITE_CARD.h - SITE_BAR;

export type Band = { top: number; bottom: number };

/** The new page, top to bottom, in page pixels. */
export const SITE_BANDS = {
  header: { top: 0, bottom: 68 },
  hero: { top: 68, bottom: 392 },
  trust: { top: 392, bottom: 444 },
  services: { top: 444, bottom: 622 },
  cta: { top: 622, bottom: PAGE_H },
} as const satisfies Record<string, Band>;

/** The painter walks along the call-to-action band at the foot of the page. */
export const PAINT_Y = SITE_CARD.y + SITE_CARD.h - 44;
