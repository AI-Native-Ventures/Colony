//! Sealing for relay-held employee secret keys.
//!
//! An employee's identity key is minted by the relay and never leaves it, so
//! that every member can produce work as one colleague without a private key
//! being copied to laptops or rotated when somebody leaves
//! (`docs/design/company-employees.html`). That makes this the first private
//! key material the relay stores, and a plain column would mean a database
//! dump yields the power to speak as every employee in every workspace.
//!
//! So keys are sealed with AES-256-GCM under a key-encryption key supplied by
//! the operator, held only in the process environment. A dump without the KEK
//! is inert. The community id and the employee's own pubkey are bound in as
//! associated data, so a sealed key lifted from one row cannot be replayed
//! into another employee's row or another tenant's: the tag will not verify.
//!
//! This is confidentiality at rest, not an HSM. An attacker with both the
//! database and the running process's environment has the keys. The honest
//! bar is: losing a backup is not the same as losing the company.

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use uuid::Uuid;
use zeroize::Zeroizing;

/// Domain separator, so a sealed employee key can never be opened as some
/// other kind of sealed blob the relay might grow later.
const AAD_PREFIX: &[u8] = b"colony:employee-key:v1:";
const NONCE_LEN: usize = 12;

/// Why an employee key could not be sealed or opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmployeeKeyError {
    /// No key-encryption key is configured, so employees cannot be hired.
    NotConfigured,
    /// The configured KEK is not 32 bytes of hex.
    InvalidKek,
    /// The sealed blob is truncated, corrupt, or was sealed for a different
    /// employee, community, or KEK.
    Unsealable,
}

impl std::fmt::Display for EmployeeKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(
                f,
                "employee key sealing is not configured (set BUZZ_EMPLOYEE_KEK)"
            ),
            Self::InvalidKek => write!(f, "BUZZ_EMPLOYEE_KEK must be 64 hex characters"),
            Self::Unsealable => write!(f, "sealed employee key could not be opened"),
        }
    }
}

impl std::error::Error for EmployeeKeyError {}

/// The operator-supplied key-encryption key, parsed once at startup.
#[derive(Clone)]
pub struct EmployeeKeySealer {
    cipher: Aes256Gcm,
}

impl std::fmt::Debug for EmployeeKeySealer {
    /// Never renders the key material, so an accidental `{:?}` of `AppState`
    /// cannot put the KEK in a log line.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EmployeeKeySealer(<redacted>)")
    }
}

impl EmployeeKeySealer {
    /// Build a sealer from 64 hex characters (32 bytes).
    pub fn from_hex(kek_hex: &str) -> Result<Self, EmployeeKeyError> {
        let trimmed = kek_hex.trim();
        if trimmed.len() != 64 {
            return Err(EmployeeKeyError::InvalidKek);
        }
        let bytes = Zeroizing::new(hex::decode(trimmed).map_err(|_| EmployeeKeyError::InvalidKek)?);
        Ok(Self {
            cipher: Aes256Gcm::new_from_slice(&bytes).map_err(|_| EmployeeKeyError::InvalidKek)?,
        })
    }

    /// Associated data binding a sealed key to exactly one employee in exactly
    /// one community.
    fn aad(community: Uuid, employee_pubkey: &[u8; 32]) -> Vec<u8> {
        let mut aad = Vec::with_capacity(AAD_PREFIX.len() + 16 + 32);
        aad.extend_from_slice(AAD_PREFIX);
        aad.extend_from_slice(community.as_bytes());
        aad.extend_from_slice(employee_pubkey);
        aad
    }

    /// Seal a 32-byte secret key for storage. Output is `nonce || ciphertext`.
    pub fn seal(
        &self,
        community: Uuid,
        employee_pubkey: &[u8; 32],
        secret_key: &[u8; 32],
    ) -> Result<Vec<u8>, EmployeeKeyError> {
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let mut sealed = nonce.to_vec();
        sealed.extend(
            self.cipher
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: secret_key.as_slice(),
                        aad: &Self::aad(community, employee_pubkey),
                    },
                )
                .map_err(|_| EmployeeKeyError::Unsealable)?,
        );
        Ok(sealed)
    }

    /// Open a sealed key. The result zeroizes on drop.
    pub fn open(
        &self,
        community: Uuid,
        employee_pubkey: &[u8; 32],
        sealed: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, EmployeeKeyError> {
        if sealed.len() <= NONCE_LEN {
            return Err(EmployeeKeyError::Unsealable);
        }
        let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
        let plaintext = self
            .cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: &Self::aad(community, employee_pubkey),
                },
            )
            .map_err(|_| EmployeeKeyError::Unsealable)?;
        Ok(Zeroizing::new(plaintext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEK: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const OTHER_KEK: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn sealer(hex: &str) -> EmployeeKeySealer {
        EmployeeKeySealer::from_hex(hex).unwrap()
    }

    fn secret() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn a_sealed_key_opens_back_to_the_original() {
        let community = Uuid::from_u128(1);
        let pubkey = [3u8; 32];
        let sealer = sealer(KEK);
        let sealed = sealer.seal(community, &pubkey, &secret()).unwrap();
        assert_ne!(
            sealed.as_slice(),
            secret().as_slice(),
            "must not store plaintext"
        );
        assert_eq!(
            sealer.open(community, &pubkey, &sealed).unwrap().as_slice(),
            secret().as_slice()
        );
    }

    #[test]
    fn sealing_twice_produces_different_blobs() {
        // A fresh nonce per seal: identical keys must not be recognisable as
        // identical from the stored bytes.
        let sealer = sealer(KEK);
        let community = Uuid::from_u128(1);
        let a = sealer.seal(community, &[3u8; 32], &secret()).unwrap();
        let b = sealer.seal(community, &[3u8; 32], &secret()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn a_key_sealed_for_one_community_will_not_open_in_another() {
        let sealer = sealer(KEK);
        let pubkey = [3u8; 32];
        let sealed = sealer.seal(Uuid::from_u128(1), &pubkey, &secret()).unwrap();
        assert_eq!(
            sealer
                .open(Uuid::from_u128(2), &pubkey, &sealed)
                .unwrap_err(),
            EmployeeKeyError::Unsealable
        );
    }

    #[test]
    fn a_key_sealed_for_one_employee_will_not_open_for_another() {
        let sealer = sealer(KEK);
        let community = Uuid::from_u128(1);
        let sealed = sealer.seal(community, &[3u8; 32], &secret()).unwrap();
        assert_eq!(
            sealer.open(community, &[4u8; 32], &sealed).unwrap_err(),
            EmployeeKeyError::Unsealable
        );
    }

    #[test]
    fn a_dump_without_the_kek_is_inert() {
        let community = Uuid::from_u128(1);
        let pubkey = [3u8; 32];
        let sealed = sealer(KEK).seal(community, &pubkey, &secret()).unwrap();
        assert_eq!(
            sealer(OTHER_KEK)
                .open(community, &pubkey, &sealed)
                .unwrap_err(),
            EmployeeKeyError::Unsealable
        );
    }

    #[test]
    fn a_tampered_blob_is_refused_rather_than_returned() {
        let community = Uuid::from_u128(1);
        let pubkey = [3u8; 32];
        let sealer = sealer(KEK);
        let mut sealed = sealer.seal(community, &pubkey, &secret()).unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        assert_eq!(
            sealer.open(community, &pubkey, &sealed).unwrap_err(),
            EmployeeKeyError::Unsealable
        );
    }

    #[test]
    fn truncated_blobs_are_refused_without_panicking() {
        let sealer = sealer(KEK);
        for len in [0usize, 1, NONCE_LEN, NONCE_LEN - 1] {
            assert_eq!(
                sealer
                    .open(Uuid::from_u128(1), &[3u8; 32], &vec![0u8; len])
                    .unwrap_err(),
                EmployeeKeyError::Unsealable
            );
        }
    }

    #[test]
    fn a_malformed_kek_is_refused_at_startup() {
        for bad in ["", "abc", &"z".repeat(64), &"ab".repeat(20)] {
            assert_eq!(
                EmployeeKeySealer::from_hex(bad).unwrap_err(),
                EmployeeKeyError::InvalidKek
            );
        }
    }

    #[test]
    fn the_debug_rendering_never_carries_key_material() {
        let rendered = format!("{:?}", sealer(KEK));
        assert!(!rendered.contains("0f1e2d"), "{rendered}");
        assert_eq!(rendered, "EmployeeKeySealer(<redacted>)");
    }
}
