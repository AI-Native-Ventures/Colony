//! Runtime-owned Colony Credits gateway leases.
//!
//! The desktop never persists a gateway token.  A lease is bound to the
//! normalized relay origin and the owner's public key, and is kept only for
//! the lifetime of the Tauri process.  Managed-agent spawn code consumes the
//! lease at the existing `BUZZ_METER_OPENAI_*` seam.

use std::{collections::HashMap, fmt, time::Duration};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    relay::{build_nip98_auth_header, relay_http_base_url},
};

/// Gateway token lifetime requested by the desktop. The relay clamps this to
/// its own supported range, so callers must still honor the returned expiry.
pub const GATEWAY_TOKEN_TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// Refresh lead time required by the Phase 1 lease contract.
pub const GATEWAY_REFRESH_LEAD_SECS: i64 = 24 * 60 * 60;

/// Normalize a relay URL to the HTTP origin used by gateway APIs.
pub fn normalized_relay_http_origin(relay_url: &str) -> String {
    relay_http_base_url(relay_url.trim())
        .trim_end_matches('/')
        .to_string()
}

/// Return the exact OpenAI-compatible gateway upstream used by the local
/// meter. The meter appends paths such as `v1/chat/completions` itself.
pub fn normalized_gateway_upstream(relay_url: &str) -> String {
    format!("{}/gateway/openai", normalized_relay_http_origin(relay_url))
}

/// Account state returned by `GET /api/gateway/account`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GatewayAccountStatus {
    /// A strictly positive signed nanodollar balance.
    Active,
    /// A zero or negative balance.
    Depleted,
}

/// Typed account response. `balance_nanousd` intentionally remains a string
/// at the Tauri/TypeScript boundary so no floating point conversion occurs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GatewayAccount {
    /// Signed decimal nanodollar balance supplied by the relay.
    pub balance_nanousd: String,
    /// The only supported presentation currency.
    pub currency: String,
    /// Relay-provided display status; callers also validate it against the
    /// integer balance before showing it.
    pub status: GatewayAccountStatus,
}

impl GatewayAccount {
    /// Parse the signed decimal balance with integer-safe semantics and verify
    /// the account contract. The returned value is nanodollars, not USD.
    pub fn balance_nanousd_i128(&self) -> Result<i128, String> {
        if self.currency != "USD" {
            return Err("gateway account returned an unsupported currency".to_string());
        }
        let balance = parse_balance_nanousd(&self.balance_nanousd)?;
        let computed = if balance > 0 {
            GatewayAccountStatus::Active
        } else {
            GatewayAccountStatus::Depleted
        };
        if self.status != computed {
            return Err("gateway account status does not match its balance".to_string());
        }
        Ok(balance)
    }
}

/// Parse a signed decimal nanodollar balance without a precision-losing float.
pub fn parse_balance_nanousd(value: &str) -> Result<i128, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("gateway account balance is empty".to_string());
    }
    trimmed
        .parse::<i128>()
        .map_err(|_| "gateway account balance is not a valid signed decimal".to_string())
}

/// Opaque token wrapper whose debug output cannot disclose the token.
#[derive(Clone, PartialEq, Eq)]
pub struct RedactedToken(String);

impl RedactedToken {
    /// Construct an in-memory token from a successful mint response.
    fn new(value: String) -> Result<Self, String> {
        if value.trim().is_empty() {
            return Err("gateway returned an empty token".to_string());
        }
        Ok(Self(value))
    }

    /// Borrow the raw token only at the process-spawn/revoke seam.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RedactedToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RedactedToken(<redacted>)")
    }
}

/// Identity boundary for a cached gateway lease.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GatewayLeaseKey {
    /// Normalized `http(s)://host[:port]` relay origin.
    pub relay_origin: String,
    /// Lowercase owner public key hex.
    pub owner_pubkey: String,
}

impl GatewayLeaseKey {
    /// Build a canonical cache key from a relay URL and owner public key.
    pub fn new(relay_url: &str, owner_pubkey: &str) -> Result<Self, String> {
        let relay_origin = normalized_relay_http_origin(relay_url);
        if relay_origin.is_empty() {
            return Err("gateway relay origin is empty".to_string());
        }
        let owner_pubkey = owner_pubkey.trim().to_ascii_lowercase();
        if owner_pubkey.is_empty() {
            return Err("gateway owner public key is empty".to_string());
        }
        Ok(Self {
            relay_origin,
            owner_pubkey,
        })
    }
}

/// An in-memory gateway lease. The token is deliberately omitted from its
/// serialized/debug representation; only `as_str()` can access it.
#[derive(Clone, PartialEq, Eq)]
pub struct GatewayLease {
    /// Relay/owner identity this token is bound to.
    pub key: GatewayLeaseKey,
    /// Opaque gateway token, redacted in debug output.
    pub token: RedactedToken,
    /// Relay-provided expiry.
    pub expires_at: DateTime<Utc>,
}

impl fmt::Debug for GatewayLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayLease")
            .field("key", &self.key)
            .field("token", &self.token)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

struct LeaseEntry {
    lease: GatewayLease,
    refresh_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Runtime-owned cache. This type is intentionally not a module-level
/// singleton; it lives in [`AppState`] and therefore follows the app lifetime.
#[derive(Default)]
pub struct ProvisionedCreditsManager {
    leases: HashMap<GatewayLeaseKey, LeaseEntry>,
}

impl ProvisionedCreditsManager {
    fn cached(&self, key: &GatewayLeaseKey, force: bool) -> Option<GatewayLease> {
        let entry = self.leases.get(key)?;
        let refresh_at =
            entry.lease.expires_at - ChronoDuration::seconds(GATEWAY_REFRESH_LEAD_SECS);
        if !force && Utc::now() < refresh_at && entry.lease.expires_at > Utc::now() {
            return Some(entry.lease.clone());
        }
        None
    }

    fn replace(&mut self, lease: GatewayLease) {
        if let Some(previous) = self.leases.remove(&lease.key) {
            if let Some(task) = previous.refresh_task {
                task.abort();
            }
        }
        self.leases.insert(
            lease.key.clone(),
            LeaseEntry {
                lease,
                refresh_task: None,
            },
        );
    }

    fn schedule_refresh(
        &mut self,
        app: &AppHandle,
        key: GatewayLeaseKey,
        expires_at: DateTime<Utc>,
    ) {
        let refresh_at = expires_at - ChronoDuration::seconds(GATEWAY_REFRESH_LEAD_SECS);
        let delay = (refresh_at - Utc::now())
            .to_std()
            .unwrap_or_else(|_| Duration::from_secs(0));
        let app = app.clone();
        let key_for_task = key.clone();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let app_for_refresh = app.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = refresh_lease_blocking(&app_for_refresh, &key_for_task);
            })
            .await;
        });
        if let Some(entry) = self.leases.get_mut(&key) {
            if let Some(previous) = entry.refresh_task.replace(task) {
                previous.abort();
            }
        } else {
            task.abort();
        }
    }

    #[cfg(test)]
    fn contains(&self, key: &GatewayLeaseKey) -> bool {
        self.leases.contains_key(key)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GatewayHttpErrorKind {
    Unauthorized,
    Depleted,
    NotFound,
}

fn gateway_http_error(status: reqwest::StatusCode) -> Result<(), GatewayHttpErrorKind> {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => Err(GatewayHttpErrorKind::Unauthorized),
        reqwest::StatusCode::PAYMENT_REQUIRED => Err(GatewayHttpErrorKind::Depleted),
        reqwest::StatusCode::NOT_FOUND => Err(GatewayHttpErrorKind::NotFound),
        _ => Ok(()),
    }
}

fn stable_http_error(kind: GatewayHttpErrorKind) -> String {
    match kind {
        GatewayHttpErrorKind::Unauthorized => {
            "Colony Credits gateway authorization expired — reconnect".to_string()
        }
        GatewayHttpErrorKind::Depleted => {
            "Colony Credits depleted — top up, then reconnect".to_string()
        }
        GatewayHttpErrorKind::NotFound => {
            "Colony Credits gateway is unavailable on this relay".to_string()
        }
    }
}

fn blocking_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("gateway client setup failed: {error}"))
}

fn owner_pubkey(app: &AppHandle, explicit: Option<&str>) -> Result<String, String> {
    if let Some(owner) = explicit.map(str::trim).filter(|owner| !owner.is_empty()) {
        return Ok(owner.to_ascii_lowercase());
    }
    let state = app.state::<AppState>();
    state.signing_keys().map(|keys| keys.public_key().to_hex())
}

fn mint_lease(app: &AppHandle, key: GatewayLeaseKey) -> Result<GatewayLease, String> {
    let state = app.state::<AppState>();
    let url = format!("{}/api/gateway/tokens", key.relay_origin);
    let body = serde_json::to_vec(&serde_json::json!({
        "ttl_secs": GATEWAY_TOKEN_TTL_SECS,
    }))
    .map_err(|error| format!("gateway request serialization failed: {error}"))?;
    let auth = build_nip98_auth_header(&Method::POST, &url, &body, &state)?;
    let response = blocking_client()?
        .post(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|error| format!("gateway unreachable: {error}"))?;
    let status = response.status();
    if let Err(kind) = gateway_http_error(status) {
        return Err(stable_http_error(kind));
    }
    if !status.is_success() {
        return Err(format!("gateway returned HTTP {status}"));
    }
    let payload = response
        .json::<MintTokenResponse>()
        .map_err(|_| "gateway returned malformed token response".to_string())?;
    let token = RedactedToken::new(payload.token)?;
    Ok(GatewayLease {
        key,
        token,
        expires_at: payload.expires_at,
    })
}

#[derive(Debug, Deserialize)]
struct MintTokenResponse {
    token: String,
    expires_at: DateTime<Utc>,
}

fn revoke_lease(app: &AppHandle, lease: &GatewayLease) -> Result<(), String> {
    let state = app.state::<AppState>();
    let url = format!("{}/api/gateway/tokens", lease.key.relay_origin);
    let body = serde_json::to_vec(&serde_json::json!({"token": lease.token.as_str()}))
        .map_err(|error| format!("gateway request serialization failed: {error}"))?;
    let auth = build_nip98_auth_header(&Method::DELETE, &url, &body, &state)?;
    let response = blocking_client()?
        .delete(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|error| format!("gateway unreachable: {error}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::NO_CONTENT {
        return Ok(());
    }
    if let Err(kind) = gateway_http_error(status) {
        return Err(stable_http_error(kind));
    }
    if !status.is_success() {
        return Err(format!("gateway returned HTTP {status}"));
    }
    Ok(())
}

/// Ensure a lease for a managed-agent spawn. This is synchronous because the
/// existing spawn boundary is synchronous; callers invoke it from the same
/// blocking path used for process creation.
pub fn ensure_lease_blocking(
    app: &AppHandle,
    relay_url: &str,
    explicit_owner: Option<&str>,
    force: bool,
) -> Result<GatewayLease, String> {
    let owner = owner_pubkey(app, explicit_owner)?;
    let key = GatewayLeaseKey::new(relay_url, &owner)?;
    rotate_lease_blocking(app, &key, force)
}

fn refresh_lease_blocking(app: &AppHandle, key: &GatewayLeaseKey) -> Result<(), String> {
    let state = app.state::<AppState>();
    let exists = {
        let manager = state
            .provisioned_credits
            .lock()
            .map_err(|error| error.to_string())?;
        manager.leases.contains_key(key)
    };
    if !exists {
        return Ok(());
    }
    let _ = rotate_lease_blocking(app, key, true)?;
    Ok(())
}

/// Mint and safely rotate a lease. The manager lock remains held through the
/// replacement handoff so concurrent ensure/refresh calls cannot mint a
/// second replacement for the same relay/owner pair. The old token remains
/// cached and live until every running pair has accepted the replacement.
fn rotate_lease_blocking(
    app: &AppHandle,
    key: &GatewayLeaseKey,
    force: bool,
) -> Result<GatewayLease, String> {
    let state = app.state::<AppState>();
    let mut manager = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?;
    if let Some(cached) = manager.cached(key, force) {
        return Ok(cached);
    }

    let old = manager.leases.get(key).map(|entry| entry.lease.clone());
    let replacement = mint_lease(app, key.clone())?;
    if old.is_some() {
        if let Err(error) =
            crate::managed_agents::handoff_provisioned_credits_pairs(app, &replacement)
        {
            if error.replacement_in_use {
                // One or more pairs now depend on the replacement. Keep it
                // cached and leave the old lease live for pairs that still
                // need an explicit retry; revoking either token here would
                // strand a working process.
                manager.replace(replacement.clone());
                manager.schedule_refresh(app, key.clone(), replacement.expires_at);
            } else {
                // No pair accepted the replacement, so the old lease remains
                // the sole working credential and the unused mint is safe to
                // revoke.
                let _ = revoke_lease(app, &replacement);
            }
            return Err(error.message);
        }
    }

    manager.replace(replacement.clone());
    manager.schedule_refresh(app, key.clone(), replacement.expires_at);
    drop(manager);
    if let Some(old) = old {
        // Revocation is best-effort after the handoff. A replacement that is
        // already serving agents must not be rolled back for a cleanup error.
        let _ = revoke_lease(app, &old);
    }
    Ok(replacement)
}

/// Force a replacement lease. The caller is responsible for the running-pair
/// handoff before revoking the old token; this low-level helper never exposes a
/// token to the webview.
pub fn force_reconnect_blocking(
    app: &AppHandle,
    relay_url: &str,
    explicit_owner: Option<&str>,
) -> Result<(), String> {
    let owner = owner_pubkey(app, explicit_owner)?;
    let key = GatewayLeaseKey::new(relay_url, &owner)?;
    let _ = rotate_lease_blocking(app, &key, true)?;
    Ok(())
}

/// Best-effort revoke/clear used only during explicit shutdown or identity
/// recovery. Community switching intentionally does not call this function.
#[allow(dead_code)]
pub fn clear_lease(app: &AppHandle, key: &GatewayLeaseKey, revoke: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let entry = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?
        .leases
        .remove(key);
    if let Some(entry) = entry {
        if let Some(task) = entry.refresh_task {
            task.abort();
        }
        if revoke {
            revoke_lease(app, &entry.lease)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_upstream_uses_http_origin_and_path() {
        assert_eq!(
            normalized_gateway_upstream("wss://Relay.Example:443/"),
            "https://Relay.Example:443/gateway/openai"
        );
        assert_eq!(
            normalized_gateway_upstream("http://relay.example///"),
            "http://relay.example/gateway/openai"
        );
    }

    #[test]
    fn balance_parser_is_signed_integer_safe() {
        assert_eq!(parse_balance_nanousd("123456789"), Ok(123_456_789));
        assert_eq!(parse_balance_nanousd("-1"), Ok(-1));
        assert!(parse_balance_nanousd("1.25").is_err());
        assert!(parse_balance_nanousd("999999999999999999999999999999999999999999999999").is_err());
    }

    #[test]
    fn account_requires_usd_and_matching_status() {
        let account: GatewayAccount = serde_json::from_value(serde_json::json!({
            "balance_nanousd": "-1",
            "currency": "USD",
            "status": "depleted"
        }))
        .expect("account wire shape");
        assert_eq!(account.balance_nanousd_i128(), Ok(-1));

        let mismatch = GatewayAccount {
            balance_nanousd: "0".to_string(),
            currency: "USD".to_string(),
            status: GatewayAccountStatus::Active,
        };
        assert!(mismatch.balance_nanousd_i128().is_err());
    }

    #[test]
    fn token_debug_is_redacted_and_cache_keys_are_isolated() {
        let token = RedactedToken::new("colony-gw-secret".to_string()).expect("token");
        assert!(!format!("{token:?}").contains("colony-gw-secret"));
        let first = GatewayLeaseKey::new("wss://relay.example/", &"aa".repeat(32)).unwrap();
        let other_relay = GatewayLeaseKey::new("wss://other.example/", &"aa".repeat(32)).unwrap();
        let other_owner = GatewayLeaseKey::new("wss://relay.example/", &"bb".repeat(32)).unwrap();
        assert_ne!(first, other_relay);
        assert_ne!(first, other_owner);
        let mut manager = ProvisionedCreditsManager::default();
        manager.replace(GatewayLease {
            key: first.clone(),
            token,
            expires_at: Utc::now() + ChronoDuration::days(30),
        });
        assert!(manager.contains(&first));
    }
}
