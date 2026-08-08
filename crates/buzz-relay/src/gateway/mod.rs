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
//! Everything here is mounted only when `VERCEL_AI_GATEWAY_KEY` is
//! configured; without it the routes do not exist and return 404.
//!
//! The wire shape is pinned by real captures in `buzz-meter-core`'s fixture
//! suite: Vercel injects its own `usage` object with a float `cost` in
//! dollars alongside integer token counts, in the body only (never a header),
//! and the streaming terminal chunk carries it without `stream_options`.

use std::pin::Pin;
use std::sync::Arc;

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
use futures_util::stream::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

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

/// Bound on the channel of pending settles. The data path never blocks on
/// it: a full channel drops the settle with a loud error rather than
/// stalling the agent's response. Reconciliation is the backstop.
const SETTLE_CHANNEL_CAPACITY: usize = 4096;

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
    Ok(Some(GatewayConfig { api_key, base_url }))
}

/// Everything the gateway needs beyond the relay's `AppState`.
pub struct GatewayState {
    config: GatewayConfig,
    client: reqwest::Client,
    /// Pending settles, drained by the background worker so the response
    /// stream never blocks on a database write.
    settle_tx: mpsc::Sender<SettleJob>,
    /// Spawned settle worker, kept alive for the state's lifetime.
    _worker: tokio::task::JoinHandle<()>,
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
    /// Build the gateway state and start its settle worker.
    ///
    /// # Errors
    ///
    /// Fails when the upstream HTTP client cannot be built or the effective
    /// price catalog is invalid.
    pub fn new(config: GatewayConfig, pool: sqlx::PgPool) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|error| anyhow::anyhow!("gateway upstream client: {error}"))?;
        let entries = crate::price_feed::effective_catalog()
            .map_err(|error| anyhow::anyhow!("gateway price book: {error}"))?;
        let price_book = Arc::new(PriceBook { entries });
        let (settle_tx, settle_rx) = mpsc::channel(SETTLE_CHANNEL_CAPACITY);
        let worker = tokio::spawn(settle_worker(pool, Arc::clone(&price_book), settle_rx));
        Ok(Self {
            config,
            client,
            settle_tx,
            _worker: worker,
        })
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
        .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
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
    let (tenant, pubkey) =
        authenticate(&state.app, &headers, "POST", "/api/gateway/tokens", &body).await?;

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
    let (_tenant, _pubkey) =
        authenticate(&state.app, &headers, "DELETE", "/api/gateway/tokens", &body).await?;

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

    // Admission stub (this ticket only): refuse below the floor. The balance
    // query happens before any upstream spend, so an empty account is 402,
    // not a free call.
    let balance = match buzz_db::credits::balance(state.app.db.pool(), &pubkey).await {
        Ok(balance) => balance,
        Err(error) => {
            tracing::error!(%error, "gateway: balance lookup failed");
            return crate::api::internal_error("gateway balance lookup failed").into_response();
        }
    };
    if balance < ADMISSION_FLOOR_NANOUSD {
        return crate::api::api_error(
            StatusCode::PAYMENT_REQUIRED,
            "insufficient balance: top up credits to continue",
        )
        .into_response();
    }

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
        state.upstream.settle_tx.clone(),
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
    body: &[u8],
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
        Some(body),
        true,
        true,
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

/// One pending settlement, drained by the background worker.
struct SettleJob {
    pubkey: Vec<u8>,
    model_id: String,
    parsed: ParsedUsage,
    http_status: StatusCode,
}

type UpstreamStream = Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>;

/// Forwards the upstream body chunk by chunk while keeping a bounded copy
/// for usage parsing. The forwarded bytes are never touched.
struct SettleTee {
    upstream: UpstreamStream,
    buffer: Vec<u8>,
    truncated: bool,
    finished: bool,
    meta: Option<SettleMeta>,
    settle_tx: mpsc::Sender<SettleJob>,
}

impl SettleTee {
    fn new(upstream: UpstreamStream, meta: SettleMeta, settle_tx: mpsc::Sender<SettleJob>) -> Self {
        Self {
            upstream,
            buffer: Vec::new(),
            truncated: false,
            finished: false,
            meta: Some(meta),
            settle_tx,
        }
    }

    fn accumulate(&mut self, chunk: &Bytes) {
        if self.truncated {
            return;
        }
        if self.buffer.len().saturating_add(chunk.len()) > MAX_TEE_BYTES {
            tracing::warn!(
                cap_bytes = MAX_TEE_BYTES,
                "gateway: response exceeded the parse cap, still forwarding but no usage capture"
            );
            self.truncated = true;
            self.buffer = Vec::new();
            return;
        }
        self.buffer.extend_from_slice(chunk);
    }

    /// Queue the settle. Idempotent: the metadata is consumed on the first
    /// call, so the explicit end-of-stream path and the `Drop` safety net
    /// between them produce exactly one settle per forwarded request.
    fn emit(&mut self) {
        let Some(meta) = self.meta.take() else {
            return;
        };
        let parsed = if self.truncated || !meta.parseable || !meta.http_status.is_success() {
            ParsedUsage::default()
        } else if meta.is_sse {
            openai::parse_sse_response(&self.buffer)
        } else {
            openai::parse_json_response(&self.buffer)
        };
        self.buffer = Vec::new();

        let job = SettleJob {
            pubkey: meta.pubkey,
            model_id: meta.model_id,
            parsed,
            http_status: meta.http_status,
        };
        if let Err(error) = self.settle_tx.try_send(job) {
            tracing::error!(
                %error,
                "gateway: dropped a settle, the queue is full — this call must be found by reconciliation"
            );
        }
    }

    fn into_stream(self) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
        futures_util::stream::unfold(self, |mut tee| async move {
            if tee.finished {
                return None;
            }
            match tee.upstream.next().await {
                Some(Ok(chunk)) => {
                    tee.accumulate(&chunk);
                    Some((Ok(chunk), tee))
                }
                Some(Err(error)) => {
                    tracing::warn!(%error, "gateway: upstream body ended early");
                    tee.finished = true;
                    tee.emit();
                    Some((Err(std::io::Error::other(error.to_string())), tee))
                }
                None => {
                    tee.finished = true;
                    tee.emit();
                    None
                }
            }
        })
    }
}

impl Drop for SettleTee {
    /// A client that hangs up mid-stream drops the body without the stream
    /// ever completing. The call still happened and still costs money, so it
    /// is settled with whatever the wire said.
    fn drop(&mut self) {
        self.emit();
    }
}

/// Drain the settle queue. Runs for the lifetime of the gateway state.
async fn settle_worker(
    pool: sqlx::PgPool,
    price_book: Arc<PriceBook>,
    mut rx: mpsc::Receiver<SettleJob>,
) {
    while let Some(job) = rx.recv().await {
        if let Err(error) = settle_one(&pool, &price_book, &job).await {
            tracing::error!(
                %error,
                model = %job.model_id,
                "gateway: settle failed — this call must be found by reconciliation"
            );
        }
    }
}

/// Settle one call: observed cost when the provider stated one, price-book
/// estimate when it did not, and nothing when there is no usage to settle.
///
/// Exactly-once comes from the idempotency reference: the upstream response
/// id. A retried settle (crash between stream end and commit, worker retry)
/// replays the same ref and the ledger's `UNIQUE (pubkey, ref)` makes it a
/// no-op. A call never settles at zero because its shape was unfamiliar:
/// unrecognized usage settles nothing and logs loudly instead.
async fn settle_one(
    pool: &sqlx::PgPool,
    price_book: &PriceBook,
    job: &SettleJob,
) -> anyhow::Result<()> {
    if !job.http_status.is_success() {
        // A failed call is not billed by the provider; nothing to settle.
        return Ok(());
    }

    let Some(request_id) = job.parsed.request_id.as_deref().filter(|id| !id.is_empty()) else {
        tracing::error!(
            model = %job.model_id,
            "gateway: successful call carried no request id — cannot settle idempotently, \
             this call must be found by reconciliation"
        );
        return Ok(());
    };

    match job.parsed.observed_cost_nanousd {
        Some(cost) => {
            buzz_db::credits::debit_observed(
                pool,
                &job.pubkey,
                cost,
                request_id,
                Some(&job.model_id),
                Some(request_id),
            )
            .await?;
            tracing::info!(
                cost_nanousd = cost,
                model = %job.model_id,
                request_id,
                "gateway: settled observed cost"
            );
        }
        None => match job.parsed.tokens {
            Some(tokens) => {
                let at_unix = Utc::now().timestamp().max(0) as u64;
                match price_book.price_tokens(&job.model_id, &tokens, at_unix) {
                    Some(cost) => {
                        let cost = u64::try_from(cost)
                            .map_err(|_| anyhow::anyhow!("estimated cost {cost} exceeds u64"))?;
                        buzz_db::credits::debit_estimated(
                            pool,
                            &job.pubkey,
                            cost,
                            request_id,
                            Some(&job.model_id),
                            Some(request_id),
                        )
                        .await?;
                        tracing::warn!(
                            cost_nanousd = cost,
                            model = %job.model_id,
                            request_id,
                            "gateway: provider stated no cost — settled price-book estimate"
                        );
                    }
                    None => {
                        tracing::error!(
                            model = %job.model_id,
                            request_id,
                            "gateway: provider stated no cost and the model is unpriced — \
                             no settle recorded, this call must be found by reconciliation"
                        );
                    }
                }
            }
            None => {
                tracing::warn!(
                    model = %job.model_id,
                    request_id,
                    "gateway: no usage in the response — nothing to settle"
                );
            }
        },
    }
    Ok(())
}

#[cfg(test)]
mod tests;
