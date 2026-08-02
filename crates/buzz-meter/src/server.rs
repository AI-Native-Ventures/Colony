//! The loopback proxy server: virtual keys, credential swap, and metering.

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::{AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
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
    /// RFC 3339 UTC timestamp captured at response completion.
    pub timestamp: String,
    /// Label bound to the virtual key that authenticated the call.
    pub agent_label: String,
}

/// How the checkpoint reaches each provider, and with which real credential.
#[derive(Debug, Clone)]
pub struct MeterConfig {
    /// Base URL for Anthropic requests.
    pub anthropic_upstream: String,
    /// Base URL for OpenAI requests.
    pub openai_upstream: String,
    /// Real Anthropic API key. Lives only in this process.
    pub anthropic_api_key: Option<String>,
    /// Real OpenAI API key. Lives only in this process.
    pub openai_api_key: Option<String>,
}

impl Default for MeterConfig {
    fn default() -> Self {
        Self {
            anthropic_upstream: "https://api.anthropic.com".to_string(),
            openai_upstream: "https://api.openai.com".to_string(),
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
    fn provider_slug(&self, provider: Provider) -> String {
        provider_slug_from_upstream(self.upstream(provider))
            .unwrap_or_else(|| provider.slug().to_string())
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

/// The upstream path, taken raw off the request line.
///
/// Deliberately not the `Path` extractor: that percent-decodes, which would
/// turn an encoded `%2F` inside a path segment into a real separator and send
/// the provider a different path than the agent asked for.
fn upstream_path(uri: &Uri, provider: Provider) -> &str {
    let prefix = match provider {
        Provider::Anthropic => "/anthropic/",
        Provider::OpenAi => "/openai/",
    };
    // The route only matches when the prefix is present, so the fallback is
    // unreachable; it exists so a routing change cannot panic here.
    uri.path().strip_prefix(prefix).unwrap_or("")
}

async fn forward(
    state: MeterState,
    provider: Provider,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Authenticate before anything else touches the network. An unknown,
    // revoked, or absent credential is answered here and never forwarded.
    let Some(token) = extract_credential(&headers) else {
        return local_error(StatusCode::UNAUTHORIZED, UNKNOWN_KEY_BODY);
    };
    let Some(agent_label) = state.keys.get(&token).map(|entry| entry.value().clone()) else {
        return local_error(StatusCode::UNAUTHORIZED, UNKNOWN_KEY_BODY);
    };
    let Some(real_key) = state.config.credential(provider) else {
        // Deliberately not a forward: sending the virtual key upstream would
        // leak an internal token to the provider and bill nobody.
        return local_error(StatusCode::UNAUTHORIZED, NO_CREDENTIAL_BODY);
    };
    let Some((credential_name, credential_value)) = credential_header(provider, real_key) else {
        tracing::error!(
            provider = provider.slug(),
            "colony-meter: configured provider key is not a valid HTTP header value"
        );
        return local_error(StatusCode::BAD_GATEWAY, UPSTREAM_FAILED_BODY);
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
        if is_stripped_request_header(name) {
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
    outbound_headers.insert(credential_name, credential_value);

    let mut url = format!(
        "{}/{}",
        state.config.upstream(provider).trim_end_matches('/'),
        upstream_path(&uri, provider)
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
        http_status: status,
        header_request_id: header_request_id(&upstream_headers),
        is_sse: is_event_stream(&upstream_headers),
        parseable: !encoded,
    };
    let tee = Tee::new(Box::pin(response.bytes_stream()), meta, state.calls.clone());

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
            timestamp: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            agent_label: meta.agent_label,
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
}
