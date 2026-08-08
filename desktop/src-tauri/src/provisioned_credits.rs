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
    managed_agents::ManagedAgentRuntimeKey,
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
    /// The generation used for new spawns and already-handed-off pairs.
    lease: GatewayLease,
    refresh_task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// A prior generation retained only for pairs that could not accept the
    /// primary replacement yet. It has no refresh task of its own.
    retained_old: Option<RetainedLease>,
}

struct RetainedLease {
    lease: GatewayLease,
    pair_keys: Vec<ManagedAgentRuntimeKey>,
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

    fn replace_primary(&mut self, lease: GatewayLease, retained_old: Option<RetainedLease>) {
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
                retained_old,
            },
        );
    }

    fn retained_snapshot(
        &self,
        key: &GatewayLeaseKey,
    ) -> Option<(GatewayLease, GatewayLease, Vec<ManagedAgentRuntimeKey>)> {
        let entry = self.leases.get(key)?;
        let retained = entry.retained_old.as_ref()?;
        Some((
            entry.lease.clone(),
            retained.lease.clone(),
            retained.pair_keys.clone(),
        ))
    }

    fn is_current_generation(
        &self,
        key: &GatewayLeaseKey,
        expires_at: DateTime<Utc>,
        token: &RedactedToken,
    ) -> bool {
        self.leases.get(key).is_some_and(|entry| {
            entry.lease.expires_at == expires_at && entry.lease.token == *token
        })
    }

    fn update_retained_old(
        &mut self,
        key: &GatewayLeaseKey,
        pair_keys: Vec<ManagedAgentRuntimeKey>,
    ) -> Option<GatewayLease> {
        let entry = self.leases.get_mut(key)?;
        if pair_keys.is_empty() {
            return entry.retained_old.take().map(|retained| retained.lease);
        }
        if let Some(retained) = entry.retained_old.as_mut() {
            retained.pair_keys = pair_keys;
        }
        None
    }

    #[cfg(test)]
    fn retained_pair_keys(&self, key: &GatewayLeaseKey) -> Vec<ManagedAgentRuntimeKey> {
        self.leases
            .get(key)
            .and_then(|entry| entry.retained_old.as_ref())
            .map(|retained| retained.pair_keys.clone())
            .unwrap_or_default()
    }

    fn take_retained_old(&mut self, key: &GatewayLeaseKey) -> Option<GatewayLease> {
        self.leases
            .get_mut(key)
            .and_then(|entry| entry.retained_old.take())
            .map(|retained| retained.lease)
    }

    fn schedule_refresh(&mut self, app: &AppHandle, lease: &GatewayLease) {
        let key = lease.key.clone();
        let expires_at = lease.expires_at;
        let token = lease.token.clone();
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
                let _ = refresh_lease_blocking(&app_for_refresh, &key_for_task, expires_at, token);
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
    rotate_lease_blocking(
        app,
        &key,
        force,
        if force {
            RotationReason::ManualReconnect
        } else {
            RotationReason::Ensure
        },
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RotationReason {
    Ensure,
    ManualReconnect,
    ScheduledRefresh,
}

fn refresh_lease_blocking(
    app: &AppHandle,
    key: &GatewayLeaseKey,
    expected_expires_at: DateTime<Utc>,
    expected_token: RedactedToken,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let exists = {
        let manager = state
            .provisioned_credits
            .lock()
            .map_err(|error| error.to_string())?;
        manager.is_current_generation(key, expected_expires_at, &expected_token)
    };
    if !exists {
        return Ok(());
    }
    let _ = rotate_lease_blocking(app, key, true, RotationReason::ScheduledRefresh)?;
    Ok(())
}

/// Mint and safely rotate a lease. The manager lock remains held through the
/// replacement handoff so concurrent ensure/refresh calls cannot mint a
/// second replacement for the same relay/owner pair. During a partial handoff
/// the replacement is primary and the old generation is retained with the
/// exact failed-pair keys until a later retry converges them.
fn rotate_lease_blocking(
    app: &AppHandle,
    key: &GatewayLeaseKey,
    force: bool,
    reason: RotationReason,
) -> Result<GatewayLease, String> {
    let state = app.state::<AppState>();
    let mut manager = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?;
    if let Some(cached) = manager.cached(key, force) {
        return Ok(cached);
    }

    // A partial handoff creates two generations: the replacement is primary
    // for new/already-handed-off pairs, while the retained old lease stays
    // live only for the explicitly listed pairs that still use it. Manual
    // reconnect first retries that exact subset rather than minting a third
    // generation. Scheduled refresh also converges the subset before minting
    // its next primary replacement.
    if let Some((primary, _old, old_pair_keys)) = manager.retained_snapshot(key) {
        let handoff = crate::managed_agents::handoff_provisioned_credits_pairs(
            app,
            &primary,
            Some(&old_pair_keys),
        );
        match handoff {
            Ok(outcome) if outcome.remaining_old_keys.is_empty() => {
                let old_to_revoke = manager.take_retained_old(key);
                drop(manager);
                if let Some(old) = old_to_revoke {
                    let _ = revoke_lease(app, &old);
                }
                if matches!(reason, RotationReason::ManualReconnect) {
                    return Ok(primary);
                }
                manager = state
                    .provisioned_credits
                    .lock()
                    .map_err(|error| error.to_string())?;
            }
            Ok(outcome) => {
                manager.update_retained_old(key, outcome.remaining_old_keys);
                return Err(
                    "Colony Credits reconnect incomplete — retry reconnect to resume remaining agents"
                        .to_string(),
                );
            }
            Err(error) => {
                let old_to_revoke = if error.remaining_old_keys.is_empty() {
                    manager.take_retained_old(key)
                } else {
                    manager.update_retained_old(key, error.remaining_old_keys);
                    None
                };
                drop(manager);
                if let Some(old) = old_to_revoke {
                    let _ = revoke_lease(app, &old);
                }
                return Err(error.message);
            }
        }
    }

    let old = manager.leases.get(key).map(|entry| entry.lease.clone());
    let replacement = mint_lease(app, key.clone())?;
    if let Some(old_primary) = old.clone() {
        match crate::managed_agents::handoff_provisioned_credits_pairs(app, &replacement, None) {
            Ok(outcome) if outcome.remaining_old_keys.is_empty() => {}
            Ok(outcome) => {
                manager.replace_primary(
                    replacement.clone(),
                    Some(RetainedLease {
                        lease: old_primary.clone(),
                        pair_keys: outcome.remaining_old_keys,
                    }),
                );
                manager.schedule_refresh(app, &replacement);
                return Err(
                    "Colony Credits reconnect incomplete — retry reconnect to resume remaining agents"
                        .to_string(),
                );
            }
            Err(error) => {
                if error.replacement_in_use {
                    // One or more pairs now depend on the replacement. Make it
                    // primary immediately and retain the old raw token plus the
                    // exact failed-pair keys. New spawns therefore always receive
                    // the replacement; old is revoked only after those keys have
                    // converged on a later explicit retry.
                    let retained_old = Some(RetainedLease {
                        lease: old_primary,
                        pair_keys: error.remaining_old_keys.clone(),
                    });
                    manager.replace_primary(replacement.clone(), retained_old);
                    manager.schedule_refresh(app, &replacement);
                    if error.remaining_old_keys.is_empty() {
                        let old_to_revoke = manager.take_retained_old(key);
                        drop(manager);
                        if let Some(old) = old_to_revoke {
                            let _ = revoke_lease(app, &old);
                        }
                    }
                } else {
                    // No pair accepted the replacement, so the old lease remains
                    // the sole working credential and the unused mint is safe to
                    // revoke.
                    let _ = revoke_lease(app, &replacement);
                }
                return Err(error.message);
            }
        }
    }

    manager.replace_primary(replacement.clone(), None);
    manager.schedule_refresh(app, &replacement);
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
    let _ = rotate_lease_blocking(app, &key, true, RotationReason::ManualReconnect)?;
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
            let mut first_error = None;
            for lease in std::iter::once(entry.lease).chain(
                entry
                    .retained_old
                    .into_iter()
                    .map(|retained| retained.lease),
            ) {
                if let Err(error) = revoke_lease(app, &lease) {
                    first_error.get_or_insert(error);
                }
            }
            if let Some(error) = first_error {
                return Err(error);
            }
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
        manager.replace_primary(
            GatewayLease {
                key: first.clone(),
                token,
                expires_at: Utc::now() + ChronoDuration::days(30),
            },
            None,
        );
        assert!(manager.contains(&first));
    }

    fn test_key(owner_byte: char) -> ManagedAgentRuntimeKey {
        ManagedAgentRuntimeKey::new(owner_byte.to_string().repeat(64), "wss://relay.example")
            .expect("test runtime key")
    }

    fn test_lease(key: &GatewayLeaseKey, token: &str) -> GatewayLease {
        GatewayLease {
            key: key.clone(),
            token: RedactedToken::new(token.to_string()).expect("test token"),
            expires_at: Utc::now() + ChronoDuration::days(30),
        }
    }

    #[test]
    fn partial_handoff_keeps_replacement_primary_and_old_for_failed_pair() {
        let cache_key =
            GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
        let old_pair = test_key('b');
        let successful_pair = test_key('c');
        let old = test_lease(&cache_key, "old-generation");
        let replacement = test_lease(&cache_key, "replacement-generation");
        let mut manager = ProvisionedCreditsManager::default();
        manager.replace_primary(
            replacement.clone(),
            Some(RetainedLease {
                lease: old.clone(),
                pair_keys: vec![old_pair.clone()],
            }),
        );

        assert_eq!(
            manager
                .cached(&cache_key, false)
                .expect("primary lease")
                .token
                .as_str(),
            replacement.token.as_str()
        );
        assert_eq!(manager.retained_pair_keys(&cache_key), vec![old_pair]);
        assert_eq!(
            manager
                .retained_snapshot(&cache_key)
                .expect("retained generation")
                .1
                .token
                .as_str(),
            old.token.as_str()
        );
        assert!(!manager
            .retained_pair_keys(&cache_key)
            .contains(&successful_pair));
    }

    #[test]
    fn retry_converges_retained_pairs_and_takes_old_once() {
        let cache_key =
            GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
        let old = test_lease(&cache_key, "old-generation");
        let replacement = test_lease(&cache_key, "replacement-generation");
        let mut manager = ProvisionedCreditsManager::default();
        manager.replace_primary(
            replacement,
            Some(RetainedLease {
                lease: old.clone(),
                pair_keys: vec![test_key('b')],
            }),
        );

        let old_to_revoke = manager.update_retained_old(&cache_key, vec![]);
        assert_eq!(
            old_to_revoke.as_ref().map(|lease| lease.token.as_str()),
            Some(old.token.as_str())
        );
        assert!(manager.retained_pair_keys(&cache_key).is_empty());
        assert!(manager.take_retained_old(&cache_key).is_none());
    }

    #[test]
    fn new_spawn_after_partial_handoff_reads_replacement_primary() {
        let cache_key =
            GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
        let replacement = test_lease(&cache_key, "replacement-generation");
        let mut manager = ProvisionedCreditsManager::default();
        manager.replace_primary(
            replacement.clone(),
            Some(RetainedLease {
                lease: test_lease(&cache_key, "old-generation"),
                pair_keys: vec![test_key('b')],
            }),
        );

        let spawn_lease = manager.cached(&cache_key, false).expect("spawn lease");
        assert_eq!(spawn_lease.token.as_str(), replacement.token.as_str());
    }

    #[test]
    fn replaced_primary_invalidates_the_prior_refresh_generation() {
        let cache_key =
            GatewayLeaseKey::new("wss://relay.example", &"aa".repeat(32)).expect("cache key");
        let old = test_lease(&cache_key, "old-generation");
        let replacement = test_lease(&cache_key, "replacement-generation");
        let mut manager = ProvisionedCreditsManager::default();
        manager.replace_primary(old.clone(), None);
        manager.replace_primary(replacement.clone(), None);

        assert!(!manager.is_current_generation(&cache_key, old.expires_at, &old.token));
        assert!(manager.is_current_generation(
            &cache_key,
            replacement.expires_at,
            &replacement.token
        ));
    }
}
