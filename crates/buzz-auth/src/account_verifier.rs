//! Server-side verification of the client-derived `auth_key`.
//!
//! The client never sends a password. It sends `auth_key`, a value derived
//! from the password by a client-side KDF. This module hashes that value again
//! with Argon2id before storage, so a database breach yields neither the
//! password nor a directly replayable credential.
//!
//! See `docs/superpowers/specs/2026-08-22-auth-accounts-design.md`,
//! section "Cryptographic design".

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::{Algorithm, Argon2, Params, Version};

use crate::error::AuthError;

/// The only KDF parameter set this build understands.
///
/// Stored per account so cost can be raised later: a version 2 row would be
/// written on the next successful signin, while the password is briefly in
/// hand. Without this field that migration is impossible.
pub const CURRENT_KDF_VERSION: i16 = 1;

/// OWASP's current Argon2id minimum: 19 MiB, two passes, one lane.
const MEMORY_KIB: u32 = 19_456;
const ITERATIONS: u32 = 2;
const PARALLELISM: u32 = 1;

/// Placeholder PHC string burned by [`dummy_verify`] when no account exists.
///
/// Generated once by `hash_auth_key("dummy")`. It must stay a well-formed PHC
/// string: if it ever fails to parse, `verify_auth_key` returns early and the
/// timing defence silently does nothing. The test
/// `dummy_verify_parses_its_placeholder_hash` guards that.
pub(crate) const DUMMY_PHC: &str =
    "$argon2id$v=19$m=19456,t=2,p=1$bKUShWO9M715a1OJ4t9zhA$5DPYQzMrTJpZNBPmsYCi4hlqe69M20ZZ9cDA5ryRIfE";

fn hasher() -> Result<Argon2<'static>, AuthError> {
    let params = Params::new(MEMORY_KIB, ITERATIONS, PARALLELISM, None)
        .map_err(|error| AuthError::Internal(format!("argon2 params: {error}")))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Hash a client-supplied `auth_key` for storage, returning a PHC string.
///
/// The PHC string carries the algorithm, parameters and a fresh random salt,
/// so verification needs nothing else from the caller.
pub fn hash_auth_key(auth_key: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = hasher()?
        .hash_password(auth_key.as_bytes(), &salt)
        .map_err(|error| AuthError::Internal(format!("argon2 hash: {error}")))?;
    Ok(hash.to_string())
}

/// Verify a client-supplied `auth_key` against a stored PHC string.
///
/// A malformed stored hash returns `false` rather than an error: from the
/// caller's point of view a corrupt row and a wrong key are the same outcome,
/// and collapsing them keeps the wrong-credentials response uniform.
pub fn verify_auth_key(auth_key: &str, phc: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    let Ok(argon) = hasher() else {
        return false;
    };
    argon.verify_password(auth_key.as_bytes(), &parsed).is_ok()
}

/// Burn the same work a real verification costs.
///
/// Called on the no-such-account path so an attacker cannot tell a registered
/// email from an unregistered one by timing the response.
pub fn dummy_verify() {
    let _ = verify_auth_key("dummy", DUMMY_PHC);
}

/// Whether this build can verify accounts written at `version`.
pub fn is_supported_kdf_version(version: i16) -> bool {
    version == CURRENT_KDF_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b5aa765d61d8327deb882cf99";

    #[test]
    fn round_trips_a_correct_key() {
        let phc = hash_auth_key(KEY).expect("hashing should succeed");
        assert!(verify_auth_key(KEY, &phc));
    }

    #[test]
    fn rejects_a_wrong_key() {
        let phc = hash_auth_key(KEY).expect("hashing should succeed");
        let wrong = format!("{}00", &KEY[..62]);
        assert!(!verify_auth_key(&wrong, &phc));
    }

    #[test]
    fn salts_differ_between_hashes_of_the_same_key() {
        let first = hash_auth_key(KEY).expect("hashing should succeed");
        let second = hash_auth_key(KEY).expect("hashing should succeed");
        assert_ne!(first, second, "each hash must carry its own random salt");
        assert!(verify_auth_key(KEY, &first));
        assert!(verify_auth_key(KEY, &second));
    }

    #[test]
    fn rejects_a_malformed_stored_hash() {
        assert!(!verify_auth_key(KEY, "not-a-phc-string"));
    }

    #[test]
    fn only_version_one_is_supported() {
        assert!(is_supported_kdf_version(CURRENT_KDF_VERSION));
        assert!(!is_supported_kdf_version(0));
        assert!(!is_supported_kdf_version(2));
    }

    #[test]
    fn dummy_verify_does_not_panic() {
        dummy_verify();
    }

    #[test]
    fn dummy_verify_parses_its_placeholder_hash() {
        // A malformed placeholder makes verify_auth_key return early, which
        // would silently remove the timing defence on the unknown-email path.
        assert!(PasswordHash::new(DUMMY_PHC).is_ok());
    }
}
