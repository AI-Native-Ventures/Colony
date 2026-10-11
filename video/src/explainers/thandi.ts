import type { Rect } from "./approve.ts";

/**
 * Thandi's Kitchen, a caterer in Durban, the example business in explainer
 * 8. Its wedding menu follows the menu cards picked on Pinterest
 * (2026-10-12): an ivory card, a gold script "Menu", a sage sprig, spaced
 * capitals for each course, the dishes centred in a serif.
 */
export const THANDI = { name: "Thandi's Kitchen", place: "Durban" } as const;

export const WEDDING = { couple: "Zanele & Sipho" } as const;

export type Course = {
  course: string;
  dishes: readonly { name: string; veg?: boolean }[];
};

/** The first menu: no vegetarian choice. */
export const MENU_BEFORE: readonly Course[] = [
  { course: "Starter", dishes: [{ name: "Prawn cocktail" }] },
  { course: "Main", dishes: [{ name: "Lamb curry, saffron rice" }] },
  { course: "Dessert", dishes: [{ name: "Malva pudding" }] },
];

/** The menu after the owner's reply: a vegetarian choice in every course, marked with a leaf. */
export const MENU_AFTER: readonly Course[] = [
  { course: "Starter", dishes: [{ name: "Roast butternut soup", veg: true }] },
  {
    course: "Main",
    dishes: [{ name: "Lamb curry" }, { name: "or chickpea curry", veg: true }],
  },
  { course: "Dessert", dishes: [{ name: "Malva pudding", veg: true }] },
];

/** The chats, one per topic, as the owner's sidebar lists them. */
export const THREADS = [
  { name: "Weddings", preview: "Menu for Zanele & Sipho", icon: "heart" },
  { name: "Office lunches", preview: "Friday order for 40", icon: "fork" },
  { name: "Website", preview: "New photos are up", icon: "globe" },
] as const;

export type ThreadIcon = (typeof THREADS)[number]["icon"];

/** The chat card, where the film's cards sit. */
export const CHAT_CARD: Rect = { x: 860, y: 150, w: 940, h: 760 };
export const SIDEBAR_W = 300;
export const THREAD_HEADER_H = 92;
/** The thread's own pixels map to the panel from here, less the scroll. */
export const THREAD_ORIGIN = {
  x: CHAT_CARD.x + SIDEBAR_W,
  y: CHAT_CARD.y + THREAD_HEADER_H,
};
export const THREAD_VIEW_H = CHAT_CARD.h - THREAD_HEADER_H;

/** Where things sit in the thread, thread pixels. */
export const THREAD = {
  firstMenu: { x: 90, y: 100, w: 280, h: 420 },
  reply: { y: 540 },
  second: { y: 684 },
  secondMenu: { x: 90, y: 760, w: 280, h: 420 },
  approve: { x: 400, y: 1100, w: 200, h: 60 },
  /** How far the thread scrolls when the new menu comes back. */
  scroll: 520,
} as const;

/** The Approve button once the thread has scrolled, panel pixels. */
export const CHAT_APPROVE: Rect = {
  x: THREAD_ORIGIN.x + THREAD.approve.x,
  y: THREAD_ORIGIN.y + THREAD.approve.y - THREAD.scroll,
  w: THREAD.approve.w,
  h: THREAD.approve.h,
};
