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
use sha2::Digest;

use buzz_auth::account_crypto::{constant_time_eq_hex, normalise_email};
use buzz_auth::account_verifier::{
    dummy_verify, hash_auth_key, is_supported_kdf_version, verify_auth_key,
};
use buzz_db::email_accounts::{
    consume_reset_and_rewrite, create_account, find_account, issue_reset_token,
    record_signin_failure, record_signin_success, CreateAccountOutcome, NewAccount, PasswordReset,
};

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
    extensions: axum::http::Extensions,
    headers: HeaderMap,
    Json(request): Json<SignupRequest>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    if let Err(reason) = validate_signup(&request) {
        return Err(api_error(StatusCode::BAD_REQUEST, reason));
    }
    enforce_limits(&headers, &extensions, "signup", &request.email)?;
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

/// Failed signins before the account locks.
pub const LOCK_THRESHOLD: i32 = 10;
/// How long a locked account stays locked.
pub const LOCK_DURATION_MINS: i64 = 15;

/// Body for `POST /api/accounts/signin`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigninRequest {
    /// Address the account is filed under, normalised server side.
    pub email: String,
    /// Client-derived authentication value, 64 lowercase hex characters.
    pub auth_key: String,
}

/// Validate a signin body. Deliberately shallower than signup validation:
/// anything an attacker would probe with belongs behind the uniform
/// `invalid_credentials` response, not a distinguishable 400.
pub(crate) fn validate_signin(request: &SigninRequest) -> Result<(), &'static str> {
    let email = normalise_email(&request.email);
    if email.len() > MAX_EMAIL_LEN || !email.contains('@') {
        return Err("invalid_email");
    }
    if !is_lowercase_hex(&request.auth_key, 64) {
        return Err("invalid_auth_key");
    }
    Ok(())
}

/// Whole seconds until `until`, floored at zero.
pub(crate) fn retry_after_secs(until: chrono::DateTime<chrono::Utc>) -> i64 {
    (until - chrono::Utc::now()).num_seconds().max(0)
}

fn locked_error(until: chrono::DateTime<chrono::Utc>) -> (StatusCode, Json<Value>) {
    (
        StatusCode::LOCKED,
        Json(json!({
            "error": "temporarily_locked",
            "retryAfterSecs": retry_after_secs(until),
        })),
    )
}

/// `POST /api/accounts/signin`
///
/// Returns `invalid_credentials` for both an unknown address and a wrong
/// password, and burns equivalent work on the unknown path so the two cannot
/// be told apart by timing. Signup deliberately does disclose existence; that
/// is a usability requirement on one screen, and repeating it here would hand
/// credential stuffing a free oracle.
pub async fn signin(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    headers: HeaderMap,
    Json(request): Json<SigninRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Err(reason) = validate_signin(&request) {
        return Err(api_error(StatusCode::BAD_REQUEST, reason));
    }
    enforce_limits(&headers, &extensions, "signin", &request.email)?;
    let tenant = tenant_from_host(&state, &headers).await?;
    let email = normalise_email(&request.email);

    let account = find_account(state.db.pool(), tenant.community(), &email)
        .await
        .map_err(|error| internal_error(&format!("find account: {error}")))?;

    let Some(account) = account else {
        dummy_verify();
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    };

    if let Some(until) = account.locked_until {
        if until > chrono::Utc::now() {
            return Err(locked_error(until));
        }
    }

    if !verify_auth_key(&request.auth_key, &account.auth_hash) {
        let locked = record_signin_failure(
            state.db.pool(),
            tenant.community(),
            account.id,
            LOCK_THRESHOLD,
            chrono::Duration::minutes(LOCK_DURATION_MINS),
        )
        .await
        .map_err(|error| internal_error(&format!("record failure: {error}")))?;

        if let Some(until) = locked {
            return Err(locked_error(until));
        }
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }

    record_signin_success(state.db.pool(), tenant.community(), account.id)
        .await
        .map_err(|error| internal_error(&format!("record success: {error}")))?;

    Ok(Json(json!({
        "pubkey": account.pubkey,
        "passwordBlob": account.password_blob,
        "kdfVersion": account.kdf_version,
    })))
}

/// How long a recovery-issued reset token stays valid. Matches the lockout
/// window: both are "one deliberate action" lifetimes.
pub const RESET_TOKEN_TTL_MINS: i64 = 15;

/// Body for `POST /api/accounts/recover`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverRequest {
    /// Address the account is filed under, normalised server side.
    pub email: String,
    /// Lowercase hex SHA-256 of the recovery code, hashed on the device.
    pub recovery_code_hash: String,
}

pub(crate) fn validate_recover(request: &RecoverRequest) -> Result<(), &'static str> {
    if !is_plausible_email(&request.email) {
        return Err("invalid_email");
    }
    if !is_lowercase_hex(&request.recovery_code_hash, 64) {
        return Err("invalid_recovery_code_hash");
    }
    Ok(())
}

/// `POST /api/accounts/recover`
///
/// Exchanges a recovery code hash for the escrow blob it opens plus a
/// single-use reset token for the password reset that follows. An unknown
/// address and a wrong code are indistinguishable (`invalid_recovery_code`),
/// and the unknown path burns verification work so timing does not become an
/// enumeration oracle either.
pub async fn recover(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    headers: HeaderMap,
    Json(request): Json<RecoverRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Err(reason) = validate_recover(&request) {
        return Err(api_error(StatusCode::BAD_REQUEST, reason));
    }
    enforce_limits(&headers, &extensions, "recover", &request.email)?;
    let tenant = tenant_from_host(&state, &headers).await?;
    let email = normalise_email(&request.email);

    let account = find_account(state.db.pool(), tenant.community(), &email)
        .await
        .map_err(|error| internal_error(&format!("find account: {error}")))?;

    let Some(account) = account else {
        dummy_verify();
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid_recovery_code"));
    };

    // Never ==: the comparison must not leak how much of the guess matched.
    if !constant_time_eq_hex(&request.recovery_code_hash, &account.recovery_code_hash) {
        let locked = record_signin_failure(
            state.db.pool(),
            tenant.community(),
            account.id,
            LOCK_THRESHOLD,
            chrono::Duration::minutes(LOCK_DURATION_MINS),
        )
        .await
        .map_err(|error| internal_error(&format!("record failure: {error}")))?;
        if let Some(until) = locked {
            return Err(locked_error(until));
        }
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid_recovery_code"));
    }

    let token_bytes = random_32_bytes();
    let token_hash = hex::encode(sha2::Sha256::digest(token_bytes));

    issue_reset_token(
        state.db.pool(),
        tenant.community(),
        account.id,
        &token_hash,
        chrono::Duration::minutes(RESET_TOKEN_TTL_MINS),
    )
    .await
    .map_err(|error| internal_error(&format!("issue reset token: {error}")))?;

    Ok(Json(json!({
        "pubkey": account.pubkey,
        "recoveryBlob": account.recovery_blob,
        "resetToken": hex::encode(token_bytes),
    })))
}

fn random_32_bytes() -> [u8; 32] {
    use rand::Rng;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

/// Body for `POST /api/accounts/reset-password`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPasswordRequest {
    /// Address the account is filed under, normalised server side.
    pub email: String,
    /// The opaque token `recover` returned, single use.
    pub reset_token: String,
    /// Client-derived authentication value for the new password.
    pub auth_key: String,
    /// New blob under the new password.
    pub password_blob: String,
    /// New blob under the fresh recovery code.
    pub recovery_blob: String,
    /// Lowercase hex SHA-256 of the fresh recovery code. Required: a reset
    /// that kept the old code would keep a secret that was just typed into a
    /// form.
    pub recovery_code_hash: String,
    /// KDF parameter set version the client used for the new credentials.
    pub kdf_version: i16,
}

pub(crate) fn validate_reset(request: &ResetPasswordRequest) -> Result<(), &'static str> {
    if !is_plausible_email(&request.email) {
        return Err("invalid_email");
    }
    if request.reset_token.is_empty() {
        return Err("invalid_reset_token");
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

/// `POST /api/accounts/reset-password`
///
/// Rewrites both blobs, the auth hash, and the recovery code hash in one
/// transaction. The token row is consumed inside that transaction, so expired,
/// already used, and never issued all collapse into one uniform
/// `invalid_reset_token` with nothing to distinguish them.
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    headers: HeaderMap,
    Json(request): Json<ResetPasswordRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Err(reason) = validate_reset(&request) {
        return Err(api_error(StatusCode::BAD_REQUEST, reason));
    }
    enforce_limits(&headers, &extensions, "reset-password", &request.email)?;
    let tenant = tenant_from_host(&state, &headers).await?;

    let auth_hash = hash_auth_key(&request.auth_key)
        .map_err(|error| internal_error(&format!("hash auth key: {error}")))?;

    let token_hash = hex::encode(sha2::Sha256::digest(request.reset_token.as_bytes()));
    let applied = consume_reset_and_rewrite(
        state.db.pool(),
        tenant.community(),
        &normalise_email(&request.email),
        &token_hash,
        PasswordReset {
            auth_hash,
            password_blob: request.password_blob,
            recovery_blob: request.recovery_blob,
            recovery_code_hash: request.recovery_code_hash,
            kdf_version: request.kdf_version,
        },
    )
    .await
    .map_err(|error| internal_error(&format!("consume reset token: {error}")))?;

    if !applied {
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid_reset_token"));
    }

    Ok(Json(json!({ "ok": true })))
}

/// Per-route limits, all fixed-window over one hour.
///
/// The fixed-window algorithm allows up to 2x burst at boundaries. That is
/// acceptable here: the account lockout in `signin` is the real defence
/// against credential stuffing, and these limits exist to bound bulk probing.
pub(crate) struct RouteLimits {
    /// Attempts allowed per client address per window.
    pub per_ip: u64,
    /// Attempts allowed per email address per window. `None` for routes where
    /// the address is not yet bound to anything (`signup`).
    pub per_email: Option<u64>,
}

/// Limits from the spec's rate-limit table. Unknown routes are unlimited,
/// which is safe because only these four call sites exist.
pub(crate) fn limits_for(route: &str) -> Option<RouteLimits> {
    Some(match route {
        "signup" => RouteLimits {
            per_ip: 5,
            per_email: None,
        },
        "signin" => RouteLimits {
            per_ip: 30,
            per_email: Some(10),
        },
        "recover" => RouteLimits {
            per_ip: 20,
            per_email: Some(5),
        },
        "reset-password" => RouteLimits {
            per_ip: 10,
            per_email: Some(5),
        },
        _ => return None,
    })
}

/// Rate-limit key for an address, hashed so the limiter keyspace never holds
/// a plaintext list of every Colony user's email address.
pub(crate) fn email_rate_key(route: &str, email: &str) -> String {
    let digest = sha2::Sha256::digest(normalise_email(email).as_bytes());
    format!("acct:{route}:{}", hex::encode(digest))
}

/// Window length shared by every account route.
pub(crate) const RATE_WINDOW_SECS: u64 = 3600;
/// Upper bound on tracked keys. Legitimate traffic stays far below this; the
/// cap exists so a flood of distinct addresses turns into bounded memory
/// rather than unbounded growth.
const RATE_CACHE_CAPACITY: u64 = 100_000;

/// One fixed-window counter. `started_at` anchors the window so a rejected
/// caller can be told when it resets.
struct WindowCounter {
    count: std::sync::atomic::AtomicU32,
    started_at: std::time::Instant,
}

impl WindowCounter {
    fn new() -> Self {
        Self {
            count: std::sync::atomic::AtomicU32::new(0),
            started_at: std::time::Instant::now(),
        }
    }
}

type RateCache = moka::sync::Cache<String, Arc<WindowCounter>>;

fn rate_cache() -> &'static RateCache {
    static CACHE: std::sync::OnceLock<RateCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        moka::sync::Cache::builder()
            .max_capacity(RATE_CACHE_CAPACITY)
            .time_to_live(std::time::Duration::from_secs(RATE_WINDOW_SECS))
            .build()
    })
}

/// Count one attempt against a fixed window, returning seconds until the
/// window resets once the allowance is spent.
fn charge_window(cache: &RateCache, key: String, limit: u64) -> Option<u64> {
    let entry = cache.get_with(key, || Arc::new(WindowCounter::new()));
    let seen = entry
        .count
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if u64::from(seen) < limit {
        None
    } else {
        Some(RATE_WINDOW_SECS.saturating_sub(entry.started_at.elapsed().as_secs()))
    }
}

/// Resolve the caller's address for rate limiting.
///
/// Behind Fly's proxy the socket peer is the proxy, so `Fly-Client-IP` (which
/// the proxy sets itself, overwriting any client-supplied value) carries the
/// real source. A directly exposed relay would see a spoofable header here;
/// that is why the value is used only for rate limiting, never authz.
fn client_ip(headers: &HeaderMap, extensions: &axum::http::Extensions) -> std::net::IpAddr {
    headers
        .get("fly-client-ip")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<std::net::IpAddr>().ok())
        .or_else(|| {
            extensions
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|info| info.0.ip())
        })
        // A request whose source is unknown must not bypass the per-IP
        // limit; it falls into one shared bucket instead of an exemption.
        .unwrap_or(std::net::IpAddr::from([0, 0, 0, 0]))
}

fn rate_limited_error(retry_after_secs: u64) -> (StatusCode, Json<Value>) {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": "rate_limited",
            "retryAfterSecs": retry_after_secs,
        })),
    )
}

/// Apply the route's fixed-window limits. Every attempt charges both
/// counters, including requests that would fail later checks anyway, so a
/// caller cannot probe for free.
///
/// Deliberately process-local (the mechanism `invites.rs` uses for claims):
/// the Redis-backed admission limiter can only key on community and pubkey,
/// neither of which exists for an unauthenticated caller here.
pub(crate) fn enforce_limits(
    headers: &HeaderMap,
    extensions: &axum::http::Extensions,
    route: &str,
    email: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let Some(limits) = limits_for(route) else {
        return Ok(());
    };

    let ip_key = format!("acct:{route}:ip:{}", client_ip(headers, extensions));
    if let Some(retry) = charge_window(rate_cache(), ip_key, limits.per_ip) {
        return Err(rate_limited_error(retry));
    }

    if let Some(per_email) = limits.per_email {
        if let Some(retry) = charge_window(rate_cache(), email_rate_key(route, email), per_email) {
            return Err(rate_limited_error(retry));
        }
    }

    Ok(())
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

    #[test]
    fn signin_validation_accepts_a_well_formed_body() {
        let request = SigninRequest {
            email: "founder@example.com".into(),
            auth_key: "b".repeat(64),
        };
        assert!(validate_signin(&request).is_ok());
    }

    #[test]
    fn signin_validation_rejects_a_malformed_auth_key() {
        let request = SigninRequest {
            email: "founder@example.com".into(),
            auth_key: "short".into(),
        };
        assert_eq!(validate_signin(&request).unwrap_err(), "invalid_auth_key");
    }

    #[test]
    fn lock_expiry_is_reported_in_whole_seconds_remaining() {
        let until = chrono::Utc::now() + chrono::Duration::seconds(90);
        let secs = retry_after_secs(until);
        assert!((85..=90).contains(&secs), "got {secs}");
    }

    #[test]
    fn a_lock_already_in_the_past_reports_zero() {
        let until = chrono::Utc::now() - chrono::Duration::seconds(30);
        assert_eq!(retry_after_secs(until), 0);
    }

    fn valid_reset() -> ResetPasswordRequest {
        ResetPasswordRequest {
            email: "founder@example.com".into(),
            reset_token: "f".repeat(64),
            auth_key: "b".repeat(64),
            password_blob: format!("ncryptsec1{}", "c".repeat(40)),
            recovery_blob: format!("ncryptsec1{}", "d".repeat(40)),
            recovery_code_hash: "e".repeat(64),
            kdf_version: 1,
        }
    }

    #[test]
    fn recover_validation_requires_a_hex_hash() {
        let request = RecoverRequest {
            email: "a@x.com".into(),
            recovery_code_hash: "nothex".into(),
        };
        assert_eq!(
            validate_recover(&request).unwrap_err(),
            "invalid_recovery_code_hash"
        );
    }

    #[test]
    fn reset_validation_requires_a_new_recovery_code() {
        // A reset must issue a fresh code: the old one was just typed into a
        // form, which is exactly when it is most likely to have been seen.
        let mut request = valid_reset();
        request.recovery_code_hash = String::new();
        assert_eq!(
            validate_reset(&request).unwrap_err(),
            "invalid_recovery_code_hash"
        );
    }

    #[test]
    fn reset_validation_rejects_identical_blobs() {
        let mut request = valid_reset();
        request.recovery_blob = request.password_blob.clone();
        assert_eq!(validate_reset(&request).unwrap_err(), "invalid_blob");
    }

    #[test]
    fn reset_validation_accepts_a_well_formed_body() {
        assert!(validate_reset(&valid_reset()).is_ok());
    }

    #[test]
    fn rate_limit_keys_hash_the_email() {
        // The rate-limit keyspace must not become a plaintext list of every
        // user's address. Anyone with cache access would otherwise have the
        // mailing list.
        let key = email_rate_key("signin", "founder@example.com");
        assert!(!key.contains("founder"));
        assert!(!key.contains('@'));
        assert!(key.starts_with("acct:signin:"));
    }

    #[test]
    fn rate_limit_keys_normalise_before_hashing() {
        assert_eq!(
            email_rate_key("signin", " Founder@Example.COM "),
            email_rate_key("signin", "founder@example.com")
        );
    }

    #[test]
    fn every_route_has_a_configured_limit() {
        for route in ["signup", "signin", "recover", "reset-password"] {
            let limits = limits_for(route).expect("every route needs limits");
            assert!(limits.per_ip > 0, "{route} has no IP limit");
        }
    }

    #[test]
    fn a_spent_window_reports_retry_and_blocks() {
        let cache = moka::sync::Cache::builder().build();
        for _ in 0..3 {
            assert!(charge_window(&cache, "acct:signin:test".into(), 3).is_none());
        }
        let retry = charge_window(&cache, "acct:signin:test".into(), 3)
            .expect("the fourth attempt must be blocked");
        assert!(retry > 0 && retry <= RATE_WINDOW_SECS, "got {retry}");
    }
}
