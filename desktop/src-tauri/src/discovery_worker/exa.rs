use std::{fmt, time::Duration};

use buzz_core_pkg::{
    discovery::DiscoveryBusinessSearchSpec,
    discovery_worker::{DiscoveryBusinessObservationInput, DiscoveryProvider},
};
use futures_util::StreamExt as _;
use reqwest::{Response, StatusCode};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::normalization::{normalize_web_businesses, WebBusinessCandidate};

const EXA_SEARCH_ENDPOINT: &str = "https://api.exa.ai/search";
const MAX_EXA_RESULTS: usize = 100;

#[derive(Clone, Copy)]
struct ExaPolicy {
    request_timeout: Duration,
    retry_backoff: Duration,
    max_retries: usize,
    max_response_bytes: usize,
}

impl Default for ExaPolicy {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(20),
            retry_backoff: Duration::from_millis(500),
            max_retries: 2,
            max_response_bytes: 2 * 1024 * 1024,
        }
    }
}

pub(crate) struct ExaSearchClient {
    http: reqwest::Client,
    endpoint: String,
    policy: ExaPolicy,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ExaSearchOutcome {
    pub(crate) observations: Vec<DiscoveryBusinessObservationInput>,
    pub(crate) request_id: Option<String>,
    pub(crate) request_count: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExaError {
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

impl fmt::Display for ExaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::CredentialRejected => "Exa Search rejected the saved API key",
            Self::BillingRequired => "the Exa Search account requires billing attention",
            Self::InvalidRequest => "Exa Search rejected the business search",
            Self::RateLimited => "Exa Search remained rate limited after bounded retries",
            Self::ProviderUnavailable => "Exa Search remained unavailable after bounded retries",
            Self::ProviderFailed => "Exa Search could not complete the business search",
            Self::MalformedResponse => "Exa Search returned an invalid response",
            Self::ResponseTooLarge => "Exa Search returned more data than Colony accepts",
            Self::RequestTimedOut => "the Exa Search request timed out",
            Self::Cancelled => "the Discovery source request was cancelled",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ExaError {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExaRequest<'a> {
    query: &'a str,
    num_results: usize,
    #[serde(rename = "type")]
    search_type: &'static str,
    category: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_location: Option<&'a str>,
}

#[derive(Deserialize)]
struct ExaEnvelope {
    #[serde(rename = "requestId")]
    request_id: String,
    results: Vec<ExaResult>,
}

#[derive(Deserialize)]
struct ExaResult {
    title: Option<String>,
    url: Option<String>,
    image: Option<String>,
    favicon: Option<String>,
}

impl From<ExaResult> for WebBusinessCandidate {
    fn from(result: ExaResult) -> Self {
        Self {
            title: result.title,
            url: result.url,
            description: None,
            image_url: result.image.or(result.favicon),
            profile_name: None,
        }
    }
}

impl ExaSearchClient {
    pub(crate) fn production() -> Result<Self, ExaError> {
        Self::with_config(EXA_SEARCH_ENDPOINT.to_owned(), ExaPolicy::default())
    }

    fn with_config(endpoint: String, policy: ExaPolicy) -> Result<Self, ExaError> {
        let http = reqwest::Client::builder()
            .connect_timeout(policy.request_timeout)
            .timeout(policy.request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ExaError::ProviderUnavailable)?;
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
    ) -> Result<ExaSearchOutcome, ExaError> {
        search.validate().map_err(|_| ExaError::InvalidRequest)?;
        let num_results = remaining_target
            .min(usize::from(search.limit))
            .min(MAX_EXA_RESULTS);
        if num_results == 0 {
            return Ok(ExaSearchOutcome {
                observations: Vec::new(),
                request_id: None,
                request_count: 0,
            });
        }

        let query = search.provider_query();
        let request = ExaRequest {
            query: &query,
            num_results,
            search_type: "auto",
            category: "company",
            user_location: search.region.as_deref(),
        };
        let (envelope, request_count) = self.request(&request, credential, cancellation).await?;
        validate_request_id(&envelope.request_id)?;
        let observations = normalize_web_businesses(
            DiscoveryProvider::ExaSearch,
            envelope
                .results
                .into_iter()
                .map(WebBusinessCandidate::from)
                .collect(),
            search,
        )
        .into_iter()
        .take(num_results)
        .collect();
        Ok(ExaSearchOutcome {
            observations,
            request_id: Some(envelope.request_id),
            request_count,
        })
    }

    async fn request(
        &self,
        request: &ExaRequest<'_>,
        credential: &Zeroizing<String>,
        cancellation: &CancellationToken,
    ) -> Result<(ExaEnvelope, u16), ExaError> {
        let mut retries = 0_usize;
        let mut request_count = 0_u16;
        loop {
            if cancellation.is_cancelled() {
                return Err(ExaError::Cancelled);
            }
            request_count = request_count.saturating_add(1);
            let response = tokio::select! {
                () = cancellation.cancelled() => return Err(ExaError::Cancelled),
                result = self.http
                    .post(&self.endpoint)
                    .header("Accept", "application/json")
                    .header("x-api-key", credential.as_str())
                    .json(request)
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
    ) -> Result<ExaEnvelope, ExaError> {
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = tokio::select! {
            () = cancellation.cancelled() => return Err(ExaError::Cancelled),
            result = stream.next() => result,
        } {
            let chunk = chunk.map_err(classify_transport_error)?;
            if body.len().saturating_add(chunk.len()) > self.policy.max_response_bytes {
                return Err(ExaError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| ExaError::MalformedResponse)
    }

    async fn wait_retry(
        &self,
        attempt: usize,
        cancellation: &CancellationToken,
    ) -> Result<(), ExaError> {
        let multiplier = u32::try_from(attempt).unwrap_or(u32::MAX);
        let duration = self
            .policy
            .retry_backoff
            .checked_mul(multiplier)
            .unwrap_or(self.policy.request_timeout);
        tokio::select! {
            () = cancellation.cancelled() => Err(ExaError::Cancelled),
            () = tokio::time::sleep(duration) => Ok(()),
        }
    }
}

fn validate_request_id(value: &str) -> Result<(), ExaError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ExaError::MalformedResponse);
    }
    Ok(())
}

enum StatusDisposition {
    Parse,
    Retry(ExaError),
    Terminal(ExaError),
}

fn classify_status(status: StatusCode) -> StatusDisposition {
    match status {
        StatusCode::OK => StatusDisposition::Parse,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            StatusDisposition::Terminal(ExaError::CredentialRejected)
        }
        StatusCode::PAYMENT_REQUIRED => StatusDisposition::Terminal(ExaError::BillingRequired),
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
            StatusDisposition::Terminal(ExaError::InvalidRequest)
        }
        StatusCode::TOO_MANY_REQUESTS => StatusDisposition::Retry(ExaError::RateLimited),
        StatusCode::INTERNAL_SERVER_ERROR
        | StatusCode::BAD_GATEWAY
        | StatusCode::SERVICE_UNAVAILABLE
        | StatusCode::GATEWAY_TIMEOUT => StatusDisposition::Retry(ExaError::ProviderUnavailable),
        _ => StatusDisposition::Terminal(ExaError::ProviderFailed),
    }
}

fn classify_transport_error(error: reqwest::Error) -> ExaError {
    if error.is_timeout() {
        ExaError::RequestTimedOut
    } else {
        ExaError::ProviderUnavailable
    }
}

#[cfg(test)]
mod tests {
    use std::{
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
        routing::post,
        Json, Router,
    };
    use serde_json::{json, Value};
    use tokio_util::sync::CancellationToken;
    use zeroize::Zeroizing;

    use super::*;

    #[derive(Clone, Copy)]
    enum Scenario {
        Success,
        Status(StatusCode),
        Transient(StatusCode),
        InvalidRequestId,
        Malformed,
        Oversized,
        Delayed,
    }

    struct TestState {
        scenario: Scenario,
        bodies: Mutex<Vec<Value>>,
        header_seen: AtomicBool,
        request_count: AtomicUsize,
    }

    async fn handler(
        State(state): State<Arc<TestState>>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> impl IntoResponse {
        state.header_seen.store(
            headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
                == Some("test-key"),
            Ordering::SeqCst,
        );
        state.bodies.lock().expect("bodies").push(body);
        let request_index = state.request_count.fetch_add(1, Ordering::SeqCst);
        match state.scenario {
            Scenario::Success => (
                StatusCode::OK,
                json!({
                    "requestId": "exa-request-1",
                    "results": [
                        {
                            "id": "provider-result-1",
                            "title": "Acme Dental | Official Site",
                            "url": "https://www.acme.example/?utm_source=exa",
                            "image": "https://cdn.example/acme.png",
                            "text": "must not be retained because contents were not requested",
                            "summary": "must not be retained",
                            "unknown": "must not cross"
                        },
                        {
                            "title": "Acme LinkedIn",
                            "url": "https://linkedin.com/company/acme"
                        }
                    ],
                    "costDollars": {"total": 0.01}
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
                    "requestId": "exa-request-recovered",
                    "results": [{
                        "title": "Recovered Company",
                        "url": "https://recovered.example"
                    }]
                })
                .to_string(),
            )
                .into_response(),
            Scenario::InvalidRequestId => (
                StatusCode::OK,
                json!({"requestId": "../unsafe", "results": []}).to_string(),
            )
                .into_response(),
            Scenario::Malformed => (StatusCode::OK, "not-json").into_response(),
            Scenario::Oversized => (StatusCode::OK, "x".repeat(2_048)).into_response(),
            Scenario::Delayed => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                (
                    StatusCode::OK,
                    json!({"requestId": "exa-request-delayed", "results": []}).to_string(),
                )
                    .into_response()
            }
        }
    }

    async fn server(
        scenario: Scenario,
    ) -> (ExaSearchClient, Arc<TestState>, tokio::task::JoinHandle<()>) {
        let state = Arc::new(TestState {
            scenario,
            bodies: Mutex::new(Vec::new()),
            header_seen: AtomicBool::new(false),
            request_count: AtomicUsize::new(0),
        });
        let router = Router::new()
            .route("/search", post(handler))
            .with_state(Arc::clone(&state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Exa test server");
        let address = listener.local_addr().expect("Exa test address");
        let handle = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve Exa test endpoint");
        });
        let client = ExaSearchClient::with_config(
            format!("http://{address}/search"),
            ExaPolicy {
                request_timeout: Duration::from_millis(100),
                retry_backoff: Duration::from_millis(1),
                max_retries: 2,
                max_response_bytes: 1_024,
            },
        )
        .expect("Exa test client");
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
    async fn sends_one_bounded_company_search_without_paid_content_options() {
        let (client, state, handle) = server(Scenario::Success).await;
        let outcome = client
            .search(
                &search(2),
                &Zeroizing::new("test-key".to_owned()),
                2,
                &CancellationToken::new(),
            )
            .await
            .expect("Exa company search");
        assert_eq!(outcome.request_id.as_deref(), Some("exa-request-1"));
        assert_eq!(outcome.request_count, 1);
        assert_eq!(outcome.observations.len(), 1);
        assert_eq!(outcome.observations[0].name, "Acme Dental");
        assert_eq!(
            outcome.observations[0].website.as_deref(),
            Some("https://acme.example")
        );
        assert_eq!(
            outcome.observations[0].image_url.as_deref(),
            Some("https://cdn.example/acme.png")
        );
        assert!(state.header_seen.load(Ordering::SeqCst));
        assert_eq!(state.request_count.load(Ordering::SeqCst), 1);

        let bodies = state.bodies.lock().expect("bodies");
        assert_eq!(bodies.len(), 1);
        let body = bodies[0].as_object().expect("request object");
        assert_eq!(body.len(), 5);
        assert_eq!(body.get("query"), Some(&json!("dentist, Sandton")));
        assert_eq!(body.get("numResults"), Some(&json!(2)));
        assert_eq!(body.get("type"), Some(&json!("auto")));
        assert_eq!(body.get("category"), Some(&json!("company")));
        assert_eq!(body.get("userLocation"), Some(&json!("ZA")));
        for forbidden in [
            "excludeDomains",
            "includeDomains",
            "contents",
            "summary",
            "additionalQueries",
            "outputSchema",
            "systemPrompt",
        ] {
            assert!(!body.contains_key(forbidden));
        }
        let serialized = serde_json::to_string(&outcome.observations).expect("observations");
        assert!(!serialized.contains("must not be retained"));
        assert!(!serialized.contains("costDollars"));
        assert!(!serialized.contains("linkedin.com"));
        handle.abort();
    }

    #[tokio::test]
    async fn num_results_is_minimum_of_remaining_target_and_one_hundred() {
        for (remaining, expected) in [(7, 7), (500, 100)] {
            let (client, state, handle) = server(Scenario::Success).await;
            client
                .search(
                    &search(500),
                    &Zeroizing::new("test-key".to_owned()),
                    remaining,
                    &CancellationToken::new(),
                )
                .await
                .expect("bounded Exa search");
            let bodies = state.bodies.lock().expect("bodies");
            assert_eq!(bodies[0].get("numResults"), Some(&json!(expected)));
            assert_eq!(state.request_count.load(Ordering::SeqCst), 1);
            handle.abort();
        }
    }

    #[tokio::test]
    async fn zero_remaining_target_makes_no_provider_request() {
        let (client, state, handle) = server(Scenario::Success).await;
        let outcome = client
            .search(
                &search(1),
                &Zeroizing::new("test-key".to_owned()),
                0,
                &CancellationToken::new(),
            )
            .await
            .expect("empty Exa search");
        assert_eq!(outcome.request_id, None);
        assert_eq!(outcome.request_count, 0);
        assert!(outcome.observations.is_empty());
        assert_eq!(state.request_count.load(Ordering::SeqCst), 0);
        handle.abort();
    }

    #[tokio::test]
    async fn retries_only_bounded_rate_limit_and_temporary_server_failures() {
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
                .expect("transient Exa retry");
            assert_eq!(outcome.request_count, 2);
            assert_eq!(state.request_count.load(Ordering::SeqCst), 2);
            handle.abort();
        }
    }

    #[tokio::test]
    async fn status_errors_are_actionable_bounded_and_sanitized() {
        for (status, expected, expected_calls) in [
            (StatusCode::UNAUTHORIZED, ExaError::CredentialRejected, 1),
            (StatusCode::FORBIDDEN, ExaError::CredentialRejected, 1),
            (StatusCode::PAYMENT_REQUIRED, ExaError::BillingRequired, 1),
            (StatusCode::BAD_REQUEST, ExaError::InvalidRequest, 1),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                ExaError::InvalidRequest,
                1,
            ),
            (StatusCode::TOO_MANY_REQUESTS, ExaError::RateLimited, 3),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ExaError::ProviderUnavailable,
                3,
            ),
            (StatusCode::NOT_FOUND, ExaError::ProviderFailed, 1),
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
            assert_eq!(state.request_count.load(Ordering::SeqCst), expected_calls);
            let rendered = format!("{error:?} {error}");
            assert!(!rendered.contains("test-key"));
            assert!(!rendered.contains("provider detail"));
            assert!(!rendered.contains("dentist"));
            handle.abort();
        }
    }

    #[tokio::test]
    async fn malformed_response_request_id_and_size_are_rejected() {
        for (scenario, expected) in [
            (Scenario::InvalidRequestId, ExaError::MalformedResponse),
            (Scenario::Malformed, ExaError::MalformedResponse),
            (Scenario::Oversized, ExaError::ResponseTooLarge),
            (Scenario::Delayed, ExaError::RequestTimedOut),
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
                .expect_err("bounded Exa failure");
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
            .expect_err("cancelled Exa request");
        assert_eq!(error, ExaError::Cancelled);
        assert_eq!(state.request_count.load(Ordering::SeqCst), 1);
        handle.abort();
    }

    #[test]
    fn production_endpoint_is_fixed() {
        assert_eq!(EXA_SEARCH_ENDPOINT, "https://api.exa.ai/search");
    }
}
