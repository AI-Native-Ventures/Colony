/**
 * Rise Bakery, the business in explainer 5. Its posts follow the bakery
 * posts picked on Pinterest (2026-10-11): a cream scallop badge with a royal
 * blue serif and a "7AM" sticker, a red hand-lettered pop-up poster, and a
 * beige sourdough card set in serif capitals.
 */
export const RISE = {
  name: "Rise Bakery",
  place: "Melville",
  handle: "@risebakery",
} as const;

export const RISE_COLORS = {
  cream: "#f7ecd9",
  paper: "#fbf5ea",
  butter: "#f5d27a",
  crust: "#c8843a",
  cocoa: "#4a2c1a",
  blue: "#2a45c9",
  red: "#e0402f",
} as const;

export type RisePostId = "sourdough" | "market" | "croissant";

/** This week's three posts, in the order they go out. */
export const RISE_POSTS: readonly { id: RisePostId; when: string }[] = [
  { id: "sourdough", when: "Tue 7:00" },
  { id: "market", when: "Thu 12:30" },
  { id: "croissant", when: "Sat 6:30" },
];
