/**
 * The owner's copy rules for the user videos (2026-10-12): no em dashes, no
 * promises of free work, no phone calls (not in the app), no prices in the
 * words (the app shows its own).
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/—/, "em dash"],
  [/\bfree\b/i, "promises something free"],
  [/\bcall(s|ed|ing)?\b/i, "phone calls are not in the app"],
  [/\bR\s?\d|\$\s?\d|\brands?\b/i, "a price in the words"],
];

/** Every rule `text` breaks, in plain words; empty when it is clean. */
export function copyProblems(text: string): string[] {
  return RULES.filter(([rule]) => rule.test(text)).map(
    ([, why]) => `${why}: "${text}"`,
  );
}
