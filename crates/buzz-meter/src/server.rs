//! The loopback proxy server: virtual keys, credential swap, and metering.

use std::pin::Pin;
use std::sync::Arc;
use std::{fmt, net::SocketAddr};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::{AUTHORIZATION, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use buzz_core::usage_record::UsageBreakdown;
use chrono::SecondsFormat;
use dashmap::DashMap;
use futures_util::stream::{Stream, StreamExt};
use thiserror::Error;
use tokio::sync::{mpsc, Notify};

use crate::{anthropic, openai, ParsedUsage};

/// Prefix every minted virtual key carries.
const VIRTUAL_KEY_PREFIX: &str = "colony-vk-";

/// Bound on the channel of observed calls. Generous, because the data path
/// never blocks on it: a full channel drops the record with a warning rather
/// than stalling the agent's response.
const CALL_CHANNEL_CAPACITY: usize = 4096;

/// How much of a response body is kept for parsing. Past this, the body keeps
/// streaming to the agent but the copy is abandoned.
const MAX_TEE_BYTES: usize = 8 * 1024 * 1024;

/// Ceiling on a buffered request body. Large enough for a long-context prompt
/// and small enough that a runaway agent cannot exhaust memory.
const MAX_REQUEST_BODY_BYTES: usize = 32 * 1024 * 1024;

const UNKNOWN_KEY_BODY: &str = r#"{"error":"colony-meter: unknown virtual key"}"#;
const NO_CREDENTIAL_BODY: &str = r#"{"error":"colony-meter: no provider credential configured"}"#;
const UPSTREAM_FAILED_BODY: &str = r#"{"error":"colony-meter: upstream request failed"}"#;
const UNROUTABLE_BODY: &str = r#"{"error":"colony-meter: no upstream route for this path"}"#;

/// Response header carrying the stable gateway denial status for diagnostics.
pub const COLONY_CREDITS_STATUS_HEADER: &str = "x-colony-credits-gateway-status";

/// Exact body markers carried through OpenAI-compatible adapters. ACP only
/// classifies these markers; ordinary text containing `401`/`402` is never a
/// provisioned denial.
pub const COLONY_CREDITS_GATEWAY_STATUS_401_MARKER: &str = "COLONY_CREDITS_GATEWAY_STATUS_401";
/// Exact body marker for a depleted Colony Credits gateway response.
pub const COLONY_CREDITS_GATEWAY_STATUS_402_MARKER: &str = "COLONY_CREDITS_GATEWAY_STATUS_402";

/// Return the canonical OpenAI-compatible JSON body for a gateway denial.
pub fn colony_credits_gateway_denial_body(status: u16) -> Option<&'static str> {
    match status {
        401 => Some(
            r#"{"error":{"type":"colony_credits_gateway","code":"COLONY_CREDITS_GATEWAY_UNAUTHORIZED","message":"Colony Credits gateway authorization expired — reconnect","colony_credits_gateway_marker":"COLONY_CREDITS_GATEWAY_STATUS_401"}}"#,
        ),
        402 => Some(
            r#"{"error":{"type":"colony_credits_gateway","code":"COLONY_CREDITS_GATEWAY_DEPLETED","message":"Colony Credits depleted — top up, then reconnect","colony_credits_gateway_marker":"COLONY_CREDITS_GATEWAY_STATUS_402"}}"#,
        ),
        _ => None,
    }
}

fn colony_credits_status(status: StatusCode) -> Option<HeaderValue> {
    match status {
        StatusCode::UNAUTHORIZED => Some(HeaderValue::from_static("401")),
        StatusCode::PAYMENT_REQUIRED => Some(HeaderValue::from_static("402")),
        _ => None,
    }
}

/// Which provider a request is bound for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Anthropic,
    OpenAi,
}

impl Provider {
    fn slug(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
        }
    }
}

/// Derive a vendor slug from an upstream base URL.
///
/// `https://api.deepseek.com` becomes `deepseek`; `https://api.openai.com`
/// becomes `openai`. Returns `None` when the host yields no usable label.
fn provider_slug_from_upstream(upstream: &str) -> Option<String> {
    let without_scheme = upstream
        .split_once("://")
        .map_or(upstream, |(_, rest)| rest);
    // A bracketed IPv6 literal has no vendor name and would otherwise be
    // split apart by the port separator below.
    if without_scheme.starts_with('[') {
        return None;
    }
    let host = without_scheme
        .split(['/', ':'])
        .next()
        .filter(|host| !host.is_empty())?;

    // An address is not a vendor. A local or IP-literal upstream has no name
    // to record, so the caller falls back to the route's own slug rather than
    // inventing one out of an octet.
    if host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }

    let labels: Vec<&str> = host.split('.').filter(|part| !part.is_empty()).collect();
    // Take the registrable label: `api.deepseek.com` reduces to `deepseek`.
    let vendor = match labels.as_slice() {
        [] => return None,
        [single] => *single,
        labels => *labels.get(labels.len() - 2)?,
    };
    (!vendor.is_empty()).then(|| vendor.to_ascii_lowercase())
}

/// Which credential paid for an observed call.
///
/// The checkpoint's job is to observe token counts, not to own the money. It
/// can do that in two arrangements, and the difference is a pricing fact
/// rather than an access-control one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallCredential {
    /// Forwarded with the checkpoint's own provider key: real money, billed
    /// to us per token.
    Metered,
    /// Forwarded with the agent's own credential, typically a CLI's
    /// subscription login. No per-token bill exists, so the tokens are still
    /// counted and priced at API-equivalent rates as shadow cost.
    Subscription,
}

/// One observed provider call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeteredCall {
    /// Provider slug: `anthropic` or `openai`.
    pub provider: String,
    /// Provider request id. Empty only when the provider supplied neither a
    /// request-id header nor a body id.
    pub request_id: String,
    /// Model identifier as the provider named it, when the response said.
    pub model: Option<String>,
    /// HTTP status the provider returned.
    pub http_status: u16,
    /// Provider-itemized token counts. `None` for a non-2xx response or a
    /// body the parser did not understand.
    pub tokens: Option<UsageBreakdown>,
    /// What the provider said the call cost, in nanoUSD, when it said.
    /// `None` leaves the price book to work it out.
    pub observed_cost_nanousd: Option<u64>,
    /// RFC 3339 UTC timestamp captured at response completion.
    pub timestamp: String,
    /// Label bound to the agent that made the call.
    pub agent_label: String,
    /// Whose credential the call was forwarded with.
    pub credential: CallCredential,
}

/// How the checkpoint reaches each provider, and with which real credential.
///
/// The two routes are API **dialects**, not vendors. Anything speaking
/// Anthropic's wire format goes through one and anything speaking OpenAI's
/// through the other, which is why an upstream and a vendor slug are separate
/// settings: Vertex, Bedrock, DeepSeek, OpenRouter and a local runtime all
/// speak one of the two dialects while each sending its own invoice.
#[derive(Clone)]
pub struct MeterConfig {
    /// Base URL for Anthropic-dialect requests.
    pub anthropic_upstream: String,
    /// Base URL for OpenAI-dialect requests.
    pub openai_upstream: String,
    /// Vendor slug recorded for Anthropic-dialect calls, when the operator
    /// states it. Absent means derive it from the upstream host.
    pub anthropic_provider: Option<String>,
    /// Vendor slug recorded for OpenAI-dialect calls, on the same terms.
    pub openai_provider: Option<String>,
    /// Real Anthropic API key. Lives only in this process.
    pub anthropic_api_key: Option<String>,
    /// Real OpenAI API key. Lives only in this process.
    pub openai_api_key: Option<String>,
}

impl fmt::Debug for MeterConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MeterConfig")
            .field("anthropic_upstream", &self.anthropic_upstream)
            .field("openai_upstream", &self.openai_upstream)
            .field("anthropic_provider", &self.anthropic_provider)
            .field("openai_provider", &self.openai_provider)
            .field(
                "anthropic_api_key",
                &self.anthropic_api_key.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "openai_api_key",
                &self.openai_api_key.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl Default for MeterConfig {
    fn default() -> Self {
        Self {
            anthropic_upstream: "https://api.anthropic.com".to_string(),
            openai_upstream: "https://api.openai.com".to_string(),
            anthropic_provider: None,
            openai_provider: None,
            anthropic_api_key: None,
            openai_api_key: None,
        }
    }
}

impl MeterConfig {
    fn upstream(&self, provider: Provider) -> &str {
        match provider {
            Provider::Anthropic => &self.anthropic_upstream,
            Provider::OpenAi => &self.openai_upstream,
        }
    }

    /// The vendor slug recorded on a usage record for this route.
    ///
    /// Derived from the upstream host, not the API dialect. An
    /// OpenAI-compatible vendor like DeepSeek is reached through the
    /// `/openai` route but sends its own invoice, and reconciliation compares
    /// per provider. Recording that spend as "openai" would compare it
    /// against the wrong bill.
    ///
    /// An operator-stated slug wins over the derivation, because a host name
    /// does not always name the seller: a loopback address, a gateway, a
    /// private endpoint and a vanity domain all bill under a name the URL
    /// never mentions. It is stated rather than guessed for the same reason
    /// the price book will not infer that a local runtime is free from the
    /// fact that its address is a loopback one. Guessing there means real
    /// spend silently reading as zero.
    fn provider_slug(&self, provider: Provider) -> String {
        let stated = match provider {
            Provider::Anthropic => self.anthropic_provider.as_deref(),
            Provider::OpenAi => self.openai_provider.as_deref(),
        };
        stated
            .map(str::trim)
            .filter(|slug| !slug.is_empty())
            .map(|slug| slug.to_ascii_lowercase())
            .or_else(|| provider_slug_from_upstream(self.upstream(provider)))
            .unwrap_or_else(|| provider.slug().to_string())
    }

    /// The vendor slug Anthropic-dialect calls will be recorded under.
    ///
    /// Exposed so an operator can be told at startup, before any money is
    /// spent under a name they did not intend.
    pub fn recorded_provider_anthropic(&self) -> String {
        self.provider_slug(Provider::Anthropic)
    }

    /// The vendor slug OpenAI-dialect calls will be recorded under.
    pub fn recorded_provider_openai(&self) -> String {
        self.provider_slug(Provider::OpenAi)
    }

    fn credential(&self, provider: Provider) -> Option<&str> {
        let key = match provider {
            Provider::Anthropic => self.anthropic_api_key.as_deref(),
            Provider::OpenAi => self.openai_api_key.as_deref(),
        };
        key.filter(|value| !value.trim().is_empty())
    }
}

/// Why the checkpoint could not start.
#[derive(Debug, Error)]
pub enum MeterError {
    /// The loopback listener could not be bound or inspected.
    #[error("could not bind the metering checkpoint on 127.0.0.1: {0}")]
    Bind(#[source] std::io::Error),
    /// The upstream HTTP client could not be built.
    #[error("could not build the upstream HTTP client: {0}")]
    Client(#[source] reqwest::Error),
}

/// Control surface for a running checkpoint.
///
/// Cloning is cheap and every clone controls the same checkpoint.
#[derive(Debug, Clone)]
pub struct MeterHandle {
    keys: Arc<DashMap<String, String>>,
    shutdown: Arc<Notify>,
}

impl MeterHandle {
    /// Mint a per-agent virtual key bound to `label`.
    ///
    /// The token is `colony-vk-` followed by 32 random bytes, hex encoded. It
    /// is the only credential the agent ever sees, and it is worthless outside
    /// this checkpoint: it is never forwarded to a provider.
    pub fn issue_virtual_key(&self, label: &str) -> String {
        let mut bytes = [0u8; 32];
        rand::fill(&mut bytes);
        let key = format!("{VIRTUAL_KEY_PREFIX}{}", hex::encode(bytes));
        self.keys.insert(key.clone(), label.to_string());
        key
    }

    /// Revoke a virtual key so a leaked token dies with the agent process.
    ///
    /// Calls presenting the revoked token are rejected locally from the next
    /// request onward. Revoking a key that was never issued does nothing.
    pub fn revoke_virtual_key(&self, key: &str) {
        self.keys.remove(key);
    }

    /// Stop serving and close the channel of observed calls.
    ///
    /// Every outstanding virtual key is revoked first, so no request can
    /// authenticate during the graceful drain.
    pub fn shutdown(&self) {
        self.keys.clear();
        self.shutdown.notify_one();
    }
}

#[derive(Clone)]
struct MeterState {
    config: Arc<MeterConfig>,
    keys: Arc<DashMap<String, String>>,
    client: reqwest::Client,
    calls: mpsc::Sender<MeteredCall>,
}

/// Start the checkpoint on an ephemeral loopback port.
///
/// Returns the bound port, the stream of observed calls, and the control
/// handle used to mint and revoke virtual keys. The server runs on a spawned
/// task; dropping the handle does not stop it, [`MeterHandle::shutdown`] does.
///
/// # Errors
///
/// Fails if the loopback listener cannot be bound or the upstream HTTP client
/// cannot be built.
pub async fn start_meter(
    config: MeterConfig,
) -> Result<(u16, mpsc::Receiver<MeteredCall>, MeterHandle), MeterError> {
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(MeterError::Bind)?;
    let port = listener.local_addr().map_err(MeterError::Bind)?.port();

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(MeterError::Client)?;

    let (calls_tx, calls_rx) = mpsc::channel(CALL_CHANNEL_CAPACITY);
    let keys: Arc<DashMap<String, String>> = Arc::new(DashMap::new());
    let shutdown = Arc::new(Notify::new());

    let state = MeterState {
        config: Arc::new(config),
        keys: Arc::clone(&keys),
        client,
        calls: calls_tx,
    };

    let app = Router::new()
        .route("/anthropic/{*rest}", any(anthropic_route))
        .route("/openai/{*rest}", any(openai_route))
        .fallback(unroutable)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .with_state(state);

    let signal = Arc::clone(&shutdown);
    tokio::spawn(async move {
        let served = axum::serve(listener, app)
            .with_graceful_shutdown(async move { signal.notified().await })
            .await;
        if let Err(error) = served {
            tracing::warn!(%error, "colony-meter: checkpoint stopped serving");
        }
    });

    Ok((port, calls_rx, MeterHandle { keys, shutdown }))
}

async fn anthropic_route(
    State(state): State<MeterState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    forward(state, Provider::Anthropic, method, uri, headers, body).await
}

async fn openai_route(
    State(state): State<MeterState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    forward(state, Provider::OpenAi, method, uri, headers, body).await
}

async fn unroutable(uri: Uri) -> Response {
    tracing::warn!(path = %uri.path(), "colony-meter: no upstream route for this path");
    local_error(StatusCode::BAD_GATEWAY, UNROUTABLE_BODY)
}

/// Who made the call and what to ask upstream for, taken raw off the request
/// line.
///
/// Deliberately not the `Path` extractor: that percent-decodes, which would
/// turn an encoded `%2F` inside a path segment into a real separator and send
/// the provider a different path than the agent asked for.
///
/// A base URL of `/anthropic/k/<virtual-key>` carries the caller's identity in
/// the URL, which is what lets the credential header stay the agent's own. The
/// bare `/anthropic` form still works and attributes by credential instead.
fn split_agent_path(uri: &Uri, provider: Provider) -> (Option<&str>, &str) {
    let prefix = match provider {
        Provider::Anthropic => "/anthropic/",
        Provider::OpenAi => "/openai/",
    };
    // The route only matches when the prefix is present, so the fallback is
    // unreachable; it exists so a routing change cannot panic here.
    let rest = uri.path().strip_prefix(prefix).unwrap_or("");
    let Some(after_marker) = rest.strip_prefix("k/") else {
        return (None, rest);
    };
    match after_marker.split_once('/') {
        Some((key, tail)) if !key.is_empty() => (Some(key), tail),
        // `/anthropic/k/<key>` with nothing after it: still attributable, and
        // the empty upstream path is answered by the provider, not guessed at.
        None if !after_marker.is_empty() => (Some(after_marker), ""),
        _ => (None, rest),
    }
}

async fn forward(
    state: MeterState,
    provider: Provider,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Identify the caller before anything else touches the network. Identity
    // comes from the URL when the agent kept its own credential, and from the
    // credential itself when the checkpoint issued it.
    let (path_key, upstream_rest) = split_agent_path(&uri, provider);
    let header_token = extract_credential(&headers);
    let agent_label = match path_key.and_then(|key| state.keys.get(key)) {
        Some(entry) => entry.value().clone(),
        None => {
            let Some(label) = header_token
                .as_ref()
                .and_then(|token| state.keys.get(token))
                .map(|entry| entry.value().clone())
            else {
                return local_error(StatusCode::UNAUTHORIZED, UNKNOWN_KEY_BODY);
            };
            label
        }
    };

    // Whose credential goes upstream. A configured provider key means the
    // checkpoint pays and the agent never holds a real one. Without it the
    // agent's own credential rides through untouched, which is how a CLI
    // logged into a subscription keeps working: its tokens are still counted
    // here, they are simply not billed to us per call.
    let (credential, forwarded_credential) = match state.config.credential(provider) {
        Some(real_key) => {
            let Some(header) = credential_header(provider, real_key) else {
                tracing::error!(
                    provider = provider.slug(),
                    "colony-meter: configured provider key is not a valid HTTP header value"
                );
                return local_error(StatusCode::BAD_GATEWAY, UPSTREAM_FAILED_BODY);
            };
            (CallCredential::Metered, Some(header))
        }
        None => {
            // A virtual key must never reach a provider: it would authenticate
            // nothing and leak an internal token. This is the harness pointing
            // an agent at the checkpoint while stripping the credential that
            // would have paid for the call.
            let agent_holds_own_credential = header_token
                .as_ref()
                .is_some_and(|token| !state.keys.contains_key(token));
            if !agent_holds_own_credential {
                return local_error(StatusCode::UNAUTHORIZED, NO_CREDENTIAL_BODY);
            }
            (CallCredential::Subscription, None)
        }
    };

    // The only body rewrite the checkpoint is allowed to make.
    let outbound_body = match provider {
        Provider::OpenAi => match openai::ensure_stream_usage(&body) {
            Some(rewritten) => Bytes::from(rewritten),
            None => body,
        },
        Provider::Anthropic => body,
    };

    let mut outbound_headers = HeaderMap::with_capacity(headers.len() + 1);
    for (name, value) in headers.iter() {
        // The agent's credential headers are dropped when the checkpoint
        // supplies its own, and kept when it does not: in subscription mode
        // they are the only thing that can authenticate the call.
        if is_stripped_request_header(name)
            && !(credential == CallCredential::Subscription && is_credential_header(name))
        {
            continue;
        }
        outbound_headers.append(name.clone(), value.clone());
    }
    // Ask upstream for a body the checkpoint can read. Stated explicitly
    // rather than merely omitted, because an absent accept-encoding lets a
    // server choose compression on its own.
    outbound_headers.insert(
        HeaderName::from_static("accept-encoding"),
        HeaderValue::from_static("identity"),
    );
    if let Some((credential_name, credential_value)) = forwarded_credential {
        outbound_headers.insert(credential_name, credential_value);
    }

    let mut url = format!(
        "{}/{}",
        state.config.upstream(provider).trim_end_matches('/'),
        upstream_rest
    );
    if let Some(query) = uri.query() {
        url.push('?');
        url.push_str(query);
    }

    let sent = state
        .client
        .request(method, &url)
        .headers(outbound_headers)
        .body(outbound_body)
        .send()
        .await;
    let response = match sent {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(
                provider = provider.slug(),
                %error,
                "colony-meter: upstream request failed"
            );
            return local_error(StatusCode::BAD_GATEWAY, UPSTREAM_FAILED_BODY);
        }
    };

    let status = response.status();
    let upstream_headers = response.headers().clone();

    // A content-encoded body is forwarded verbatim (transparency wins) but
    // cannot be parsed, since the checkpoint never decompresses.
    let encoded = upstream_headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| !value.trim().eq_ignore_ascii_case("identity"))
        .unwrap_or(false);
    if encoded {
        tracing::warn!(
            provider = provider.slug(),
            "colony-meter: content-encoded response forwarded without token counts"
        );
    }

    let meta = CallMeta {
        provider,
        provider_slug: state.config.provider_slug(provider),
        agent_label,
        credential,
        http_status: status,
        header_request_id: header_request_id(&upstream_headers),
        is_sse: is_event_stream(&upstream_headers),
        parseable: !encoded,
    };
    let canonical_denial_body = colony_credits_gateway_denial_body(status.as_u16());
    let response_stream: UpstreamStream = if let Some(body) = canonical_denial_body {
        Box::pin(futures_util::stream::once(async move {
            Ok::<Bytes, reqwest::Error>(Bytes::from_static(body.as_bytes()))
        }))
    } else {
        Box::pin(response.bytes_stream())
    };
    let tee = Tee::new(response_stream, meta, state.calls.clone());

    let mut builder = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        if is_hop_by_hop(name) || (canonical_denial_body.is_some() && name == CONTENT_LENGTH) {
            continue;
        }
        builder = builder.header(name, value);
    }
    if let Some(status) = colony_credits_status(status) {
        builder = builder.header(COLONY_CREDITS_STATUS_HEADER, status);
    }
    if canonical_denial_body.is_some() {
        builder = builder.header(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    match builder.body(Body::from_stream(tee.into_stream())) {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "colony-meter: could not build the proxied response");
            local_error(StatusCode::BAD_GATEWAY, UPSTREAM_FAILED_BODY)
        }
    }
}

fn local_error(status: StatusCode, body: &'static str) -> Response {
    (
        status,
        [(CONTENT_TYPE, HeaderValue::from_static("application/json"))],
        body,
    )
        .into_response()
}

/// Read the caller's credential from either provider's header convention.
///
/// Both headers are accepted on both routes so an agent harness configured for
/// one provider's SDK still authenticates against the other's path.
fn extract_credential(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
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

fn credential_header(provider: Provider, real_key: &str) -> Option<(HeaderName, HeaderValue)> {
    let (name, raw) = match provider {
        Provider::Anthropic => (HeaderName::from_static("x-api-key"), real_key.to_string()),
        Provider::OpenAi => (AUTHORIZATION, format!("Bearer {real_key}")),
    };
    let mut value = HeaderValue::from_str(&raw).ok()?;
    value.set_sensitive(true);
    Some((name, value))
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

/// Request headers the checkpoint replaces rather than forwards.
///
/// `host` and `content-length` are transport facts of the old hop, not part of
/// the caller's semantic request: the host is now the provider, and the body
/// length can change when `stream_options` is merged. The two credential
/// headers are replaced with the real key.
///
/// `accept-encoding` is replaced with `identity`. Most provider SDKs ask for
/// gzip by default; a compressed body cannot be parsed, and an unparseable
/// body means a call that is correctly proxied, invisible to the ledger, and
/// indistinguishable from an agent that spent nothing. Silent invisibility is
/// the one outcome the checkpoint exists to prevent, so it declines the
/// compression rather than declining to measure.
fn is_stripped_request_header(name: &HeaderName) -> bool {
    is_hop_by_hop(name)
        || matches!(
            name.as_str(),
            "host" | "content-length" | "x-api-key" | "authorization" | "accept-encoding"
        )
}

/// Headers carrying a caller credential, in either provider's dialect.
fn is_credential_header(name: &HeaderName) -> bool {
    matches!(name.as_str(), "x-api-key" | "authorization")
}

fn header_request_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("request-id")
        .or_else(|| headers.get("x-request-id"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .filter(|value| !value.is_empty())
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

/// Everything needed to turn a finished response body into a [`MeteredCall`].
struct CallMeta {
    provider: Provider,
    /// Vendor slug recorded on the usage record. Derived from the upstream
    /// host rather than the route, so an OpenAI-compatible vendor is not
    /// recorded as OpenAI and reconciled against the wrong invoice.
    provider_slug: String,
    agent_label: String,
    /// Whose credential this call was forwarded with. Decided per call, so a
    /// harness holding a key for one provider and not the other records each
    /// accurately.
    credential: CallCredential,
    http_status: StatusCode,
    header_request_id: Option<String>,
    is_sse: bool,
    parseable: bool,
}

impl CallMeta {
    fn parse(&self, body: &[u8]) -> ParsedUsage {
        match (self.provider, self.is_sse) {
            (Provider::Anthropic, true) => anthropic::parse_sse_response(body),
            (Provider::Anthropic, false) => anthropic::parse_json_response(body),
            (Provider::OpenAi, true) => openai::parse_sse_response(body),
            (Provider::OpenAi, false) => openai::parse_json_response(body),
        }
    }

    /// Anthropic stamps the authoritative id on the `request-id` response
    /// header; OpenAI puts it in the body. Each is preferred for its provider,
    /// with the other as a fallback.
    fn resolve_request_id(&self, from_body: Option<String>) -> String {
        let resolved = match self.provider {
            Provider::Anthropic => self.header_request_id.clone().or(from_body),
            Provider::OpenAi => from_body.or_else(|| self.header_request_id.clone()),
        };
        resolved.unwrap_or_default()
    }
}

type UpstreamStream = Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>;

/// Forwards the upstream body chunk by chunk while keeping a bounded copy for
/// parsing. The forwarded bytes are never touched.
struct Tee {
    upstream: UpstreamStream,
    buffer: Vec<u8>,
    truncated: bool,
    finished: bool,
    meta: Option<CallMeta>,
    calls: mpsc::Sender<MeteredCall>,
}

impl Tee {
    fn new(upstream: UpstreamStream, meta: CallMeta, calls: mpsc::Sender<MeteredCall>) -> Self {
        Self {
            upstream,
            buffer: Vec::new(),
            truncated: false,
            finished: false,
            meta: Some(meta),
            calls,
        }
    }

    fn accumulate(&mut self, chunk: &Bytes) {
        if self.truncated {
            return;
        }
        if self.buffer.len().saturating_add(chunk.len()) > MAX_TEE_BYTES {
            tracing::warn!(
                cap_bytes = MAX_TEE_BYTES,
                "colony-meter: response exceeded the parse cap, still forwarding but no token counts"
            );
            self.truncated = true;
            self.buffer = Vec::new();
            return;
        }
        self.buffer.extend_from_slice(chunk);
    }

    /// Emit the call record. Idempotent: the metadata is consumed on the first
    /// call, so the explicit end-of-stream path and the `Drop` safety net
    /// between them produce exactly one record per forwarded request.
    fn emit(&mut self) {
        let Some(meta) = self.meta.take() else {
            return;
        };

        let parsed = if self.truncated || !meta.parseable || !meta.http_status.is_success() {
            ParsedUsage::default()
        } else {
            meta.parse(&self.buffer)
        };
        self.buffer = Vec::new();

        let call = MeteredCall {
            provider: meta.provider_slug.clone(),
            request_id: meta.resolve_request_id(parsed.request_id),
            model: parsed.model,
            http_status: meta.http_status.as_u16(),
            tokens: parsed.tokens,
            observed_cost_nanousd: parsed.observed_cost_nanousd,
            timestamp: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            agent_label: meta.agent_label,
            credential: meta.credential,
        };

        // Never block the agent's response on the ledger writer.
        if let Err(error) = self.calls.try_send(call) {
            tracing::warn!(
                %error,
                "colony-meter: dropped a metered call, the receiver is full or gone"
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
                    tracing::warn!(%error, "colony-meter: upstream body ended early");
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

impl Drop for Tee {
    /// A client that hangs up mid-stream drops the body without the stream
    /// ever completing. The call still happened and still costs money, so it
    /// is recorded with whatever the status line said.
    fn drop(&mut self) {
        self.emit();
    }
}

#[cfg(test)]
mod slug_tests {
    use super::*;

    #[test]
    fn gateway_denial_statuses_have_stable_machine_header_values() {
        assert!(colony_credits_status(StatusCode::UNAUTHORIZED)
            .is_some_and(|value| value.as_bytes() == b"401"));
        assert!(colony_credits_status(StatusCode::PAYMENT_REQUIRED)
            .is_some_and(|value| value.as_bytes() == b"402"));
        assert!(colony_credits_status(StatusCode::BAD_GATEWAY).is_none());
    }

    #[test]
    fn a_vendor_slug_comes_from_the_upstream_host_not_the_route() {
        // Found by the live proof: a real DeepSeek call was recorded as
        // "openai" because it uses the OpenAI-compatible route. Reconciliation
        // compares per provider, so that record would have been checked
        // against an OpenAI invoice that never contained it.
        assert_eq!(
            provider_slug_from_upstream("https://api.deepseek.com").as_deref(),
            Some("deepseek")
        );
        assert_eq!(
            provider_slug_from_upstream("https://api.openai.com").as_deref(),
            Some("openai")
        );
        assert_eq!(
            provider_slug_from_upstream("https://api.anthropic.com").as_deref(),
            Some("anthropic")
        );
        assert_eq!(
            provider_slug_from_upstream("https://openrouter.ai/api/v1").as_deref(),
            Some("openrouter")
        );
        assert_eq!(provider_slug_from_upstream("").as_deref(), None);

        // An address is not a vendor name. Recording "0" for 127.0.0.1 would
        // put test traffic under a provider that does not exist.
        for not_a_vendor in [
            "http://127.0.0.1:8080/v1",
            "http://localhost:3000",
            "http://[::1]:9000",
        ] {
            assert_eq!(
                provider_slug_from_upstream(not_a_vendor).as_deref(),
                None,
                "{not_a_vendor} has no vendor name to record"
            );
        }
    }

    #[test]
    fn config_falls_back_to_the_route_slug_when_the_host_is_unusable() {
        let config = MeterConfig {
            openai_upstream: String::new(),
            ..MeterConfig::default()
        };
        assert_eq!(config.provider_slug(Provider::OpenAi), "openai");
        assert_eq!(config.provider_slug(Provider::Anthropic), "anthropic");

        let deepseek = MeterConfig {
            openai_upstream: "https://api.deepseek.com".to_string(),
            ..MeterConfig::default()
        };
        assert_eq!(deepseek.provider_slug(Provider::OpenAi), "deepseek");
    }

    /// A host name does not always name the seller. Bedrock and Vertex serve
    /// Anthropic's models under Amazon's and Google's domains and send their
    /// own invoices, and a private or gateway endpoint may carry a name that
    /// appears on no bill at all. The operator states it; the URL does not
    /// get a vote.
    #[test]
    fn a_stated_slug_wins_over_the_host() {
        let bedrock = MeterConfig {
            anthropic_upstream: "https://bedrock-runtime.us-east-1.amazonaws.com".to_string(),
            anthropic_provider: Some("bedrock".to_string()),
            ..MeterConfig::default()
        };
        assert_eq!(bedrock.provider_slug(Provider::Anthropic), "bedrock");
        assert_eq!(
            provider_slug_from_upstream(&bedrock.anthropic_upstream).as_deref(),
            Some("amazonaws"),
            "and without the operator saying so it would have been billed to 'amazonaws'"
        );
    }

    /// The case that must never be inferred. A loopback upstream yields no
    /// vendor, so without a stated slug the call is recorded under the route's
    /// dialect and would reconcile against OpenAI's invoice. Saying `local`
    /// out loud is what makes it safe to price at zero later; deriving it from
    /// the fact that an address is a loopback one would zero the spend of
    /// anyone tunnelling to a real vendor through 127.0.0.1.
    #[test]
    fn a_local_runtime_is_recorded_only_when_the_operator_names_it() {
        let unnamed = MeterConfig {
            openai_upstream: "http://127.0.0.1:11434/v1".to_string(),
            ..MeterConfig::default()
        };
        assert_eq!(
            unnamed.provider_slug(Provider::OpenAi),
            "openai",
            "an unnamed loopback upstream is not silently called local"
        );

        let named = MeterConfig {
            openai_provider: Some("ollama".to_string()),
            ..unnamed
        };
        assert_eq!(named.provider_slug(Provider::OpenAi), "ollama");
    }

    /// Slugs are compared case-insensitively against price rows and are half
    /// of a usage record's dedupe key, so they are normalised once here rather
    /// than at every reader.
    #[test]
    fn a_stated_slug_is_trimmed_and_lowercased() {
        let config = MeterConfig {
            openai_provider: Some("  OpenRouter  ".to_string()),
            ..MeterConfig::default()
        };
        assert_eq!(config.provider_slug(Provider::OpenAi), "openrouter");
    }

    /// A blank statement is not a statement. Falling through to the host
    /// keeps an empty environment variable from renaming every record to "".
    #[test]
    fn a_blank_stated_slug_falls_through_to_the_host() {
        let config = MeterConfig {
            openai_upstream: "https://api.deepseek.com".to_string(),
            openai_provider: Some("   ".to_string()),
            ..MeterConfig::default()
        };
        assert_eq!(config.provider_slug(Provider::OpenAi), "deepseek");
    }

    #[test]
    fn meter_config_debug_redacts_provider_keys() {
        let config = MeterConfig {
            openai_api_key: Some("gateway-token-test".to_string()),
            anthropic_api_key: Some("anthropic-token-test".to_string()),
            ..MeterConfig::default()
        };
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("gateway-token-test"));
        assert!(!rendered.contains("anthropic-token-test"));
    }
}
