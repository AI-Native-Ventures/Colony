import { normalizePubkey } from "./pubkey";

const IDENTITY_COLOURS = [
  "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100",
  "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-100",
  "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100",
  "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100",
  "bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-100",
] as const;

/** Stable avatar fallback colours, independent of display names and accents. */
export function identityColourClass(identity: string): string {
  let hash = 0;
  for (const character of normalizePubkey(identity)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return IDENTITY_COLOURS[hash % IDENTITY_COLOURS.length];
}
