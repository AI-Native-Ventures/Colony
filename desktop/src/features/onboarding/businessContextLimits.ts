/** Matches the canonical company contract's Unicode character limits. */
export const BUSINESS_SUMMARY_MAX_LENGTH = 4_000;
/** Maximum trading-name length in the canonical company profile. */
export const BUSINESS_NAME_MAX_LENGTH = 200;

/** Rust validates Unicode scalar values; UTF-16 string.length counts emoji twice. */
export function businessTextLength(value: string): number {
  return Array.from(value).length;
}
