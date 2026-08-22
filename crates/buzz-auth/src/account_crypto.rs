//! Pure primitives for email and password accounts.
//!
//! Nothing here touches the database or the network, so every rule the account
//! system depends on is unit testable in isolation.

use rand::Rng;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Crockford base32, which excludes I, L, O and U so a code read aloud or
/// written by hand cannot be transcribed into a different valid code.
pub const CROCKFORD_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Characters per group in a displayed recovery code.
const GROUP_LEN: usize = 5;
/// Number of groups. Four groups of five Crockford characters is 100 bits.
const GROUP_COUNT: usize = 4;

/// Canonical form of an email address: trimmed and lowercased.
///
/// Plus-addressing is preserved on purpose. `a+work@x.com` and `a@x.com` are
/// different accounts, because a user who tags an address expects it to stay
/// separate.
pub fn normalise_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// Generate a fresh recovery code in `XXXXX-XXXXX-XXXXX-XXXXX` form.
///
/// Drawn from the operating system's cryptographic random source. The modulo
/// below is unbiased because the alphabet is exactly 32 characters, so every
/// 5-bit slice maps to one character.
pub fn generate_recovery_code() -> String {
    let alphabet: Vec<char> = CROCKFORD_ALPHABET.chars().collect();
    let mut bytes = [0u8; GROUP_LEN * GROUP_COUNT];
    rand::rng().fill_bytes(&mut bytes);

    let mut groups: Vec<String> = Vec::with_capacity(GROUP_COUNT);
    for group in bytes.chunks(GROUP_LEN) {
        let text: String = group
            .iter()
            .map(|byte| alphabet[(byte & 0b0001_1111) as usize])
            .collect();
        groups.push(text);
    }
    groups.join("-")
}

/// Whether `code` could be a recovery code this system issued.
///
/// Case and surrounding whitespace are forgiven because users retype these by
/// hand. Ambiguous characters are not.
pub fn is_valid_recovery_code(code: &str) -> bool {
    let normalised = code.trim().to_uppercase();
    let groups: Vec<&str> = normalised.split('-').collect();
    if groups.len() != GROUP_COUNT {
        return false;
    }
    groups.iter().all(|group| {
        group.len() == GROUP_LEN && group.chars().all(|c| CROCKFORD_ALPHABET.contains(c))
    })
}

/// Lowercase hex SHA-256 of a recovery code, after the same normalisation
/// [`is_valid_recovery_code`] applies.
///
/// Only this hash is ever stored or transmitted. The code itself is a bearer
/// secret, held by the user and nobody else.
pub fn hash_recovery_code(code: &str) -> String {
    let normalised = code.trim().to_uppercase();
    let digest = Sha256::digest(normalised.as_bytes());
    hex::encode(digest)
}

/// Compare two hex strings without leaking their contents through timing.
///
/// Length inequality returns early, which reveals only the length. Both inputs
/// here are fixed-width hashes, so that leaks nothing.
pub fn constant_time_eq_hex(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_case_and_surrounding_whitespace() {
        assert_eq!(
            normalise_email("  Founder@Example.COM "),
            "founder@example.com"
        );
    }

    #[test]
    fn keeps_plus_addressing_distinct() {
        // Tagged addresses are deliberately separate accounts. Stripping the
        // tag would silently merge two accounts a user believes are separate.
        assert_ne!(normalise_email("a+work@x.com"), normalise_email("a@x.com"));
    }

    #[test]
    fn recovery_code_is_grouped_crockford() {
        let code = generate_recovery_code();
        assert_eq!(code.len(), 23, "four groups of five plus three dashes");
        let groups: Vec<&str> = code.split('-').collect();
        assert_eq!(groups.len(), 4);
        for group in groups {
            assert_eq!(group.len(), 5);
            for character in group.chars() {
                assert!(
                    CROCKFORD_ALPHABET.contains(character),
                    "{character} is outside the Crockford alphabet"
                );
            }
        }
    }

    #[test]
    fn recovery_codes_do_not_repeat() {
        let first = generate_recovery_code();
        let second = generate_recovery_code();
        assert_ne!(first, second);
    }

    #[test]
    fn rejects_ambiguous_characters() {
        // I, L, O and U are excluded so a handwritten code cannot be misread.
        assert!(!is_valid_recovery_code("IIIII-IIIII-IIIII-IIIII"));
        // A wrong-length code, here a single truncated group, is not valid.
        assert!(!is_valid_recovery_code("ABCDE-FGHJ"));
        assert!(is_valid_recovery_code(&generate_recovery_code()));
    }

    #[test]
    fn recovery_code_validation_ignores_case_and_spacing() {
        let code = generate_recovery_code();
        assert!(is_valid_recovery_code(&code.to_lowercase()));
        assert!(is_valid_recovery_code(&format!(" {code} ")));
    }

    #[test]
    fn hashing_is_stable_and_hex() {
        let hash = hash_recovery_code("ABCDE-FGHJK-MNPQR-STVWX");
        assert_eq!(hash.len(), 64);
        assert!(hash
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(hash, hash_recovery_code("abcde-fghjk-mnpqr-stvwx"));
    }

    #[test]
    fn constant_time_compare_matches_equality() {
        assert!(constant_time_eq_hex("abcd", "abcd"));
        assert!(!constant_time_eq_hex("abcd", "abce"));
        assert!(!constant_time_eq_hex("abcd", "abcde"));
    }
}
