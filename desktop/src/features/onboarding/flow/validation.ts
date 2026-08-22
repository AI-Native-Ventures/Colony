// desktop/src/features/onboarding/flow/validation.ts

/** Minimum password length. Mirrors the spec. */
export const PASSWORD_MIN = 10;
/** Minimum business description length. Mirrors the spec. */
export const DESCRIPTION_MIN = 20;

/**
 * Deliberately loose. These rules exist to catch a typo, not to argue with
 * anyone about what a valid address looks like.
 */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((value ?? "").trim());
}

export function passwordShortfall(value: string): number {
  return Math.max(0, PASSWORD_MIN - (value ?? "").length);
}

function stripScheme(value: string): string {
  return (value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

export function isWebsite(value: string): boolean {
  return /^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(stripScheme(value));
}

export function normaliseWebsite(value: string): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${stripScheme(trimmed)}`;
}

export function descriptionShortfall(value: string): number {
  return Math.max(0, DESCRIPTION_MIN - (value ?? "").trim().length);
}
