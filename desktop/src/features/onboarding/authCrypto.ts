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
 * Derive the value the relay checks against its stored hash.
 *
 * The salt comes from the address rather than the server, so a second computer
 * can derive this from the password alone with no round trip before the user
 * has typed anything.
 */
export async function deriveAuthKey(
  email: string,
  password: string,
): Promise<string> {
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
