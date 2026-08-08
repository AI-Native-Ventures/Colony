//! Colony Credits hosted gateway: an OpenAI-compatible endpoint on the relay
//! that fronts Vercel AI Gateway.
//!
//! Provisioned mode in one path: a Colony gateway token authenticates the
//! call, the request model is checked against the deployment's `model_catalog`
//! and translated to its Vercel slug, the call is forwarded with the
//! server-held Vercel key (the Colony token never leaves this process), the
//! stream is teed so the observed cost can be read off the wire, and the
//! account is debited exactly once using the upstream response id as the
//! idempotency reference.
//!
//! Settling is **synchronous and awaited before the terminal chunk is
//! forwarded** (decision 2026-08-08): the client cannot see the end of the
//! response until the debit has committed, so "the call happened" and "the
//! ledger says so" are the same instant. The final chunk is held back one
//! position; when the upstream stream ends, the settle runs inline (with a
//! small bounded retry for transient DB errors) and only then is the held
//! chunk released. The residual window is a crash inside the settle itself,
//! bounded to one call, which is what daily reconciliation is for. A client
//! that hangs up mid-stream drops the tee; that path settles best-effort
//! from whatever the wire said.
//!
//! Everything here is mounted only when `VERCEL_AI_GATEWAY_KEY` is
//! configured; without it the routes do not exist and return 404.
//!
//! The wire shape is pinned by real captures in `buzz-meter-core`'s fixture
//! suite: Vercel injects its own `usage` object with a float `cost` in
//! dollars alongside integer token counts, in the body only (never a header),
//! and the streaming terminal chunk carries it without `stream_options`.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::{AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use buzz_core::ledger::prices::PriceBook;
use buzz_meter_core::openai;
use buzz_meter_core::ParsedUsage;
use chrono::Utc;
use dashmap::DashMap;
use futures_util::stream::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The upstream this gateway fronts. Vercel AI Gateway is the default; the
/// relay's existing credential seam style means swapping the hop later is an
/// env var, not a migration.
const DEFAULT_UPSTREAM: &str = "https://ai-gateway.vercel.sh";

/// Prefix every minted Colony gateway token carries.
const TOKEN_PREFIX: &str = "colony-gw-";

/// Minimum balance to admit a call, in nanoUSD ($0.05).
///
/// The hard part of the spec is explicit: do not build a reservation system.
/// Admit at $0.05, debit the observed cost on settle, hard-block later at
/// admission control. Worst case overdraft is one call on an account that
/// already paid.
const ADMISSION_FLOOR_NANOUSD: i64 = 50_000_000;

/// Default cost used by the no-reservation balance guard: $0.05.
const DEFAULT_TYPICAL_CALL_COST_NANOUSD: i64 = 50_000_000;

/// Default maximum concurrent provisioned calls per account.
const DEFAULT_MAX_IN_FLIGHT: u32 = 4;

/// Default rolling one-hour spend cap per account: $5.
const DEFAULT_HOURLY_BURN_CAP_NANOUSD: i64 = 5_000_000_000;

/// The durable/cache admission spend window.
const BURN_WINDOW: chrono::Duration = chrono::Duration::hours(1);

/// How many times a settle is attempted inline before giving up. A transient
/// DB error (connection drop, lock timeout) should not turn one failed write
/// into a permanently unbilled call; the retry replays the same idempotency
/// ref, so `UNIQUE (pubkey, ref)` keeps it exactly-once.
const SETTLE_MAX_ATTEMPTS: usize = 3;

/// Backoff between settle attempts, milliseconds. Doubles per attempt, so
/// the worst-case tail is 50ms + 100ms before the terminal chunk is released.
const SETTLE_RETRY_BACKOFF_MS: u64 = 50;

/// How much of a response body is kept for parsing. Past this, the body keeps
/// streaming to the client but the copy is abandoned (no settle for that
/// call — logged loudly, and reconciliation points at it).
const MAX_TEE_BYTES: usize = 8 * 1024 * 1024;

/// Ceiling on a buffered request body. Large enough for a long-context
/// prompt and small enough that a runaway agent cannot exhaust memory.
const MAX_REQUEST_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Default minted token lifetime: 30 days.
const DEFAULT_TOKEN_TTL_SECS: u64 = 60 * 60 * 24 * 30;

/// Minimum minted token lifetime: 1 minute.
const MIN_TOKEN_TTL_SECS: u64 = 60;

/// Maximum minted token lifetime: 365 days.
const MAX_TOKEN_TTL_SECS: u64 = 60 * 60 * 24 * 365;

/// Gateway configuration, read once from the environment.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    /// Server-held Vercel AI Gateway key. Never leaves this process.
    pub api_key: String,
    /// Upstream base URL (`/v1/chat/completions` is appended).
    pub base_url: String,
    /// Deployment default typical call cost, in nanoUSD.
    pub default_typical_call_cost_nanousd: i64,
    /// Deployment default concurrent call limit per account.
    pub default_max_in_flight: u32,
    /// Deployment default rolling one-hour spend cap, in nanoUSD.
    pub default_hourly_burn_cap_nanousd: i64,
}

/// Read gateway config from the environment.
///
/// `Some` only when `VERCEL_AI_GATEWAY_KEY` is set and non-blank — that is
/// the enable switch. `VERCEL_AI_GATEWAY_BASE_URL` overrides the default
/// upstream. A set-but-blank key disables the gateway rather than crashing
/// the relay, matching how the meter treats unset credentials.
pub fn config_from_env() -> anyhow::Result<Option<GatewayConfig>> {
    let api_key = match std::env::var("VERCEL_AI_GATEWAY_KEY") {
        Ok(key) if !key.trim().is_empty() => key,
        _ => return Ok(None),
    };
    let base_url = std::env::var("VERCEL_AI_GATEWAY_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_UPSTREAM.to_string());
    if base_url.trim().is_empty() {
        anyhow::bail!("VERCEL_AI_GATEWAY_BASE_URL must not be blank when the gateway is enabled");
    }
    let default_typical_call_cost_nanousd = positive_i64_env(
        "BUZZ_GATEWAY_DEFAULT_TYPICAL_CALL_COST_NANOUSD",
        DEFAULT_TYPICAL_CALL_COST_NANOUSD,
    )?;
    let default_max_in_flight =
        positive_u32_env("BUZZ_GATEWAY_DEFAULT_MAX_IN_FLIGHT", DEFAULT_MAX_IN_FLIGHT)?;
    let default_hourly_burn_cap_nanousd = positive_i64_env(
        "BUZZ_GATEWAY_DEFAULT_HOURLY_BURN_CAP_NANOUSD",
        DEFAULT_HOURLY_BURN_CAP_NANOUSD,
    )?;
    Ok(Some(GatewayConfig {
        api_key,
        base_url,
        default_typical_call_cost_nanousd,
        default_max_in_flight,
        default_hourly_burn_cap_nanousd,
    }))
}

fn positive_i64_env(name: &str, default: i64) -> anyhow::Result<i64> {
    match std::env::var(name) {
        Ok(raw) => raw
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| anyhow::anyhow!("{name} must be a positive integer")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(anyhow::anyhow!("could not read {name}: {error}")),
    }
}

fn positive_u32_env(name: &str, default: u32) -> anyhow::Result<u32> {
    match std::env::var(name) {
        Ok(raw) => raw
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| anyhow::anyhow!("{name} must be a positive integer")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(anyhow::anyhow!("could not read {name}: {error}")),
    }
}

/// Everything the gateway needs beyond the relay's `AppState`.
pub struct GatewayState {
    config: GatewayConfig,
    client: reqwest::Client,
    /// Price book snapshot, shared with every response tee so the settle
    /// step can price a call the provider did not state a cost for.
    price_book: Arc<PriceBook>,
    /// Single-instance admission authority. This deliberately is not
    /// distributed: Fly currently runs one relay process. A multi-instance
    /// deployment must replace this with shared state before it is safe.
    admission: Arc<AdmissionController>,
}

impl std::fmt::Debug for GatewayState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayState")
            .field("base_url", &self.config.base_url)
            .field("api_key_configured", &(!self.config.api_key.is_empty()))
            .finish_non_exhaustive()
    }
}

impl GatewayState {
    /// Build the gateway state.
    ///
    /// # Errors
    ///
    /// Fails when the upstream HTTP client cannot be built or the effective
    /// price catalog is invalid.
    pub async fn new(config: GatewayConfig, pool: &sqlx::PgPool) -> anyhow::Result<Self> {
        Self::new_with_clock(config, pool, Arc::new(SystemGatewayClock)).await
    }

    async fn new_with_clock(
        config: GatewayConfig,
        pool: &sqlx::PgPool,
        clock: Arc<dyn GatewayClock>,
    ) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|error| anyhow::anyhow!("gateway upstream client: {error}"))?;
        let entries = crate::price_feed::effective_catalog()
            .map_err(|error| anyhow::anyhow!("gateway price book: {error}"))?;
        let price_book = Arc::new(PriceBook { entries });
        let since = clock.now() - BURN_WINDOW;
        let recent = buzz_db::credits::recent_debits(pool, since)
            .await
            .map_err(|error| anyhow::anyhow!("gateway admission rebuild: {error}"))?;
        let admission = Arc::new(AdmissionController::new(
            AdmissionDefaults {
                typical_call_cost_nanousd: config.default_typical_call_cost_nanousd,
                max_in_flight: config.default_max_in_flight,
                hourly_burn_cap_nanousd: config.default_hourly_burn_cap_nanousd,
            },
            clock,
            recent,
        ));
        Ok(Self {
            config,
            client,
            price_book,
            admission,
        })
    }

    #[cfg(test)]
    fn in_flight_for(&self, pubkey: &[u8]) -> u32 {
        self.admission.in_flight_for(pubkey)
    }
}

trait GatewayClock: Send + Sync {
    fn now(&self) -> chrono::DateTime<Utc>;
}

struct SystemGatewayClock;

impl GatewayClock for SystemGatewayClock {
    fn now(&self) -> chrono::DateTime<Utc> {
        Utc::now()
    }
}

#[derive(Debug, Clone, Copy)]
struct AdmissionDefaults {
    typical_call_cost_nanousd: i64,
    max_in_flight: u32,
    hourly_burn_cap_nanousd: i64,
}

#[derive(Debug, Clone)]
struct SpendPoint {
    at: chrono::DateTime<Utc>,
    cost_nanousd: i64,
}

#[derive(Debug, Default)]
struct AccountRuntime {
    in_flight: u32,
    spend_nanousd: i64,
    spend: VecDeque<SpendPoint>,
}

impl AccountRuntime {
    fn prune(&mut self, now: chrono::DateTime<Utc>) {
        let cutoff = now - BURN_WINDOW;
        while self.spend.front().is_some_and(|point| point.at <= cutoff) {
            if let Some(point) = self.spend.pop_front() {
                self.spend_nanousd = self.spend_nanousd.saturating_sub(point.cost_nanousd);
            }
        }
    }

    fn push_spend(&mut self, point: SpendPoint) {
        if point.cost_nanousd <= 0 {
            return;
        }
        self.spend_nanousd = self.spend_nanousd.saturating_add(point.cost_nanousd);
        // Concurrent settles can acquire the account row lock in a different
        // order from their transaction timestamps. Keep the ring ordered by
        // durable ledger time so front-pruning and Retry-After stay exact.
        match self.spend.iter().position(|current| current.at > point.at) {
            Some(index) => self.spend.insert(index, point),
            None => self.spend.push_back(point),
        }
    }

    fn retry_after_secs(&self, cap_nanousd: i64, now: chrono::DateTime<Utc>) -> u64 {
        let mut remaining = self.spend_nanousd;
        for point in &self.spend {
            remaining = remaining.saturating_sub(point.cost_nanousd);
            if remaining < cap_nanousd {
                let millis = (point.at + BURN_WINDOW - now).num_milliseconds().max(1);
                return u64::try_from((millis + 999) / 1000).unwrap_or(1).max(1);
            }
        }
        1
    }
}

struct AccountAdmissionEntry {
    /// Serializes balance reads/admission with settle-and-release for one
    /// account, closing the stale-balance window around a completed debit.
    gate: tokio::sync::Mutex<()>,
    runtime: Mutex<AccountRuntime>,
}

impl Default for AccountAdmissionEntry {
    fn default() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
            runtime: Mutex::new(AccountRuntime::default()),
        }
    }
}

struct AdmissionController {
    entries: DashMap<Vec<u8>, Arc<AccountAdmissionEntry>>,
    defaults: AdmissionDefaults,
    clock: Arc<dyn GatewayClock>,
}

impl AdmissionController {
    fn new(
        defaults: AdmissionDefaults,
        clock: Arc<dyn GatewayClock>,
        recent: Vec<buzz_db::credits::RecentDebit>,
    ) -> Self {
        let controller = Self {
            entries: DashMap::new(),
            defaults,
            clock,
        };
        for debit in recent {
            let entry = controller.entry(&debit.pubkey);
            let mut runtime = lock_runtime(&entry);
            runtime.push_spend(SpendPoint {
                at: debit.created_at,
                cost_nanousd: debit.cost_nanousd,
            });
        }
        controller
    }

    fn entry(&self, pubkey: &[u8]) -> Arc<AccountAdmissionEntry> {
        self.entries
            .entry(pubkey.to_vec())
            .or_insert_with(|| Arc::new(AccountAdmissionEntry::default()))
            .clone()
    }

    async fn admit(
        &self,
        pool: &sqlx::PgPool,
        pubkey: &[u8],
    ) -> Result<AdmissionPermit, AdmissionError> {
        let entry = self.entry(pubkey);
        let _gate = entry.gate.lock().await;
        let account = buzz_db::credits::admission_account(pool, pubkey)
            .await
            .map_err(|error| AdmissionError::Database(error.to_string()))?;
        let now = self.clock.now();
        let mut runtime = lock_runtime(&entry);
        runtime.prune(now);

        let typical = account
            .typical_call_cost_nanousd
            .unwrap_or(self.defaults.typical_call_cost_nanousd);
        let max_in_flight = account
            .max_in_flight
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(self.defaults.max_in_flight);
        let burn_cap = account
            .hourly_burn_cap_nanousd
            .unwrap_or(self.defaults.hourly_burn_cap_nanousd);
        let balance_guard = i64::from(runtime.in_flight)
            .saturating_mul(typical)
            .max(ADMISSION_FLOOR_NANOUSD);
        if account.balance < balance_guard {
            return Err(AdmissionError::Payment {
                balance_nanousd: account.balance,
                required_nanousd: balance_guard,
            });
        }
        if runtime.in_flight >= max_in_flight {
            return Err(AdmissionError::Rate {
                message: "gateway concurrency limit reached",
                retry_after_secs: 1,
            });
        }
        if runtime.spend_nanousd >= burn_cap {
            return Err(AdmissionError::Rate {
                message: "gateway hourly spend limit reached",
                retry_after_secs: runtime.retry_after_secs(burn_cap, now),
            });
        }

        runtime.in_flight = runtime.in_flight.saturating_add(1);
        drop(runtime);
        drop(_gate);
        Ok(AdmissionPermit {
            entry,
            pubkey: pubkey.to_vec(),
            released: false,
        })
    }

    #[cfg(test)]
    fn in_flight_for(&self, pubkey: &[u8]) -> u32 {
        self.entries
            .get(pubkey)
            .map(|entry| lock_runtime(&entry).in_flight)
            .unwrap_or(0)
    }
}

enum AdmissionError {
    Payment {
        balance_nanousd: i64,
        required_nanousd: i64,
    },
    Rate {
        message: &'static str,
        retry_after_secs: u64,
    },
    Database(String),
}

struct AdmissionPermit {
    entry: Arc<AccountAdmissionEntry>,
    pubkey: Vec<u8>,
    released: bool,
}

impl AdmissionPermit {
    async fn finish(self, settled: Option<SettledDebit>) {
        self.finish_with(async move { settled }).await;
    }

    /// Run the final settle operation while holding the account admission
    /// gate, then update cached spend and release the in-flight slot as one
    /// serialized lifecycle. This closes both stale-balance and stale-burn
    /// windows between a durable debit and the next admission.
    async fn finish_with<F>(mut self, operation: F)
    where
        F: Future<Output = Option<SettledDebit>>,
    {
        let entry = Arc::clone(&self.entry);
        let _gate = entry.gate.lock().await;
        let settled = operation.await;
        let mut runtime = lock_runtime(&entry);
        if let Some(settled) = settled.filter(|settled| settled.applied) {
            runtime.push_spend(SpendPoint {
                at: settled.created_at,
                cost_nanousd: settled.cost_nanousd,
            });
        }
        release_runtime(&mut runtime, &self.pubkey);
        self.released = true;
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let entry = Arc::clone(&self.entry);
        let pubkey = self.pubkey.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    let _gate = entry.gate.lock().await;
                    let mut runtime = lock_runtime(&entry);
                    release_runtime(&mut runtime, &pubkey);
                });
            }
            Err(_) => {
                tracing::error!(
                    pubkey = %hex::encode(&pubkey),
                    "gateway: admission permit dropped outside a runtime"
                );
                let mut runtime = lock_runtime(&entry);
                release_runtime(&mut runtime, &pubkey);
            }
        }
    }
}

fn lock_runtime(entry: &AccountAdmissionEntry) -> std::sync::MutexGuard<'_, AccountRuntime> {
    entry
        .runtime
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn release_runtime(runtime: &mut AccountRuntime, pubkey: &[u8]) {
    if runtime.in_flight == 0 {
        tracing::error!(
            pubkey = %hex::encode(pubkey),
            "gateway: admission in-flight release underflow"
        );
    } else {
        runtime.in_flight -= 1;
    }
}

/// Combine the relay state and the gateway state for axum.
#[derive(Clone)]
pub(crate) struct GatewayApiState {
    app: Arc<crate::state::AppState>,
    upstream: Arc<GatewayState>,
}

/// Mount the gateway routes. Call only when the gateway is configured; the
/// caller decides existence, so "not configured" is a clean 404.
pub fn router(app: Arc<crate::state::AppState>, upstream: Arc<GatewayState>) -> Router {
    let state = GatewayApiState { app, upstream };
    Router::new()
        .route(
            "/gateway/openai/v1/chat/completions",
            post(chat_completions),
        )
        .route("/gateway/openai/v1/models", get(list_models))
        .route("/api/gateway/tokens", post(mint_token).delete(revoke_token))
        .route("/api/gateway/account", get(account))
        .route_layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(state)
}

/// Body for `POST /api/gateway/tokens`.
#[derive(Debug, Deserialize)]
pub struct MintTokenRequest {
    /// Requested lifetime in seconds; defaults to 30 days.
    #[serde(default)]
    pub ttl_secs: Option<u64>,
}

/// Body for `DELETE /api/gateway/tokens`.
#[derive(Debug, Deserialize)]
pub struct RevokeTokenRequest {
    /// The raw Colony gateway token to revoke (hashed before lookup).
    pub token: String,
}

/// Mint a Colony gateway token — `POST /api/gateway/tokens`.
///
/// NIP-98 authenticated like every relay session call (the desktop signs
/// these). The token is bound to the caller's pubkey, shown exactly once,
/// and stored only as a SHA-256 hash.
pub(crate) async fn mint_token(
    State(state): State<GatewayApiState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<axum::Json<Value>, (StatusCode, axum::Json<Value>)> {
    let (tenant, pubkey) = authenticate(
        &state.app,
        &headers,
        "POST",
        "/api/gateway/tokens",
        Some(&body),
        true,
    )
    .await?;

    let request: MintTokenRequest = serde_json::from_slice(&body)
        .map_err(|_| crate::api::api_error(StatusCode::BAD_REQUEST, "invalid JSON body"))?;
    let ttl = request.ttl_secs.unwrap_or(DEFAULT_TOKEN_TTL_SECS);
    if !(MIN_TOKEN_TTL_SECS..=MAX_TOKEN_TTL_SECS).contains(&ttl) {
        return Err(crate::api::api_error(
            StatusCode::BAD_REQUEST,
            &format!("ttl_secs must be between {MIN_TOKEN_TTL_SECS} and {MAX_TOKEN_TTL_SECS}"),
        ));
    }

    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    let token = format!("{TOKEN_PREFIX}{}", hex::encode(bytes));
    let hash = sha256(token.as_bytes());

    buzz_db::gateway::insert_token(
        state.app.db.pool(),
        &hash,
        &pubkey.to_bytes(),
        std::time::Duration::from_secs(ttl),
        "provisioned",
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "gateway: token mint insert failed");
        crate::api::internal_error("gateway token mint failed")
    })?;

    let expires_at = Utc::now() + chrono::Duration::seconds(ttl as i64);
    let _ = tenant;
    Ok(axum::Json(serde_json::json!({
        "token": token,
        "expires_at": expires_at.to_rfc3339(),
    })))
}

/// Revoke a Colony gateway token — `DELETE /api/gateway/tokens`.
///
/// NIP-98 authenticated. Only the token itself is named; the hash lookup
/// makes a dump of this table useless.
pub(crate) async fn revoke_token(
    State(state): State<GatewayApiState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, axum::Json<Value>)> {
    let (_tenant, _pubkey) = authenticate(
        &state.app,
        &headers,
        "DELETE",
        "/api/gateway/tokens",
        Some(&body),
        true,
    )
    .await?;

    let request: RevokeTokenRequest = serde_json::from_slice(&body)
        .map_err(|_| crate::api::api_error(StatusCode::BAD_REQUEST, "invalid JSON body"))?;
    let hash = sha256(request.token.as_bytes());
    let revoked = buzz_db::gateway::revoke_token(state.app.db.pool(), &hash)
        .await
        .map_err(|error| {
            tracing::error!(%error, "gateway: token revoke failed");
            crate::api::internal_error("gateway token revoke failed")
        })?;
    if !revoked {
        return Err(crate::api::api_error(
            StatusCode::NOT_FOUND,
            "no live token matches",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Read the NIP-98 signer's prepaid account — `GET /api/gateway/account`.
///
/// There is intentionally no pubkey selector and no ledger data. A missing
/// account reads as zero/depleted without creating a row; signed nanoUSD is a
/// decimal string so JavaScript never rounds a 64-bit balance.
pub(crate) async fn account(
    State(state): State<GatewayApiState>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, axum::Json<Value>)> {
    let (_tenant, pubkey) = authenticate(
        &state.app,
        &headers,
        "GET",
        "/api/gateway/account",
        None,
        false,
    )
    .await?;
    let balance = buzz_db::credits::balance(state.app.db.pool(), &pubkey.to_bytes())
        .await
        .map_err(|error| {
            tracing::error!(%error, "gateway: account balance read failed");
            crate::api::internal_error("gateway account balance read failed")
        })?;
    let status = if balance > 0 { "active" } else { "depleted" };
    let mut response = axum::Json(serde_json::json!({
        "balance_nanousd": balance.to_string(),
        "currency": "USD",
        "status": status,
    }))
    .into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

/// `GET /gateway/openai/v1/models` — the enabled catalog, OpenAI-list shaped.
pub(crate) async fn list_models(
    State(state): State<GatewayApiState>,
    headers: HeaderMap,
) -> Result<axum::Json<Value>, (StatusCode, axum::Json<Value>)> {
    let _pubkey = authenticate_gateway_call(&state, &headers).await?;
    let models = buzz_db::gateway::enabled_models(state.app.db.pool())
        .await
        .map_err(|error| {
            tracing::error!(%error, "gateway: model catalog read failed");
            crate::api::internal_error("gateway model catalog read failed")
        })?;
    let data: Vec<Value> = models
        .into_iter()
        .map(|model| {
            serde_json::json!({
                "id": model.model_id,
                "object": "model",
                "owned_by": "colony",
            })
        })
        .collect();
    Ok(axum::Json(
        serde_json::json!({ "object": "list", "data": data }),
    ))
}

/// `POST /gateway/openai/v1/chat/completions` — the provisioned leg.
pub(crate) async fn chat_completions(
    State(state): State<GatewayApiState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let pubkey = match authenticate_gateway_call(&state, &headers).await {
        Ok(pubkey) => pubkey,
        Err(error) => return error.into_response(),
    };

    // Parse the request once: model gate and the stream rewrite both need it.
    let request: Value = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => {
            return crate::api::api_error(StatusCode::BAD_REQUEST, "invalid JSON request body")
                .into_response()
        }
    };
    let model_id = match request.get("model").and_then(Value::as_str) {
        Some(model) if !model.is_empty() => model.to_string(),
        _ => {
            return crate::api::api_error(StatusCode::BAD_REQUEST, "request must name a model")
                .into_response()
        }
    };

    let catalog = match buzz_db::gateway::model_by_id(state.app.db.pool(), &model_id).await {
        Ok(catalog) => catalog,
        Err(error) => {
            tracing::error!(%error, "gateway: model catalog lookup failed");
            return crate::api::internal_error("gateway model catalog lookup failed")
                .into_response();
        }
    };
    let Some(catalog) = catalog.filter(|catalog| catalog.enabled) else {
        return crate::api::api_error(
            StatusCode::NOT_FOUND,
            &format!("model not available: {model_id}"),
        )
        .into_response();
    };
    let vercel_slug = catalog.vercel_slug.clone();

    // Rewrite the model to the Vercel slug, then apply the one permitted
    // streaming rewrite (ask for the usage block on the terminal chunk).
    let mut outbound = request;
    outbound["model"] = Value::String(vercel_slug);
    let outbound_body = match serde_json::to_vec(&outbound) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::error!(%error, "gateway: request re-encode failed");
            return crate::api::internal_error("gateway request re-encode failed").into_response();
        }
    };
    let outbound_body = openai::ensure_stream_usage(&outbound_body).unwrap_or(outbound_body);

    let outbound_headers = build_upstream_headers(&headers, &state.upstream.config.api_key);
    let url = format!(
        "{}/v1/chat/completions",
        state.upstream.config.base_url.trim_end_matches('/')
    );

    // The per-account gate is acquired immediately before upstream spend and
    // moved into the response body. Its Drop path covers abrupt downstream
    // disconnects; natural completion releases it only after settle/cache
    // update, so a completed debit and the next admission cannot cross.
    let permit = match state
        .upstream
        .admission
        .admit(state.app.db.pool(), &pubkey)
        .await
    {
        Ok(permit) => permit,
        Err(AdmissionError::Payment {
            balance_nanousd,
            required_nanousd,
        }) => return payment_required_response(balance_nanousd, required_nanousd),
        Err(AdmissionError::Rate {
            message,
            retry_after_secs,
        }) => return rate_limited_response(message, retry_after_secs),
        Err(AdmissionError::Database(error)) => {
            tracing::error!(%error, "gateway: admission account lookup failed");
            return crate::api::internal_error("gateway admission failed").into_response();
        }
    };

    let sent = state
        .upstream
        .client
        .post(&url)
        .headers(outbound_headers)
        .body(outbound_body)
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, "gateway: upstream request failed");
            permit.finish(None).await;
            return crate::api::api_error(
                StatusCode::BAD_GATEWAY,
                "gateway upstream request failed",
            )
            .into_response();
        }
    };

    let status = response.status();
    let upstream_headers = response.headers().clone();

    // A content-encoded body is forwarded verbatim but cannot be parsed.
    let encoded = upstream_headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| !value.trim().eq_ignore_ascii_case("identity"))
        .unwrap_or(false);
    if encoded {
        tracing::warn!("gateway: content-encoded response forwarded without usage capture");
    }

    let meta = SettleMeta {
        pubkey,
        model_id,
        is_sse: is_event_stream(&upstream_headers),
        parseable: !encoded,
        http_status: status,
    };
    let tee = SettleTee::new(
        Box::pin(response.bytes_stream()),
        meta,
        state.app.db.pool().clone(),
        Arc::clone(&state.upstream.price_book),
        permit,
    );

    let mut builder = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        if is_hop_by_hop(name) {
            continue;
        }
        builder = builder.header(name, value);
    }
    match builder.body(Body::from_stream(tee.into_stream())) {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "gateway: could not build the proxied response");
            crate::api::api_error(StatusCode::BAD_GATEWAY, "gateway upstream request failed")
                .into_response()
        }
    }
}

fn payment_required_response(balance_nanousd: i64, required_nanousd: i64) -> Response {
    (
        StatusCode::PAYMENT_REQUIRED,
        axum::Json(serde_json::json!({
            "error": "insufficient_credits",
            "message": "insufficient balance: top up credits to continue",
            "balance_nanousd": balance_nanousd.to_string(),
            "required_nanousd": required_nanousd.to_string(),
            "top_up": "buzz://settings/credits",
        })),
    )
        .into_response()
}

fn rate_limited_response(message: &str, retry_after_secs: u64) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        axum::Json(serde_json::json!({ "error": message })),
    )
        .into_response();
    let retry_after = HeaderValue::from_str(&retry_after_secs.max(1).to_string())
        .unwrap_or_else(|_| HeaderValue::from_static("1"));
    response
        .headers_mut()
        .insert(axum::http::header::RETRY_AFTER, retry_after);
    response
}

/// Authenticate a gateway call: bearer Colony token -> hash -> live row.
///
/// The returned pubkey is the account the call settles against. Unknown,
/// expired, and revoked tokens all answer 401 with the same body so the
/// endpoint is not an oracle for which state a token is in.
async fn authenticate_gateway_call(
    state: &GatewayApiState,
    headers: &HeaderMap,
) -> Result<Vec<u8>, (StatusCode, axum::Json<Value>)> {
    let token = extract_token(headers).ok_or_else(|| {
        crate::api::api_error(
            StatusCode::UNAUTHORIZED,
            "missing or malformed gateway token",
        )
    })?;
    let hash = sha256(token.as_bytes());
    let row = buzz_db::gateway::token_by_hash(state.app.db.pool(), &hash)
        .await
        .map_err(|error| {
            tracing::error!(%error, "gateway: token lookup failed");
            crate::api::internal_error("gateway token lookup failed")
        })?;
    let row = row.filter(|row| row.revoked_at.is_none() && row.expires_at > Utc::now());
    match row {
        Some(row) => Ok(row.pubkey),
        None => Err(crate::api::api_error(
            StatusCode::UNAUTHORIZED,
            "invalid or expired gateway token",
        )),
    }
}

/// NIP-98 session auth for the token mint/revoke endpoints.
///
/// Same shape as the invite endpoints: bind the tenant from the Host
/// header, verify the signed request against the tenant's expected URL, and
/// check replay. This is the "authenticated relay session" the desktop
/// speaks; the pubkey that signs is the account the minted token binds to.
async fn authenticate(
    state: &Arc<crate::state::AppState>,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    require_payload: bool,
) -> Result<(buzz_core::TenantContext, nostr::PublicKey), (StatusCode, axum::Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            crate::api::api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;

    let url = crate::api::bridge::nip98_expected_url(&state.config.relay_url, &tenant, path);
    let (pubkey, event_id_bytes) = crate::api::bridge::verify_bridge_auth_with_options(
        headers,
        method,
        &url,
        body,
        true,
        require_payload,
    )?;
    crate::api::bridge::check_nip98_replay(state, &tenant, event_id_bytes).await?;
    Ok((tenant, pubkey))
}

/// Read the Colony token from either header convention, mirroring the
/// loopback meter's credential extraction.
fn extract_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
    {
        let token = value.trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    let authorization = headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = authorization.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// SHA-256, the only form a Colony token ever takes outside this process.
fn sha256(input: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hasher.finalize().into()
}

/// Build the upstream request headers.
///
/// The Colony token must NEVER appear in an upstream request — unlike the
/// loopback meter, there is no subscription pass-through mode here, so both
/// credential headers are stripped unconditionally and replaced with the
/// server-held key.
fn build_upstream_headers(headers: &HeaderMap, api_key: &str) -> HeaderMap {
    let mut outbound = HeaderMap::with_capacity(headers.len() + 1);
    for (name, value) in headers.iter() {
        if is_stripped_request_header(name) {
            continue;
        }
        outbound.append(name.clone(), value.clone());
    }
    // Ask upstream for a body the gateway can read. Stated explicitly rather
    // than omitted, because an absent accept-encoding lets a server choose
    // compression on its own and a compressed body cannot be parsed.
    outbound.insert(
        HeaderName::from_static("accept-encoding"),
        HeaderValue::from_static("identity"),
    );
    let mut bearer = HeaderValue::from_str(&format!("Bearer {api_key}")).unwrap_or_else(|_| {
        // The key is operator-supplied config; an unrepresentable value is a
        // configuration error surfaced on the first call, not a panic.
        HeaderValue::from_static("Bearer ")
    });
    bearer.set_sensitive(true);
    outbound.insert(AUTHORIZATION, bearer);
    outbound
}

/// Headers the gateway replaces rather than forwards (transport facts of the
/// old hop plus both credential headers — the Colony token dies here).
fn is_stripped_request_header(name: &HeaderName) -> bool {
    is_hop_by_hop(name)
        || matches!(
            name.as_str(),
            "host" | "content-length" | "x-api-key" | "authorization" | "accept-encoding"
        )
}

/// Headers hyper must recompute for the new hop rather than copy.
fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn is_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("text/event-stream")
        })
        .unwrap_or(false)
}

/// Everything needed to turn a finished response body into a settle.
struct SettleMeta {
    /// Account pubkey the call settles against.
    pubkey: Vec<u8>,
    /// Colony model id the user asked for (attribution + price book key).
    model_id: String,
    is_sse: bool,
    parseable: bool,
    http_status: StatusCode,
}

/// One settled call, as computed from the wire.
struct SettleJob {
    pubkey: Vec<u8>,
    model_id: String,
    parsed: ParsedUsage,
    http_status: StatusCode,
}

/// A durable debit that may be added to the in-process rolling spend cache.
struct SettledDebit {
    cost_nanousd: i64,
    created_at: chrono::DateTime<Utc>,
    applied: bool,
}

type UpstreamStream = Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>;

/// Forwards the upstream body chunk by chunk while keeping a bounded copy
/// for usage parsing. The forwarded bytes are never touched.
///
/// The last chunk is held back one position: when the upstream stream ends,
/// the settle runs inline (awaited, with retries) and only then is the held
/// terminal chunk released to the client. `Drop` is the safety net for a
/// client that hangs up mid-stream — it settles best-effort from whatever
/// the wire said, because the call still happened and still cost money.
struct SettleTee {
    upstream: UpstreamStream,
    buffer: Vec<u8>,
    truncated: bool,
    finished: bool,
    /// The chunk held back so it can be released only after the settle.
    pending: Option<Bytes>,
    /// Deferred upstream error, delivered after the held chunk.
    error_pending: Option<std::io::Error>,
    meta: Option<SettleMeta>,
    pool: sqlx::PgPool,
    price_book: Arc<PriceBook>,
    permit: Option<AdmissionPermit>,
}

impl SettleTee {
    fn new(
        upstream: UpstreamStream,
        meta: SettleMeta,
        pool: sqlx::PgPool,
        price_book: Arc<PriceBook>,
        permit: AdmissionPermit,
    ) -> Self {
        Self {
            upstream,
            buffer: Vec::new(),
            truncated: false,
            finished: false,
            pending: None,
            error_pending: None,
            meta: Some(meta),
            pool,
            price_book,
            permit: Some(permit),
        }
    }

    fn accumulate(&mut self, chunk: &Bytes) {
        if self.truncated {
            return;
        }
        if self.buffer.len().saturating_add(chunk.len()) > MAX_TEE_BYTES {
            let (pubkey, model_id) = match self.meta.as_ref() {
                Some(meta) => (hex::encode(&meta.pubkey), meta.model_id.as_str()),
                None => (String::from("<unknown>"), "<unknown>"),
            };
            tracing::warn!(
                pubkey = %pubkey,
                model = %model_id,
                cap_bytes = MAX_TEE_BYTES,
                "gateway: response exceeded the parse cap, still forwarding but no usage capture"
            );
            self.truncated = true;
            self.buffer = Vec::new();
            return;
        }
        self.buffer.extend_from_slice(chunk);
    }

    /// Build the settle job from the metadata and whatever the wire said.
    /// Consumes the metadata, so exactly one settle is produced per
    /// forwarded request no matter how many end paths fire.
    fn take_job(&mut self) -> Option<SettleJob> {
        let meta = self.meta.take()?;
        let parsed = if self.truncated || !meta.parseable || !meta.http_status.is_success() {
            ParsedUsage::default()
        } else if meta.is_sse {
            openai::parse_sse_response(&self.buffer)
        } else {
            openai::parse_json_response(&self.buffer)
        };
        self.buffer = Vec::new();
        Some(SettleJob {
            pubkey: meta.pubkey,
            model_id: meta.model_id,
            parsed,
            http_status: meta.http_status,
        })
    }

    /// Settle inline and awaited: the terminal chunk is released only after
    /// the debit commits. A failure after the bounded retries still releases
    /// the chunk, but is logged loudly with the call's identifiers —
    /// reconciliation is the only honest backstop left.
    async fn settle_inline(&mut self) {
        let job = self.take_job();
        match self.permit.take() {
            Some(permit) => {
                permit
                    .finish_with(settle_job(&self.pool, &self.price_book, job))
                    .await;
            }
            None => {
                settle_job(&self.pool, &self.price_book, job).await;
            }
        }
    }

    /// Best-effort settle for the `Drop` path (client hung up mid-stream).
    /// Cannot await inside `Drop`, so the settle is spawned with a bounded
    /// retry; if no runtime is available, the call is logged for
    /// reconciliation instead.
    fn settle_best_effort(&mut self) {
        let job = self.take_job();
        let permit = self.permit.take();
        if job.is_none() && permit.is_none() {
            return;
        }
        let pool = self.pool.clone();
        let price_book = Arc::clone(&self.price_book);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    match permit {
                        Some(permit) => {
                            permit
                                .finish_with(settle_job(&pool, &price_book, job))
                                .await;
                        }
                        None => {
                            settle_job(&pool, &price_book, job).await;
                        }
                    }
                });
            }
            Err(_) => {
                if let Some(job) = job {
                    tracing::error!(
                        pubkey = %hex::encode(&job.pubkey),
                        model = %job.model_id,
                        request_id = job.parsed.request_id.as_deref().unwrap_or("<none>"),
                        "gateway: dropped a settle outside a runtime — this call must be found by reconciliation"
                    );
                }
                drop(permit);
            }
        }
    }

    fn into_stream(self) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
        futures_util::stream::unfold(self, |mut tee| async move {
            loop {
                if tee.finished {
                    return None;
                }
                if let Some(error) = tee.error_pending.take() {
                    tee.finished = true;
                    return Some((Err(error), tee));
                }
                match tee.upstream.next().await {
                    Some(Ok(chunk)) => {
                        tee.accumulate(&chunk);
                        // Hold the previous chunk; the one in hand becomes
                        // the new hold. This is what makes the terminal
                        // chunk releasable only after the settle commits.
                        if let Some(previous) = tee.pending.replace(chunk) {
                            return Some((Ok(previous), tee));
                        }
                    }
                    Some(Err(error)) => {
                        let (pubkey, model_id) = match tee.meta.as_ref() {
                            Some(meta) => (hex::encode(&meta.pubkey), meta.model_id.as_str()),
                            None => (String::from("<unknown>"), "<unknown>"),
                        };
                        tracing::warn!(
                            %error,
                            pubkey = %pubkey,
                            model = %model_id,
                            "gateway: upstream body ended early"
                        );
                        // Settle whatever the wire said before the client
                        // sees the end of the stream; for a mid-stream kill
                        // the terminal usage never arrived, so this is
                        // normally a no-op.
                        tee.settle_inline().await;
                        if let Some(chunk) = tee.pending.take() {
                            tee.error_pending = Some(std::io::Error::other(error.to_string()));
                            return Some((Ok(chunk), tee));
                        }
                        tee.finished = true;
                        return Some((Err(std::io::Error::other(error.to_string())), tee));
                    }
                    None => {
                        // Natural end: the observed cost is only knowable
                        // here, so the debit commits before the held
                        // terminal chunk is released.
                        tee.settle_inline().await;
                        if let Some(terminal) = tee.pending.take() {
                            tee.finished = true;
                            return Some((Ok(terminal), tee));
                        }
                        return None;
                    }
                }
            }
        })
    }
}

async fn settle_job(
    pool: &sqlx::PgPool,
    price_book: &PriceBook,
    job: Option<SettleJob>,
) -> Option<SettledDebit> {
    let job = job?;
    match settle_with_retry(pool, price_book, &job).await {
        Ok(settled) => settled,
        Err(error) => {
            tracing::error!(
                %error,
                pubkey = %hex::encode(&job.pubkey),
                model = %job.model_id,
                request_id = job.parsed.request_id.as_deref().unwrap_or("<none>"),
                "gateway: settle failed after retries — this call must be found by reconciliation"
            );
            None
        }
    }
}

impl Drop for SettleTee {
    /// A client that hangs up mid-stream drops the body without the stream
    /// ever completing. The call still happened and still costs money, so it
    /// is settled best-effort with whatever the wire said.
    fn drop(&mut self) {
        self.settle_best_effort();
    }
}

/// Settle one call, retrying transient failures a bounded number of times.
///
/// The retry replays the exact same idempotency reference, so the ledger's
/// `UNIQUE (pubkey, ref)` keeps it exactly-once: a retry after a commit that
/// lost its response is a no-op that returns the original entry.
async fn settle_with_retry(
    pool: &sqlx::PgPool,
    price_book: &PriceBook,
    job: &SettleJob,
) -> anyhow::Result<Option<SettledDebit>> {
    let mut last_error = None;
    for attempt in 0..SETTLE_MAX_ATTEMPTS {
        match settle_one(pool, price_book, job).await {
            Ok(settled) => return Ok(settled),
            Err(error) => {
                tracing::warn!(
                    %error,
                    attempt = attempt + 1,
                    max_attempts = SETTLE_MAX_ATTEMPTS,
                    pubkey = %hex::encode(&job.pubkey),
                    model = %job.model_id,
                    request_id = job.parsed.request_id.as_deref().unwrap_or("<none>"),
                    "gateway: settle attempt failed, retrying"
                );
                last_error = Some(error);
                tokio::time::sleep(std::time::Duration::from_millis(
                    SETTLE_RETRY_BACKOFF_MS * (1 << attempt),
                ))
                .await;
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("settle failed")))
}

/// Settle one call: the provider's stated cost when one is present — even
/// under an unfamiliar usage shape — otherwise the price-book estimate for
/// the observed tokens (basis `estimated`). A call only goes unsettled when
/// there is neither a stated cost nor a priceable token count, and that is
/// logged loudly with the call's identifiers.
///
/// Exactly-once comes from the idempotency reference: the upstream response
/// id when the provider supplies one, and a server-generated ref when it
/// does not. A retried settle (inline retry after a transient DB error, or
/// a replayed settle) replays the same ref and the ledger's
/// `UNIQUE (pubkey, ref)` makes it a no-op. A server-generated ref cannot
/// dedupe an upstream retry the way the upstream id can, but billing must
/// not hinge on a field the gateway provider controls.
async fn settle_one(
    pool: &sqlx::PgPool,
    price_book: &PriceBook,
    job: &SettleJob,
) -> anyhow::Result<Option<SettledDebit>> {
    if !job.http_status.is_success() {
        // A failed call is not billed by the provider; nothing to settle.
        return Ok(None);
    }

    let reference = match job.parsed.request_id.as_deref().filter(|id| !id.is_empty()) {
        Some(request_id) => std::borrow::Cow::Borrowed(request_id),
        None => {
            let generated = format!("gateway:{}", uuid::Uuid::new_v4());
            tracing::warn!(
                pubkey = %hex::encode(&job.pubkey),
                model = %job.model_id,
                reference = %generated,
                "gateway: successful call carried no upstream request id — settling under a server-generated ref"
            );
            std::borrow::Cow::Owned(generated)
        }
    };

    match job.parsed.observed_cost_nanousd {
        Some(cost) => {
            let result = buzz_db::credits::debit_observed_applied(
                pool,
                &job.pubkey,
                cost,
                &reference,
                Some(&job.model_id),
                job.parsed.request_id.as_deref(),
            )
            .await?;
            tracing::info!(
                cost_nanousd = cost,
                pubkey = %hex::encode(&job.pubkey),
                model = %job.model_id,
                request_id = job.parsed.request_id.as_deref().unwrap_or("<none>"),
                reference = %reference,
                "gateway: settled observed cost"
            );
            return Ok(Some(SettledDebit {
                cost_nanousd: result.entry.observed_cost.ok_or_else(|| {
                    anyhow::anyhow!("observed debit returned without observed_cost")
                })?,
                created_at: result.entry.created_at,
                applied: result.applied,
            }));
        }
        None => match job.parsed.tokens {
            Some(tokens) => {
                let at_unix = Utc::now().timestamp().max(0) as u64;
                match price_book.price_tokens(&job.model_id, &tokens, at_unix) {
                    Some(cost) => {
                        let cost = u64::try_from(cost)
                            .map_err(|_| anyhow::anyhow!("estimated cost {cost} exceeds u64"))?;
                        let result = buzz_db::credits::debit_estimated_applied(
                            pool,
                            &job.pubkey,
                            cost,
                            &reference,
                            Some(&job.model_id),
                            job.parsed.request_id.as_deref(),
                        )
                        .await?;
                        tracing::warn!(
                            cost_nanousd = cost,
                            pubkey = %hex::encode(&job.pubkey),
                            model = %job.model_id,
                            request_id = job.parsed.request_id.as_deref().unwrap_or("<none>"),
                            reference = %reference,
                            "gateway: provider stated no cost — settled price-book estimate"
                        );
                        return Ok(Some(SettledDebit {
                            cost_nanousd: result.entry.observed_cost.ok_or_else(|| {
                                anyhow::anyhow!("estimated debit returned without observed_cost")
                            })?,
                            created_at: result.entry.created_at,
                            applied: result.applied,
                        }));
                    }
                    None => {
                        tracing::error!(
                            pubkey = %hex::encode(&job.pubkey),
                            model = %job.model_id,
                            request_id = job.parsed.request_id.as_deref().unwrap_or("<none>"),
                            "gateway: provider stated no cost and the model is unpriced — \
                             no settle recorded, this call must be found by reconciliation"
                        );
                    }
                }
            }
            None => {
                tracing::warn!(
                    pubkey = %hex::encode(&job.pubkey),
                    model = %job.model_id,
                    request_id = job.parsed.request_id.as_deref().unwrap_or("<none>"),
                    "gateway: no usage in the response — nothing to settle"
                );
            }
        },
    }
    Ok(None)
}

#[cfg(test)]
mod tests;
