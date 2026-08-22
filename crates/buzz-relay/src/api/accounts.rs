//! Email and password accounts.
//!
//! **These routes are HTTP rather than Nostr events on purpose.** Signup
//! happens before the caller owns a key, so there is nothing to sign and no
//! event kind could carry it. This is the same exemption
//! `POST /api/invites/claim` takes, and it should not be "fixed" into an
//! event kind by a later reader.
//!
//! The relay never receives a password or a private key. It receives two
//! opaque NIP-49 blobs and a client-derived `auth_key`. See
//! `docs/superpowers/specs/2026-08-22-auth-accounts-design.md`.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use buzz_auth::account_crypto::normalise_email;
use buzz_auth::account_verifier::{hash_auth_key, is_supported_kdf_version};
use buzz_db::email_accounts::{create_account, CreateAccountOutcome, NewAccount};

use crate::state::AppState;

use super::{api_error, internal_error};

/// Longest NIP-49 payload accepted. Today's format is far shorter; the cap
/// exists so a caller cannot use this table as arbitrary storage.
pub(crate) const MAX_BLOB_LEN: usize = 512;
/// RFC 5321 caps an address at 254 octets.
const MAX_EMAIL_LEN: usize = 254;
const NCRYPTSEC_PREFIX: &str = "ncryptsec1";

/// Body for `POST /api/accounts/signup`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignupRequest {
    /// Address the account is filed under, normalised server side.
    pub email: String,
    /// The member's public key, 64 lowercase hex characters.
    pub pubkey: String,
    /// Client-derived authentication value, 64 lowercase hex characters.
    /// Never the password.
    pub auth_key: String,
    /// Opaque NIP-49 blob encrypting the member key under the password.
    pub password_blob: String,
    /// Opaque NIP-49 blob encrypting the member key under the recovery code.
    pub recovery_blob: String,
    /// Lowercase hex SHA-256 of the recovery code.
    pub recovery_code_hash: String,
    /// KDF parameter set version the client used.
    pub kdf_version: i16,
}

fn is_lowercase_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn is_valid_blob(value: &str) -> bool {
    value.starts_with(NCRYPTSEC_PREFIX) && value.len() <= MAX_BLOB_LEN
}

fn is_plausible_email(raw: &str) -> bool {
    let email = normalise_email(raw);
    email.len() <= MAX_EMAIL_LEN
        && email.contains('@')
        && !email.starts_with('@')
        && !email.ends_with('@')
}

/// Validate a signup body, returning a typed error string the client maps to a
/// screen state. Never returns free text: the client must not parse prose.
pub(crate) fn validate_signup(request: &SignupRequest) -> Result<(), &'static str> {
    if !is_plausible_email(&request.email) {
        return Err("invalid_email");
    }
    if !is_lowercase_hex(&request.pubkey, 64) {
        return Err("invalid_pubkey");
    }
    if !is_lowercase_hex(&request.auth_key, 64) {
        return Err("invalid_auth_key");
    }
    if !is_lowercase_hex(&request.recovery_code_hash, 64) {
        return Err("invalid_recovery_code_hash");
    }
    if !is_valid_blob(&request.password_blob) || !is_valid_blob(&request.recovery_blob) {
        return Err("invalid_blob");
    }
    if request.password_blob == request.recovery_blob {
        return Err("invalid_blob");
    }
    if !is_supported_kdf_version(request.kdf_version) {
        return Err("unsupported_kdf_version");
    }
    Ok(())
}

/// Resolve the tenant from the request host.
///
/// The community is never taken from a request field: accepting one would let
/// a caller create an account in a tenant they were never pointed at.
pub(crate) async fn tenant_from_host(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<buzz_core::TenantContext, (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| api_error(StatusCode::NOT_FOUND, "unknown_community"))
}

/// `POST /api/accounts/signup`
///
/// Stores two opaque blobs against a normalised address. Deliberately
/// discloses whether an address is already registered (`email_taken`): the
/// onboarding screen must tell that user something useful, and rate limiting
/// bounds bulk harvesting. Signin does not make the same disclosure.
pub async fn signup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SignupRequest>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    if let Err(reason) = validate_signup(&request) {
        return Err(api_error(StatusCode::BAD_REQUEST, reason));
    }
    let tenant = tenant_from_host(&state, &headers).await?;

    let auth_hash = hash_auth_key(&request.auth_key)
        .map_err(|error| internal_error(&format!("hash auth key: {error}")))?;

    let account = NewAccount {
        pubkey: request.pubkey.clone(),
        auth_hash,
        password_blob: request.password_blob.clone(),
        recovery_blob: request.recovery_blob.clone(),
        recovery_code_hash: request.recovery_code_hash.clone(),
        kdf_version: request.kdf_version,
    };

    match create_account(
        state.db.pool(),
        tenant.community(),
        &normalise_email(&request.email),
        account,
    )
    .await
    {
        Ok(CreateAccountOutcome::Created(id)) => Ok((
            StatusCode::CREATED,
            Json(json!({ "pubkey": request.pubkey, "accountId": id })),
        )),
        Ok(CreateAccountOutcome::EmailTaken) => Err(api_error(StatusCode::CONFLICT, "email_taken")),
        Ok(CreateAccountOutcome::PubkeyTaken) => {
            Err(api_error(StatusCode::CONFLICT, "pubkey_taken"))
        }
        Err(error) => Err(internal_error(&format!("create account: {error}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> SignupRequest {
        SignupRequest {
            email: "founder@example.com".into(),
            pubkey: "a".repeat(64),
            auth_key: "b".repeat(64),
            password_blob: format!("ncryptsec1{}", "c".repeat(40)),
            recovery_blob: format!("ncryptsec1{}", "d".repeat(40)),
            recovery_code_hash: "e".repeat(64),
            kdf_version: 1,
        }
    }

    #[test]
    fn accepts_a_well_formed_request() {
        assert!(validate_signup(&valid()).is_ok());
    }

    #[test]
    fn rejects_an_address_without_an_at_sign() {
        let mut request = valid();
        request.email = "founder".into();
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_email");
    }

    #[test]
    fn rejects_an_overlong_address() {
        let mut request = valid();
        request.email = format!("{}@x.com", "a".repeat(250));
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_email");
    }

    #[test]
    fn rejects_a_pubkey_that_is_not_64_hex() {
        let mut request = valid();
        request.pubkey = "ZZZ".into();
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_pubkey");
    }

    #[test]
    fn rejects_an_uppercase_pubkey() {
        // Hex pubkeys are lowercase everywhere in this codebase. Accepting both
        // cases would let one key occupy two rows under the unique index.
        let mut request = valid();
        request.pubkey = "A".repeat(64);
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_pubkey");
    }

    #[test]
    fn rejects_a_blob_without_the_ncryptsec_prefix() {
        let mut request = valid();
        request.password_blob = "nsec1abc".into();
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_blob");
    }

    #[test]
    fn rejects_an_oversized_blob() {
        let mut request = valid();
        let oversized = format!("ncryptsec1{}", "c".repeat(MAX_BLOB_LEN));
        assert!(
            oversized.len() > MAX_BLOB_LEN,
            "test premise: the built blob must exceed the cap"
        );
        request.recovery_blob = oversized;
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_blob");
    }

    #[test]
    fn rejects_an_unsupported_kdf_version() {
        let mut request = valid();
        request.kdf_version = 2;
        assert_eq!(
            validate_signup(&request).unwrap_err(),
            "unsupported_kdf_version"
        );
    }

    #[test]
    fn rejects_identical_password_and_recovery_blobs() {
        // Identical blobs mean the client encrypted under one secret twice, so
        // the recovery code opens nothing the password does not already open.
        let mut request = valid();
        request.recovery_blob = request.password_blob.clone();
        assert_eq!(validate_signup(&request).unwrap_err(), "invalid_blob");
    }
}
