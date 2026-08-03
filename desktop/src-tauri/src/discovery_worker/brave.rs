use std::{fmt, time::Duration};

use buzz_core_pkg::{
    discovery::DiscoveryBusinessSearchSpec,
    discovery_worker::{DiscoveryBusinessObservationInput, DiscoveryProvider},
};
use futures_util::StreamExt as _;
use reqwest::{Response, StatusCode};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::normalization::{normalize_web_businesses, WebBusinessCandidate};

const BRAVE_SEARCH_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
const MAX_BRAVE_COUNT: usize = 20;
const MAX_BRAVE_OFFSET: u8 = 9;

#[derive(Clone, Copy)]
pub(super) struct BravePolicy {
    request_timeout: Duration,
    retry_backoff: Duration,
    max_retries: usize,
    max_response_bytes: usize,
}

impl Default for BravePolicy {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(15),
            retry_backoff: Duration::from_millis(500),
            max_retries: 2,
            max_response_bytes: 2 * 1024 * 1024,
        }
    }
}

pub(crate) struct BraveSearchClient {
    http: reqwest::Client,
    endpoint: String,
    policy: BravePolicy,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BraveSearchOutcome {
    pub(crate) observations: Vec<DiscoveryBusinessObservationInput>,
    pub(crate) request_count: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BraveError {
    CredentialRejected,
    BillingRequired,
    InvalidRequest,
    RateLimited,
    ProviderUnavailable,
    ProviderFailed,
    MalformedResponse,
    ResponseTooLarge,
    RequestTimedOut,
    Cancelled,
}

impl fmt::Display for BraveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::CredentialRejected => "Brave Search rejected the saved API key",
            Self::BillingRequired => "the Brave Search account requires billing attention",
            Self::InvalidRequest => "Brave Search rejected the business search",
            Self::RateLimited => "Brave Search remained rate limited after bounded retries",
            Self::ProviderUnavailable => "Brave Search remained unavailable after bounded retries",
            Self::ProviderFailed => "Brave Search could not complete the business search",
            Self::MalformedResponse => "Brave Search returned an invalid response",
            Self::ResponseTooLarge => "Brave Search returned more data than Colony accepts",
            Self::RequestTimedOut => "the Brave Search request timed out",
            Self::Cancelled => "the Discovery source request was cancelled",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for BraveError {}

#[derive(Deserialize)]
struct BraveEnvelope {
    query: Option<BraveQuery>,
    web: Option<BraveWebResults>,
}

#[derive(Deserialize)]
struct BraveQuery {
    #[serde(default)]
    more_results_available: bool,
}

#[derive(Deserialize)]
struct BraveWebResults {
    #[serde(default)]
    results: Vec<BraveWebResult>,
}

#[derive(Deserialize)]
struct BraveWebResult {
    title: Option<String>,
    url: Option<String>,
    description: Option<String>,
    profile: Option<BraveProfile>,
    meta_url: Option<BraveMetaUrl>,
    thumbnail: Option<BraveThumbnail>,
}

#[derive(Deserialize)]
struct BraveProfile {
    name: Option<String>,
    img: Option<String>,
}

#[derive(Deserialize)]
struct BraveMetaUrl {
    favicon: Option<String>,
}

#[derive(Deserialize)]
struct BraveThumbnail {
    src: Option<String>,
    original: Option<String>,
}

impl From<BraveWebResult> for WebBusinessCandidate {
    fn from(result: BraveWebResult) -> Self {
        let profile_name = result
            .profile
            .as_ref()
            .and_then(|profile| profile.name.clone());
        let image_url = result
            .profile
            .and_then(|profile| profile.img)
            .or_else(|| {
                result
                    .thumbnail
                    .and_then(|thumbnail| thumbnail.src.or(thumbnail.original))
            })
            .or_else(|| result.meta_url.and_then(|meta| meta.favicon));
        Self {
            title: result.title,
            url: result.url,
            description: result.description,
            image_url,
            profile_name,
        }
    }
}

impl BraveSearchClient {
    pub(crate) fn production() -> Result<Self, BraveError> {
        Self::with_config(BRAVE_SEARCH_ENDPOINT.to_owned(), BravePolicy::default())
    }

    fn with_config(endpoint: String, policy: BravePolicy) -> Result<Self, BraveError> {
        let http = reqwest::Client::builder()
            .connect_timeout(policy.request_timeout)
            .timeout(policy.request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| BraveError::ProviderUnavailable)?;
        Ok(Self {
            http,
            endpoint,
            policy,
        })
    }

    pub(crate) async fn search(
        &self,
        search: &DiscoveryBusinessSearchSpec,
        credential: &Zeroizing<String>,
        remaining_target: usize,
        cancellation: &CancellationToken,
    ) -> Result<BraveSearchOutcome, BraveError> {
        search.validate().map_err(|_| BraveError::InvalidRequest)?;
        let target = remaining_target.min(usize::from(search.limit));
        if target == 0 {
            return Ok(BraveSearchOutcome {
                observations: Vec::new(),
                request_count: 0,
            });
        }

        let query = search.provider_query();
        if query.chars().count() > 400 || query.split_whitespace().count() > 50 {
            return Err(BraveError::InvalidRequest);
        }
        let mut observations = Vec::new();
        let mut request_count = 0_u16;
        for offset in 0..=MAX_BRAVE_OFFSET {
            let remaining = target.saturating_sub(observations.len());
            if remaining == 0 {
                break;
            }
            let count = remaining.min(MAX_BRAVE_COUNT);
            let (envelope, page_requests) = self
                .request_page(search, &query, count, offset, credential, cancellation)
                .await?;
            request_count = request_count.saturating_add(page_requests);
            let more_results_available = envelope
                .query
                .is_some_and(|query| query.more_results_available);
            let candidates = envelope
                .web
                .map(|web| {
                    web.results
                        .into_iter()
                        .map(WebBusinessCandidate::from)
                        .collect()
                })
                .unwrap_or_default();
            let page = normalize_web_businesses(DiscoveryProvider::BraveSearch, candidates, search);
            let mut known = observations
                .iter()
                .map(|observation: &DiscoveryBusinessObservationInput| {
                    observation.provider_record_id.clone()
                })
                .collect::<std::collections::HashSet<_>>();
            observations.extend(
                page.into_iter()
                    .filter(|observation| known.insert(observation.provider_record_id.clone()))
                    .take(remaining),
            );
            if !more_results_available {
                break;
            }
        }
        Ok(BraveSearchOutcome {
            observations,
            request_count,
        })
    }

    async fn request_page(
        &self,
        search: &DiscoveryBusinessSearchSpec,
        query: &str,
        count: usize,
        offset: u8,
        credential: &Zeroizing<String>,
        cancellation: &CancellationToken,
    ) -> Result<(BraveEnvelope, u16), BraveError> {
        let count = count.clamp(1, MAX_BRAVE_COUNT).to_string();
        let offset = offset.min(MAX_BRAVE_OFFSET).to_string();
        let mut parameters = vec![
            ("q", query),
            ("count", count.as_str()),
            ("offset", offset.as_str()),
            ("search_lang", search.language.as_str()),
            ("safesearch", "moderate"),
            ("spellcheck", "true"),
            ("text_decorations", "false"),
            ("result_filter", "web"),
        ];
        if let Some(country) = &search.region {
            parameters.push(("country", country.as_str()));
        }

        let mut retries = 0_usize;
        let mut request_count = 0_u16;
        loop {
            if cancellation.is_cancelled() {
                return Err(BraveError::Cancelled);
            }
            request_count = request_count.saturating_add(1);
            let response = tokio::select! {
                () = cancellation.cancelled() => return Err(BraveError::Cancelled),
                result = self.http
                    .get(&self.endpoint)
                    .header("Accept", "application/json")
                    .header("X-Subscription-Token", credential.as_str())
                    .query(&parameters)
                    .send() => result.map_err(classify_transport_error)?,
            };
            match classify_status(response.status()) {
                StatusDisposition::Parse => {
                    let envelope = self.parse_response(response, cancellation).await?;
                    return Ok((envelope, request_count));
                }
                StatusDisposition::Retry(_) if retries < self.policy.max_retries => {
                    retries += 1;
                    self.wait_retry(retries, cancellation).await?;
                }
                StatusDisposition::Retry(error) | StatusDisposition::Terminal(error) => {
                    return Err(error);
                }
            }
        }
    }

    async fn parse_response(
        &self,
        response: Response,
        cancellation: &CancellationToken,
    ) -> Result<BraveEnvelope, BraveError> {
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = tokio::select! {
            () = cancellation.cancelled() => return Err(BraveError::Cancelled),
            result = stream.next() => result,
        } {
            let chunk = chunk.map_err(classify_transport_error)?;
            if body.len().saturating_add(chunk.len()) > self.policy.max_response_bytes {
                return Err(BraveError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| BraveError::MalformedResponse)
    }

    async fn wait_retry(
        &self,
        attempt: usize,
        cancellation: &CancellationToken,
    ) -> Result<(), BraveError> {
        let multiplier = u32::try_from(attempt).unwrap_or(u32::MAX);
        let duration = self
            .policy
            .retry_backoff
            .checked_mul(multiplier)
            .unwrap_or(self.policy.request_timeout);
        tokio::select! {
            () = cancellation.cancelled() => Err(BraveError::Cancelled),
            () = tokio::time::sleep(duration) => Ok(()),
        }
    }
}

enum StatusDisposition {
    Parse,
    Retry(BraveError),
    Terminal(BraveError),
}

fn classify_status(status: StatusCode) -> StatusDisposition {
    match status {
        StatusCode::OK => StatusDisposition::Parse,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            StatusDisposition::Terminal(BraveError::CredentialRejected)
        }
        StatusCode::PAYMENT_REQUIRED => StatusDisposition::Terminal(BraveError::BillingRequired),
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
            StatusDisposition::Terminal(BraveError::InvalidRequest)
        }
        StatusCode::TOO_MANY_REQUESTS => StatusDisposition::Retry(BraveError::RateLimited),
        StatusCode::INTERNAL_SERVER_ERROR
        | StatusCode::BAD_GATEWAY
        | StatusCode::SERVICE_UNAVAILABLE
        | StatusCode::GATEWAY_TIMEOUT => StatusDisposition::Retry(BraveError::ProviderUnavailable),
        _ => StatusDisposition::Terminal(BraveError::ProviderFailed),
    }
}

fn classify_transport_error(error: reqwest::Error) -> BraveError {
    if error.is_timeout() {
        BraveError::RequestTimedOut
    } else {
        BraveError::ProviderUnavailable
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };

    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::get,
        Router,
    };
    use serde_json::json;
    use tokio_util::sync::CancellationToken;
    use zeroize::Zeroizing;

    use super::*;

    #[derive(Clone, Copy)]
    enum Scenario {
        Paginated,
        AlwaysMore,
        NoMore,
        Status(StatusCode),
        Transient(StatusCode),
        Malformed,
        Oversized,
        Delayed,
    }

    struct TestState {
        scenario: Scenario,
        calls: Mutex<Vec<HashMap<String, String>>>,
        header_seen: AtomicBool,
        request_count: AtomicUsize,
    }

    async fn handler(
        State(state): State<Arc<TestState>>,
        headers: HeaderMap,
        uri: axum::http::Uri,
    ) -> impl IntoResponse {
        state.header_seen.store(
            headers
                .get("x-subscription-token")
                .and_then(|value| value.to_str().ok())
                == Some("test-key"),
            Ordering::SeqCst,
        );
        let parameters = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
            .into_owned()
            .collect::<HashMap<_, _>>();
        let offset = parameters
            .get("offset")
            .and_then(|value| value.parse::<u8>().ok())
            .unwrap_or_default();
        state.calls.lock().expect("calls").push(parameters);
        let request_index = state.request_count.fetch_add(1, Ordering::SeqCst);

        match state.scenario {
            Scenario::Paginated => {
                let (results, more) = if offset == 0 {
                    (
                        vec![
                            json!({
                                "title": "Acme Dental | Sandton Dentist",
                                "url": "HTTPS://WWW.Acme.Example:443/about/?utm_source=brave&b=2&a=1#team",
                                "description": "Public dental care in Sandton.",
                                "meta_url": {"favicon": "https://cdn.example/acme.png"},
                                "unknown": "must not cross"
                            }),
                            json!({
                                "title": "Acme on LinkedIn",
                                "url": "https://linkedin.com/company/acme"
                            }),
                        ],
                        true,
                    )
                } else {
                    (
                        vec![json!({
                            "title": "Beta Dental - Home",
                            "url": "https://beta.example/",
                            "description": "Beta public snippet"
                        })],
                        false,
                    )
                };
                (
                    StatusCode::OK,
                    json!({
                        "query": {"more_results_available": more},
                        "web": {"results": results}
                    })
                    .to_string(),
                )
                    .into_response()
            }
            Scenario::AlwaysMore => (
                StatusCode::OK,
                json!({
                    "query": {"more_results_available": true},
                    "web": {"results": [{
                        "title": format!("Business {offset}"),
                        "url": format!("https://business-{offset}.example")
                    }]}
                })
                .to_string(),
            )
                .into_response(),
            Scenario::NoMore => (
                StatusCode::OK,
                json!({
                    "query": {"more_results_available": false},
                    "web": {"results": [{
                        "title": "Only Business",
                        "url": "https://only.example"
                    }]}
                })
                .to_string(),
            )
                .into_response(),
            Scenario::Status(status) => {
                (status, "raw provider detail and test-key").into_response()
            }
            Scenario::Transient(status) if request_index == 0 => {
                (status, "temporary raw provider detail").into_response()
            }
            Scenario::Transient(_) => (
                StatusCode::OK,
                json!({
                    "query": {"more_results_available": false},
                    "web": {"results": [{
                        "title": "Recovered Business",
                        "url": "https://recovered.example"
                    }]}
                })
                .to_string(),
            )
                .into_response(),
            Scenario::Malformed => (StatusCode::OK, "not-json").into_response(),
            Scenario::Oversized => (StatusCode::OK, "x".repeat(1_024)).into_response(),
            Scenario::Delayed => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                (
                    StatusCode::OK,
                    json!({
                        "query": {"more_results_available": false},
                        "web": {"results": []}
                    })
                    .to_string(),
                )
                    .into_response()
            }
        }
    }

    async fn server(
        scenario: Scenario,
    ) -> (
        BraveSearchClient,
        Arc<TestState>,
        tokio::task::JoinHandle<()>,
    ) {
        let state = Arc::new(TestState {
            scenario,
            calls: Mutex::new(Vec::new()),
            header_seen: AtomicBool::new(false),
            request_count: AtomicUsize::new(0),
        });
        let router = Router::new()
            .route("/web/search", get(handler))
            .with_state(Arc::clone(&state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Brave test server");
        let address = listener.local_addr().expect("Brave test address");
        let handle = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve Brave test endpoint");
        });
        let policy = BravePolicy {
            request_timeout: Duration::from_millis(100),
            retry_backoff: Duration::from_millis(1),
            max_retries: 2,
            max_response_bytes: 512,
        };
        let client = BraveSearchClient::with_config(format!("http://{address}/web/search"), policy)
            .expect("Brave test client");
        (client, state, handle)
    }

    fn search(limit: u16) -> DiscoveryBusinessSearchSpec {
        DiscoveryBusinessSearchSpec {
            query: "dentist".to_owned(),
            location: "Sandton".to_owned(),
            limit,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        }
    }

    #[tokio::test]
    async fn paginates_by_remaining_target_with_fixed_query_shape_and_header() {
        let (client, state, handle) = server(Scenario::Paginated).await;
        let outcome = client
            .search(
                &search(2),
                &Zeroizing::new("test-key".to_owned()),
                2,
                &CancellationToken::new(),
            )
            .await
            .expect("Brave search");
        assert_eq!(outcome.observations.len(), 2);
        assert_eq!(outcome.request_count, 2);
        assert!(state.header_seen.load(Ordering::SeqCst));
        assert_eq!(
            outcome.observations[0].website.as_deref(),
            Some("https://acme.example/about?a=1&b=2")
        );
        assert_eq!(outcome.observations[0].name, "Acme Dental");
        assert_eq!(
            outcome.observations[0].image_url.as_deref(),
            Some("https://cdn.example/acme.png")
        );
        assert_eq!(outcome.observations[1].name, "Beta Dental");
        let serialized = serde_json::to_string(&outcome.observations).expect("observations");
        assert!(!serialized.contains("unknown"));
        assert!(!serialized.contains("linkedin.com"));

        let calls = state.calls.lock().expect("calls");
        assert_eq!(calls.len(), 2);
        for (index, call) in calls.iter().enumerate() {
            assert_eq!(call.len(), 9);
            assert_eq!(call.get("q").map(String::as_str), Some("dentist, Sandton"));
            assert_eq!(call.get("offset"), Some(&index.to_string()));
            assert_eq!(call.get("search_lang").map(String::as_str), Some("en"));
            assert_eq!(call.get("country").map(String::as_str), Some("ZA"));
            assert_eq!(call.get("safesearch").map(String::as_str), Some("moderate"));
            assert_eq!(call.get("spellcheck").map(String::as_str), Some("true"));
            assert_eq!(
                call.get("text_decorations").map(String::as_str),
                Some("false")
            );
            assert_eq!(call.get("result_filter").map(String::as_str), Some("web"));
        }
        assert_eq!(calls[0].get("count").map(String::as_str), Some("2"));
        assert_eq!(calls[1].get("count").map(String::as_str), Some("1"));
        handle.abort();
    }

    #[tokio::test]
    async fn offset_and_count_stay_inside_brave_bounds() {
        let (client, state, handle) = server(Scenario::AlwaysMore).await;
        let outcome = client
            .search(
                &search(500),
                &Zeroizing::new("test-key".to_owned()),
                500,
                &CancellationToken::new(),
            )
            .await
            .expect("bounded Brave search");
        assert_eq!(outcome.request_count, 10);
        let calls = state.calls.lock().expect("calls");
        assert_eq!(calls.len(), 10);
        assert_eq!(
            calls
                .iter()
                .map(|call| call.get("offset").cloned().expect("offset"))
                .collect::<Vec<_>>(),
            (0..=9).map(|offset| offset.to_string()).collect::<Vec<_>>()
        );
        assert!(calls.iter().all(|call| {
            call.get("count")
                .and_then(|count| count.parse::<u8>().ok())
                .is_some_and(|count| (1..=20).contains(&count))
        }));
        handle.abort();
    }

    #[tokio::test]
    async fn more_results_false_stops_paid_pagination() {
        let (client, state, handle) = server(Scenario::NoMore).await;
        let outcome = client
            .search(
                &search(50),
                &Zeroizing::new("test-key".to_owned()),
                50,
                &CancellationToken::new(),
            )
            .await
            .expect("single Brave page");
        assert_eq!(outcome.observations.len(), 1);
        assert_eq!(outcome.request_count, 1);
        assert_eq!(state.request_count.load(Ordering::SeqCst), 1);
        handle.abort();
    }

    #[tokio::test]
    async fn query_never_exceeds_brave_word_or_character_bounds() {
        let (client, state, handle) = server(Scenario::NoMore).await;
        let mut invalid = search(1);
        invalid.query = (0..51).map(|_| "x").collect::<Vec<_>>().join(" ");
        let error = client
            .search(
                &invalid,
                &Zeroizing::new("test-key".to_owned()),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect_err("overlong Brave query");
        assert_eq!(error, BraveError::InvalidRequest);
        assert_eq!(state.request_count.load(Ordering::SeqCst), 0);
        handle.abort();
    }

    #[tokio::test]
    async fn retries_only_bounded_transient_statuses() {
        for status in [StatusCode::TOO_MANY_REQUESTS, StatusCode::BAD_GATEWAY] {
            let (client, state, handle) = server(Scenario::Transient(status)).await;
            let outcome = client
                .search(
                    &search(1),
                    &Zeroizing::new("test-key".to_owned()),
                    1,
                    &CancellationToken::new(),
                )
                .await
                .expect("transient retry");
            assert_eq!(outcome.request_count, 2);
            assert_eq!(state.request_count.load(Ordering::SeqCst), 2);
            handle.abort();
        }
    }

    #[tokio::test]
    async fn terminal_errors_are_actionable_bounded_and_sanitized() {
        for (status, expected) in [
            (StatusCode::UNAUTHORIZED, BraveError::CredentialRejected),
            (StatusCode::FORBIDDEN, BraveError::CredentialRejected),
            (StatusCode::PAYMENT_REQUIRED, BraveError::BillingRequired),
            (StatusCode::BAD_REQUEST, BraveError::InvalidRequest),
            (StatusCode::UNPROCESSABLE_ENTITY, BraveError::InvalidRequest),
            (StatusCode::TOO_MANY_REQUESTS, BraveError::RateLimited),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                BraveError::ProviderUnavailable,
            ),
            (StatusCode::NOT_FOUND, BraveError::ProviderFailed),
        ] {
            let (client, state, handle) = server(Scenario::Status(status)).await;
            let error = client
                .search(
                    &search(1),
                    &Zeroizing::new("test-key".to_owned()),
                    1,
                    &CancellationToken::new(),
                )
                .await
                .expect_err("status must fail");
            assert_eq!(error, expected);
            let expected_calls =
                if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                    3
                } else {
                    1
                };
            assert_eq!(state.request_count.load(Ordering::SeqCst), expected_calls);
            let rendered = format!("{error:?} {error}");
            assert!(!rendered.contains("test-key"));
            assert!(!rendered.contains("provider detail"));
            assert!(!rendered.contains("dentist"));
            handle.abort();
        }
    }

    #[tokio::test]
    async fn response_and_transport_failures_are_bounded() {
        for (scenario, expected) in [
            (Scenario::Malformed, BraveError::MalformedResponse),
            (Scenario::Oversized, BraveError::ResponseTooLarge),
            (Scenario::Delayed, BraveError::RequestTimedOut),
        ] {
            let (client, _, handle) = server(scenario).await;
            let error = client
                .search(
                    &search(1),
                    &Zeroizing::new("test-key".to_owned()),
                    1,
                    &CancellationToken::new(),
                )
                .await
                .expect_err("bounded failure");
            assert_eq!(error, expected);
            handle.abort();
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_inflight_request() {
        let (client, state, handle) = server(Scenario::Delayed).await;
        let cancellation = CancellationToken::new();
        let cancellation_signal = cancellation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancellation_signal.cancel();
        });
        let error = client
            .search(
                &search(1),
                &Zeroizing::new("test-key".to_owned()),
                1,
                &cancellation,
            )
            .await
            .expect_err("cancelled request");
        assert_eq!(error, BraveError::Cancelled);
        assert_eq!(state.request_count.load(Ordering::SeqCst), 1);
        handle.abort();
    }
}
