//! Runtime-owned Colony Credits gateway leases.
//!
//! The desktop never persists a gateway token.  A lease is bound to the
//! normalized relay origin and the owner's public key, and is kept only for
//! the lifetime of the Tauri process.  Managed-agent spawn code consumes the
//! lease at the existing `BUZZ_METER_OPENAI_*` seam.

use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Utc};
use nostr::Keys;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState, managed_agents::ManagedAgentRuntimeKey,
    relay::build_nip98_auth_header_for_keys,
};

/// Gateway token lifetime requested by the desktop. Short-lived leases bound
/// the credential exposure window when a process exits before graceful drain.
pub const GATEWAY_TOKEN_TTL_SECS: u64 = 24 * 60 * 60;
/// Refresh lead time required by the Phase 1 lease contract.
pub const GATEWAY_REFRESH_LEAD_SECS: i64 = 24 * 60 * 60;

/// Canonicalize a relay URL to the HTTP origin used by gateway APIs.
///
/// Gateway leases are keyed by this value, so equivalent websocket URLs must
/// produce one key. Paths and queries belong to the relay websocket endpoint,
/// never to the gateway origin; credentials and fragments are rejected rather
/// than silently changing the authenticated target.
pub fn normalized_relay_http_origin(relay_url: &str) -> Result<String, String> {
    let parsed =
        url::Url::parse(relay_url.trim()).map_err(|error| format!("invalid relay URL: {error}"))?;
    let scheme = match parsed.scheme().to_ascii_lowercase().as_str() {
        "ws" | "http" => "http",
        "wss" | "https" => "https",
        other => return Err(format!("unsupported relay URL scheme `{other}`")),
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("relay URL credentials are not allowed".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("relay URL fragments are not allowed".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "relay URL host is missing".to_string())?
        .to_ascii_lowercase();
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    let default_port = (scheme == "http" && parsed.port() == Some(80))
        || (scheme == "https" && parsed.port() == Some(443));
    let port = parsed
        .port()
        .filter(|_| !default_port)
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(format!("{scheme}://{host}{port}"))
}

/// Return the exact OpenAI-compatible gateway upstream used by the local
/// meter. The meter appends paths such as `v1/chat/completions` itself.
pub fn normalized_gateway_upstream(relay_url: &str) -> Result<String, String> {
    Ok(format!(
        "{}/gateway/openai",
        normalized_relay_http_origin(relay_url)?
    ))
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

/// Typed account response using integer-safe decimal strings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GatewayAccount {
    pub balance_nanousd: String,
    pub total_balance_nanousd: String,
    pub discovery_reserved_nanousd: String,
    pub available_balance_nanousd: String,
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
        let total = parse_balance_nanousd(&self.total_balance_nanousd)?;
        let reserved = parse_balance_nanousd(&self.discovery_reserved_nanousd)?;
        let available = parse_balance_nanousd(&self.available_balance_nanousd)?;
        if reserved < 0 || available != total.saturating_sub(reserved) || balance != available {
            return Err("gateway account balance breakdown is inconsistent".to_string());
        }
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
    pub(crate) fn new(value: String) -> Result<Self, String> {
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
        let relay_origin = normalized_relay_http_origin(relay_url)?;
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
#[derive(Clone)]
pub struct GatewayLease {
    /// Relay/owner identity this token is bound to.
    pub key: GatewayLeaseKey,
    /// Opaque gateway token, redacted in debug output.
    pub token: RedactedToken,
    /// Monotonic generation within the relay/owner cache key.
    pub generation: u64,
    /// Relay-provided expiry.
    pub expires_at: DateTime<Utc>,
    /// Cancellable proactive refresh deadline. For a lease whose total TTL is
    /// at most the 24-hour lead, this is the midpoint of its actual lifetime;
    /// otherwise it is the literal `expires_at - 24h` deadline. Keeping the
    /// computed instant avoids an immediate refresh loop for the Phase 1
    /// 24-hour lease while still refreshing before expiry.
    pub(crate) refresh_at: DateTime<Utc>,
    /// Exact signer captured when this lease was minted. It is never read
    /// from mutable AppState during revoke or refresh, so an identity swap
    /// cannot cross-wire an owner-A cache entry with owner-B credentials.
    pub(crate) signer: Arc<Keys>,
}

impl PartialEq for GatewayLease {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
            && self.token == other.token
            && self.generation == other.generation
            && self.expires_at == other.expires_at
            && self.refresh_at == other.refresh_at
    }
}

impl Eq for GatewayLease {}

impl fmt::Debug for GatewayLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayLease")
            .field("key", &self.key)
            .field("token", &self.token)
            .field("generation", &self.generation)
            .field("expires_at", &self.expires_at)
            .field("refresh_at", &self.refresh_at)
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
    /// Per relay/owner singleflight gates. A gate is held while minting and
    /// handing off one key, but the manager mutex itself is never held across
    /// network or process I/O. Different keys therefore make progress in
    /// parallel and same-key callers converge on one generation.
    rotation_gates: HashMap<GatewayLeaseKey, Arc<Mutex<()>>>,
    pending_revocations: Vec<GatewayLease>,
    next_generation: HashMap<GatewayLeaseKey, u64>,
    /// Once closed, no rotation may mint, install, or schedule a lease.
    closed: bool,
    /// Identity replacement drains all old-owner gates before the new keys
    /// become visible to spawn/refresh. This flag closes the race window while
    /// the captured old signers are being revoked.
    identity_transitioning: bool,
}

impl ProvisionedCreditsManager {
    fn rotation_gate(&mut self, key: &GatewayLeaseKey) -> Arc<Mutex<()>> {
        self.rotation_gates
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn begin_shutdown(&mut self) -> Vec<Arc<Mutex<()>>> {
        self.closed = true;
        self.rotation_gates.values().cloned().collect()
    }

    fn begin_identity_transition(&mut self) -> Vec<Arc<Mutex<()>>> {
        self.identity_transitioning = true;
        self.rotation_gates.values().cloned().collect()
    }

    fn finish_identity_transition(&mut self) {
        self.identity_transitioning = false;
    }

    fn is_closed(&self) -> bool {
        self.closed
    }

    fn is_identity_transitioning(&self) -> bool {
        self.identity_transitioning
    }

    fn remove_owner_entries(&mut self, owner_pubkey: &str) -> Vec<GatewayLease> {
        let owner_pubkey = owner_pubkey.to_ascii_lowercase();
        let keys: Vec<_> = self
            .leases
            .keys()
            .filter(|key| key.owner_pubkey != owner_pubkey)
            .cloned()
            .collect();
        let mut removed = Vec::new();
        for key in keys {
            if let Some(entry) = self.leases.remove(&key) {
                if let Some(task) = entry.refresh_task {
                    task.abort();
                }
                removed.push(entry.lease);
                if let Some(retained) = entry.retained_old {
                    removed.push(retained.lease);
                }
            }
            self.next_generation.remove(&key);
        }
        self.rotation_gates
            .retain(|key, _| key.owner_pubkey == owner_pubkey);
        let pending = std::mem::take(&mut self.pending_revocations);
        for lease in pending {
            if lease.key.owner_pubkey != owner_pubkey {
                removed.push(lease);
            } else {
                self.pending_revocations.push(lease);
            }
        }
        deduplicate_leases(&mut removed);
        removed
    }

    fn reserve_generation(&mut self, key: &GatewayLeaseKey) -> u64 {
        let generation = self.next_generation.entry(key.clone()).or_insert(0);
        *generation = generation.saturating_add(1);
        *generation
    }

    fn cached(&self, key: &GatewayLeaseKey, force: bool) -> Option<GatewayLease> {
        let entry = self.leases.get(key)?;
        if !force && Utc::now() < entry.lease.refresh_at && entry.lease.expires_at > Utc::now() {
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

    fn is_current_generation(&self, key: &GatewayLeaseKey, generation: u64) -> bool {
        self.leases
            .get(key)
            .is_some_and(|entry| entry.lease.generation == generation)
    }

    fn enqueue_revocation(&mut self, lease: GatewayLease) {
        if self
            .pending_revocations
            .iter()
            .any(|pending| pending.token == lease.token)
        {
            return;
        }
        self.pending_revocations.push(lease);
    }

    fn pending_snapshot(&self) -> Vec<GatewayLease> {
        self.pending_revocations.clone()
    }

    fn remove_pending(&mut self, token: &RedactedToken) {
        self.pending_revocations
            .retain(|pending| pending.token != *token);
    }

    fn take_all_leases(&mut self) -> Vec<GatewayLease> {
        let mut leases = Vec::new();
        for (_, entry) in self.leases.drain() {
            if let Some(task) = entry.refresh_task {
                task.abort();
            }
            if !leases
                .iter()
                .any(|lease: &GatewayLease| lease.token == entry.lease.token)
            {
                leases.push(entry.lease);
            }
            if let Some(retained) = entry.retained_old {
                if !leases
                    .iter()
                    .any(|lease: &GatewayLease| lease.token == retained.lease.token)
                {
                    leases.push(retained.lease);
                }
            }
        }
        for pending in self.pending_revocations.drain(..) {
            if !leases
                .iter()
                .any(|lease: &GatewayLease| lease.token == pending.token)
            {
                leases.push(pending);
            }
        }
        leases
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
        if self.closed || self.identity_transitioning {
            return;
        }
        let key = lease.key.clone();
        let generation = lease.generation;
        let refresh_at = lease.refresh_at;
        let delay = (refresh_at - Utc::now())
            .to_std()
            .unwrap_or_else(|_| Duration::from_secs(0));
        let app = app.clone();
        let key_for_task = key.clone();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let app_for_refresh = app.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = refresh_lease_blocking(&app_for_refresh, &key_for_task, generation);
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

include!("provisioned_credits/lease_http.rs");

/// Ensure a lease for a managed-agent spawn. This is synchronous because the
/// existing spawn boundary is synchronous; callers invoke it from the same
/// blocking path used for process creation.
pub fn ensure_lease_blocking(
    app: &AppHandle,
    relay_url: &str,
    explicit_owner: Option<&str>,
    force: bool,
) -> Result<GatewayLease, String> {
    let (owner, _) = capture_owner_signer(app, explicit_owner)?;
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
    expected_generation: u64,
) -> Result<(), String> {
    let _ = rotate_lease_blocking_with_expected(
        app,
        key,
        true,
        RotationReason::ScheduledRefresh,
        Some(expected_generation),
    )?;
    Ok(())
}

fn revoke_or_queue(app: &AppHandle, lease: GatewayLease) {
    if revoke_lease(app, &lease).is_err() {
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut manager) = state.provisioned_credits.lock() {
                manager.enqueue_revocation(lease);
            }
        }
    }
}

fn retry_pending_revocations(app: &AppHandle) {
    let pending = app.try_state::<AppState>().and_then(|state| {
        state
            .provisioned_credits
            .lock()
            .ok()
            .map(|m| m.pending_snapshot())
    });
    let Some(pending) = pending else { return };
    for lease in pending {
        if revoke_lease(app, &lease).is_ok() {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut manager) = state.provisioned_credits.lock() {
                    manager.remove_pending(&lease.token);
                }
            }
        }
    }
}

/// Close the lease manager for an owner transition, wait for every in-flight
/// operation on the old keys, remove their cache/timers, and revoke using each
/// lease's captured signer. The manager remains closed to rotations until the
/// caller has installed the replacement identity and calls
/// [`finish_identity_transition`].
pub(crate) fn begin_identity_transition(
    app: &AppHandle,
    new_owner_pubkey: &str,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let gates = {
        let mut manager = state
            .provisioned_credits
            .lock()
            .map_err(|error| error.to_string())?;
        if manager.is_closed() {
            return Err("desktop shutdown has started; identity transition refused".to_string());
        }
        manager.begin_identity_transition()
    };
    for gate in gates {
        let _drain = gate.lock().map_err(|error| error.to_string())?;
    }
    let old_leases = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?
        .remove_owner_entries(new_owner_pubkey);
    for lease in old_leases {
        revoke_or_queue(app, lease);
    }
    Ok(())
}

/// Re-open lease operations after the caller has atomically installed the new
/// signing identity. A failed transition must also call this so the desktop
/// does not remain permanently unable to spawn provisioned agents.
pub(crate) fn finish_identity_transition(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?
        .finish_identity_transition();
    Ok(())
}

/// Close all future rotations and wait for any current per-key operation to
/// finish before the shutdown drain takes its single lease snapshot.
pub(crate) fn prepare_provisioned_credits_shutdown(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let gates = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?
        .begin_shutdown();
    for gate in gates {
        let _drain = gate.lock().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Mint and safely rotate a lease. Only the per relay/owner singleflight gate
/// is held across network/runtime work; the manager mutex is acquired only to
/// snapshot or commit state. This prevents unrelated keys from stalling and
/// removes the runtime-transition/lease-manager lock inversion.
fn rotate_lease_blocking(
    app: &AppHandle,
    key: &GatewayLeaseKey,
    force: bool,
    reason: RotationReason,
) -> Result<GatewayLease, String> {
    rotate_lease_blocking_with_expected(app, key, force, reason, None)
}

fn rotate_lease_blocking_with_expected(
    app: &AppHandle,
    key: &GatewayLeaseKey,
    force: bool,
    reason: RotationReason,
    expected_generation: Option<u64>,
) -> Result<GatewayLease, String> {
    let state = app.state::<AppState>();
    let gate = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?
        .rotation_gate(key);
    let _singleflight = gate.lock().map_err(|error| error.to_string())?;
    let manager = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?;
    if manager.is_closed() {
        return Err("desktop shutdown has started; Colony Credits rotation refused".to_string());
    }
    if manager.is_identity_transitioning() {
        return Err(
            "Colony Credits identity transition in progress; retry after reconnect".to_string(),
        );
    }
    // Capture the signer while the per-key gate is held. Identity replacement
    // sets the transition flag before changing AppState keys and waits for
    // this gate, so this signer remains bound to the whole operation.
    let signer = Arc::new(state.signing_keys()?);
    if !signer
        .public_key()
        .to_hex()
        .eq_ignore_ascii_case(&key.owner_pubkey)
    {
        return Err("Colony Credits owner changed; reconnect the active identity".to_string());
    }
    drop(manager);
    retry_pending_revocations(app);
    let mut manager = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?;
    if manager.is_closed() {
        return Err("desktop shutdown has started; Colony Credits rotation refused".to_string());
    }
    if manager.is_identity_transitioning() {
        return Err(
            "Colony Credits identity transition in progress; retry after reconnect".to_string(),
        );
    }
    // The expected-generation check is deliberately inside the singleflight
    // critical section. A stale scheduled callback cannot pass this check,
    // drop the lock, and then rotate a newer manual generation.
    if let Some(expected) = expected_generation {
        if !manager.is_current_generation(key, expected) {
            return manager
                .leases
                .get(key)
                .map(|entry| entry.lease.clone())
                .ok_or_else(|| "stale Colony Credits refresh ignored".to_string());
        }
    }
    if let Some(cached) = manager.cached(key, force) {
        return Ok(cached);
    }

    // A partial handoff creates two generations: the replacement is primary
    // for new/already-handed-off pairs, while the retained old lease stays
    // live only for the explicitly listed pairs that still use it. Manual
    // reconnect first retries that exact subset rather than minting a third
    // generation. Scheduled refresh also converges the subset before minting
    // its next primary replacement.
    if let Some((primary, old, old_pair_keys)) = manager.retained_snapshot(key) {
        drop(manager);
        let handoff = crate::managed_agents::handoff_provisioned_credits_pairs(
            app,
            &primary,
            Some(&old_pair_keys),
            Some(&old),
        );
        manager = state
            .provisioned_credits
            .lock()
            .map_err(|error| error.to_string())?;
        if manager.is_closed() {
            manager.enqueue_revocation(primary);
            return Err("desktop shutdown started during Colony Credits handoff".to_string());
        }
        match handoff {
            Ok(outcome) if outcome.remaining_old_keys.is_empty() => {
                let old_to_revoke = manager.take_retained_old(key);
                drop(manager);
                if let Some(old) = old_to_revoke {
                    revoke_or_queue(app, old);
                }
                if !matches!(reason, RotationReason::ScheduledRefresh) {
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
                    revoke_or_queue(app, old);
                }
                return Err(error.message);
            }
        }
    }

    let old = manager.leases.get(key).map(|entry| entry.lease.clone());
    let generation = manager.reserve_generation(key);
    drop(manager);
    let replacement = mint_lease(app, key.clone(), generation, signer)?;
    // Identity transition may have started while the HTTP request was in
    // flight. Do not hand the replacement to any process in that case; the
    // captured signer can safely revoke it without consulting mutable keys.
    let rotation_closed = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?
        .is_closed();
    if rotation_closed {
        if let Ok(mut manager) = state.provisioned_credits.lock() {
            manager.enqueue_revocation(replacement.clone());
        }
        return Err("desktop shutdown started during Colony Credits mint".to_string());
    }
    let identity_transitioning = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?
        .is_identity_transitioning();
    if identity_transitioning {
        revoke_or_queue(app, replacement.clone());
        return Err("Colony Credits identity changed during rotation; retry reconnect".to_string());
    }
    if let Some(old_primary) = old.clone() {
        match crate::managed_agents::handoff_provisioned_credits_pairs(
            app,
            &replacement,
            None,
            Some(&old_primary),
        ) {
            Ok(outcome) if outcome.remaining_old_keys.is_empty() => {}
            Ok(outcome) => {
                let mut manager = state
                    .provisioned_credits
                    .lock()
                    .map_err(|error| error.to_string())?;
                if manager.is_closed() {
                    manager.enqueue_revocation(replacement);
                    return Err(
                        "desktop shutdown started during Colony Credits handoff".to_string()
                    );
                }
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
                    let mut manager = state
                        .provisioned_credits
                        .lock()
                        .map_err(|error| error.to_string())?;
                    if manager.is_closed() {
                        manager.enqueue_revocation(replacement);
                        return Err(
                            "desktop shutdown started during Colony Credits handoff".to_string()
                        );
                    }
                    manager.replace_primary(replacement.clone(), retained_old);
                    manager.schedule_refresh(app, &replacement);
                    if error.remaining_old_keys.is_empty() {
                        let old_to_revoke = manager.take_retained_old(key);
                        drop(manager);
                        if let Some(old) = old_to_revoke {
                            revoke_or_queue(app, old);
                        }
                    }
                } else {
                    // No pair accepted the replacement, so the old lease remains
                    // the sole working credential and the unused mint is safe to
                    // revoke.
                    revoke_or_queue(app, replacement.clone());
                }
                return Err(error.message);
            }
        }
        let mut manager = state
            .provisioned_credits
            .lock()
            .map_err(|error| error.to_string())?;
        if manager.is_closed() {
            manager.enqueue_revocation(replacement);
            return Err("desktop shutdown started during Colony Credits handoff".to_string());
        }
        manager.replace_primary(replacement.clone(), None);
        manager.schedule_refresh(app, &replacement);
        drop(manager);
        revoke_or_queue(app, old_primary);
        return Ok(replacement);
    }

    let mut manager = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?;
    if manager.is_closed() {
        manager.enqueue_revocation(replacement);
        return Err("desktop shutdown started during Colony Credits mint".to_string());
    }
    manager.replace_primary(replacement.clone(), None);
    manager.schedule_refresh(app, &replacement);
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
    let (owner, _) = capture_owner_signer(app, explicit_owner)?;
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
    let Some(entry) = entry else { return Ok(()) };
    if let Some(task) = entry.refresh_task {
        task.abort();
    }
    if !revoke {
        return Ok(());
    }
    let leases = std::iter::once(entry.lease).chain(
        entry
            .retained_old
            .into_iter()
            .map(|retained| retained.lease),
    );
    for lease in leases {
        revoke_or_queue(app, lease);
    }
    Ok(())
}

/// Gracefully revoke every active and pending lease before process shutdown.
/// The bounded retry keeps shutdown from hanging indefinitely. If the relay is
/// still unreachable, the process-local raw reference is intentionally
/// discarded with an explicit <=24h residual-exposure error; there is no
/// in-memory reconnect after process exit.
pub fn drain_provisioned_credits_blocking(app: &AppHandle) -> Result<(), String> {
    prepare_provisioned_credits_shutdown(app)?;
    let state = app.state::<AppState>();
    let leases = state
        .provisioned_credits
        .lock()
        .map_err(|error| error.to_string())?
        .take_all_leases();
    let mut first_error = None;
    for lease in leases {
        let mut revoked = false;
        for attempt in 0..3 {
            match revoke_lease(app, &lease) {
                Ok(()) => {
                    revoked = true;
                    break;
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                    if attempt < 2 {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
        // The process is exiting, so retaining a retry reference in a
        // process-local queue would be misleading: there is no later in-memory
        // reconnect. Expiry validation bounds the residual exposure to <=24h.
        if !revoked {
            let residual = "Colony Credits revoke remained unreachable; the token is bounded by its <=24h expiry and will not be retried after shutdown";
            first_error = Some(match first_error.take() {
                Some(error) => format!("{error}; {residual}"),
                None => residual.to_string(),
            });
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests;
