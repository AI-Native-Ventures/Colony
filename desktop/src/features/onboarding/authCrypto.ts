/**
 * Client-side derivation for email and password accounts.
 *
 * The password never leaves this computer. What goes to the relay is
 * `deriveAuthKey`'s output, which proves the password is known without
 * revealing it, and which is a different value from the one that unlocks the
 * saved account, so the relay learns nothing that helps it open the account.
 */

/** Crockford base32: no I, L, O or U, so a code cannot be misread. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PBKDF2_ITERATIONS = 600_000;
const GROUP_LEN = 5;
const GROUP_COUNT = 4;

/** Canonical form of an address: trimmed and lowercased. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/**
 * Canonical form of a password: NFKC, the same normalisation NIP-49 applies
 * before its scrypt.
 *
 * Without this, a composed and a decomposed spelling of the same accented
 * password derive different keys, so which one works depends on the keyboard
 * that typed it. iOS and macOS routinely produce decomposed text where other
 * sources produce composed.
 */
export function normalisePassword(password: string): string {
  return password.normalize("NFKC");
}

async function pbkdf2AuthKey(email: string, password: string): Promise<string> {
  const salt = await sha256(`colony-auth-v1:${normaliseEmail(email)}`);
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    256,
  );
  return toHex(bits);
}

/**
 * Derive the value the relay checks against its stored hash.
 *
 * The salt comes from the address rather than the server, so a second computer
 * can derive this from the password alone with no round trip before the user
 * has typed anything.
 *
 * The password is normalised first, so the same typed password derives the
 * same key whatever keyboard produced it. Accounts created before that was
 * true are reached through {@link deriveLegacyAuthKey} instead.
 */
export async function deriveAuthKey(
  email: string,
  password: string,
): Promise<string> {
  return pbkdf2AuthKey(email, normalisePassword(password));
}

/**
 * Derive the key an account created before signup normalised would have.
 *
 * Only for the sign-in fallback. Normalising at signup fixes new accounts, but
 * an account created from a decomposed password already has an `auth_hash`
 * over those exact bytes, and normalising everywhere would lock its owner out
 * of an account that works today. Sign-in therefore tries the normalised key
 * and falls back to this one.
 *
 * Removable once v2 re-keying lands; see the mobile-account-signin epic
 * artifact for what that takes.
 */
export async function deriveLegacyAuthKey(
  email: string,
  password: string,
): Promise<string> {
  return pbkdf2AuthKey(email, password);
}

/** Generate a recovery code in `XXXXX-XXXXX-XXXXX-XXXXX` form. */
export function generateRecoveryCode(): string {
  const bytes = new Uint8Array(GROUP_LEN * GROUP_COUNT);
  crypto.getRandomValues(bytes);
  const groups: string[] = [];
  for (let index = 0; index < GROUP_COUNT; index += 1) {
    let group = "";
    for (let offset = 0; offset < GROUP_LEN; offset += 1) {
      // The alphabet is exactly 32 characters, so a 5-bit slice is unbiased.
      group +=
        CROCKFORD_ALPHABET[bytes[index * GROUP_LEN + offset] & 0b0001_1111];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** Lowercase hex SHA-256 of a recovery code, after the same normalisation the relay applies. */
export async function hashRecoveryCode(code: string): Promise<string> {
  return toHex(await sha256(code.trim().toUpperCase()));
}
