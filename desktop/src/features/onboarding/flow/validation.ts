// desktop/src/features/onboarding/flow/validation.ts

/**
 * Minimum password length.
 *
 * Must stay >= `MIN_PASSPHRASE_LEN` in `desktop/src-tauri/src/key_backup.rs`
 * (12). Signup encrypts the identity under this password before it posts
 * anything, so a password this screen accepts but the backup command rejects
 * fails locally, and `authService` reports every untyped throw as
 * `unreachable` — "We could not reach your workspace" for a password that was
 * simply two characters short. Observed 2026-08-27: a 10-character password
 * produced that message on every attempt, with no request ever leaving the
 * machine.
 */
export const PASSWORD_MIN = 12;
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
