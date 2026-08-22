use std::{fmt, future::Future, time::Duration};

use buzz_core_pkg::{
    discovery::DiscoveryBusinessSearchSpec, discovery_worker::DiscoveryBusinessObservationInput,
};
use futures_util::StreamExt as _;
use reqwest::{Response, StatusCode};
use serde::Deserialize;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::normalization::normalize_places;

const SEARCH_ENDPOINT: &str = "https://api.outscraper.com/google-maps-search";
const REQUESTS_ENDPOINT: &str = "https://api.outscraper.com/requests";
const OUTSCRAPER_FIELDS: &str = "name,place_id,google_id,cid,phone,site,website,full_address,address,city,state,postal_code,country,country_code,latitude,longitude,rating,reviews,type,category,subtypes,business_status,verified,location_link,photo,logo";

#[derive(Clone)]
pub(super) struct OutscraperEndpoints {
    search: String,
    requests: String,
}

impl Default for OutscraperEndpoints {
    fn default() -> Self {
        Self {
            search: SEARCH_ENDPOINT.to_string(),
            requests: REQUESTS_ENDPOINT.to_string(),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct PollPolicy {
    request_timeout: Duration,
    poll_interval: Duration,
    total_timeout: Duration,
    retry_backoff: Duration,
    max_retries: usize,
    max_response_bytes: usize,
}

impl Default for PollPolicy {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(15),
            poll_interval: Duration::from_secs(2),
            total_timeout: Duration::from_secs(5 * 60),
            retry_backoff: Duration::from_millis(500),
            max_retries: 3,
            max_response_bytes: 8 * 1024 * 1024,
        }
    }
}

pub(super) struct OutscraperClient {
    http: reqwest::Client,
    endpoints: OutscraperEndpoints,
    poll: PollPolicy,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct OutscraperSubmission {
    pub(super) request_id: String,
    pub(super) ready: Option<Vec<DiscoveryBusinessObservationInput>>,
}

#[derive(Debug, PartialEq, Eq)]
#[cfg(test)]
pub(super) enum OutscraperPollOutcome {
    Pending,
    Ready(Vec<DiscoveryBusinessObservationInput>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OutscraperSubmitFailure {
    pub(super) error: OutscraperError,
    pub(super) ambiguous: bool,
}

impl OutscraperSubmitFailure {
    const fn rejected(error: OutscraperError) -> Self {
        Self {
            error,
            ambiguous: false,
        }
    }

    const fn ambiguous(error: OutscraperError) -> Self {
        Self {
            error,
            ambiguous: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OutscraperError {
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
    PollExhausted,
}

impl fmt::Display for OutscraperError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::CredentialRejected => "Outscraper rejected the saved API key",
            Self::BillingRequired => "the Outscraper account requires billing attention",
            Self::InvalidRequest => "Outscraper rejected the business search",
            Self::RateLimited => "Outscraper remained rate limited after bounded retries",
            Self::ProviderUnavailable => "Outscraper remained unavailable after bounded retries",
            Self::ProviderFailed => "Outscraper reported that the search failed",
            Self::MalformedResponse => "Outscraper returned an invalid response",
            Self::ResponseTooLarge => "Outscraper returned more data than Colony accepts",
            Self::RequestTimedOut => "the Outscraper request timed out",
            Self::Cancelled => "the Discovery source request was cancelled",
            Self::PollExhausted => "Outscraper did not finish within the bounded polling window",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for OutscraperError {}

#[derive(Deserialize)]
struct OutscraperEnvelope {
    id: Option<String>,
    status: Option<String>,
    data: Option<serde_json::Value>,
}

enum EnvelopeState {
    Pending(String),
    Ready(String, Vec<DiscoveryBusinessObservationInput>),
}

impl OutscraperClient {
    pub(super) fn production() -> Result<Self, OutscraperError> {
        Self::with_config(OutscraperEndpoints::default(), PollPolicy::default())
    }

    fn with_config(
        endpoints: OutscraperEndpoints,
        poll: PollPolicy,
    ) -> Result<Self, OutscraperError> {
        let http = reqwest::Client::builder()
            .connect_timeout(poll.request_timeout)
            .timeout(poll.request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| OutscraperError::ProviderUnavailable)?;
        Ok(Self {
            http,
            endpoints,
            poll,
        })
    }

    #[cfg(test)]
    pub(super) fn for_local_test(
        search_endpoint: String,
        requests_endpoint: String,
    ) -> Result<Self, OutscraperError> {
        Self::with_config(
            OutscraperEndpoints {
                search: search_endpoint,
                requests: requests_endpoint,
            },
            PollPolicy {
                request_timeout: Duration::from_secs(2),
                poll_interval: Duration::from_millis(25),
                total_timeout: Duration::from_secs(10),
                retry_backoff: Duration::from_millis(10),
                max_retries: 2,
                max_response_bytes: 1024 * 1024,
            },
        )
    }

    #[cfg(test)]
    pub(super) async fn submit(
        &self,
        search: &DiscoveryBusinessSearchSpec,
        credential: &Zeroizing<String>,
        cancellation: &CancellationToken,
    ) -> Result<OutscraperSubmission, OutscraperError> {
        self.submit_with_preflight(
            search,
            credential,
            || std::future::ready(true),
            cancellation,
        )
        .await
        .map_err(|failure| failure.error)
    }

    pub(super) async fn submit_with_preflight<P, PFut>(
        &self,
        search: &DiscoveryBusinessSearchSpec,
        credential: &Zeroizing<String>,
        mut before_request: P,
        cancellation: &CancellationToken,
    ) -> Result<OutscraperSubmission, OutscraperSubmitFailure>
    where
        P: FnMut() -> PFut,
        PFut: Future<Output = bool>,
    {
        search
            .validate()
            .map_err(|_| OutscraperSubmitFailure::rejected(OutscraperError::InvalidRequest))?;
        let provider_query = search.provider_query();
        let limit = search.limit.to_string();
        let mut query = vec![
            ("query", provider_query.as_str()),
            ("limit", limit.as_str()),
            ("language", search.language.as_str()),
            ("async", "true"),
            ("fields", OUTSCRAPER_FIELDS),
        ];
        if let Some(region) = &search.region {
            query.push(("region", region.as_str()));
        }

        let mut retries = 0;
        loop {
            if cancellation.is_cancelled() || !before_request().await {
                return Err(OutscraperSubmitFailure::rejected(
                    OutscraperError::Cancelled,
                ));
            }
            let response = tokio::select! {
                () = cancellation.cancelled() => return Err(OutscraperSubmitFailure::ambiguous(OutscraperError::Cancelled)),
                result = self.http
                    .post(&self.endpoints.search)
                    .header("X-API-KEY", credential.as_str())
                    .query(&query)
                    .send() => result.map_err(|error| OutscraperSubmitFailure::ambiguous(classify_transport_error(error)))?,
            };
            match classify_status(response.status()) {
                StatusDisposition::Parse => {
                    let envelope = self
                        .parse_response(response, cancellation)
                        .await
                        .map_err(OutscraperSubmitFailure::ambiguous)?;
                    return match interpret_envelope(envelope)
                        .map_err(OutscraperSubmitFailure::ambiguous)?
                    {
                        EnvelopeState::Pending(request_id) => Ok(OutscraperSubmission {
                            request_id,
                            ready: None,
                        }),
                        EnvelopeState::Ready(request_id, observations) => {
                            Ok(OutscraperSubmission {
                                request_id,
                                ready: Some(observations),
                            })
                        }
                    };
                }
                StatusDisposition::Retry(OutscraperError::RateLimited)
                    if retries < self.poll.max_retries =>
                {
                    retries += 1;
                    self.wait_retry(retries, cancellation)
                        .await
                        .map_err(OutscraperSubmitFailure::rejected)?;
                }
                StatusDisposition::Retry(error) | StatusDisposition::Terminal(error) => {
                    return Err(if error == OutscraperError::ProviderUnavailable {
                        OutscraperSubmitFailure::ambiguous(error)
                    } else {
                        OutscraperSubmitFailure::rejected(error)
                    });
                }
            }
        }
    }

    #[cfg(test)]
    pub(super) async fn poll_until_ready(
        &self,
        request_id: &str,
        credential: &Zeroizing<String>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<DiscoveryBusinessObservationInput>, OutscraperError> {
        self.poll_until_ready_with_preflight(
            request_id,
            credential,
            || std::future::ready(true),
            cancellation,
        )
        .await
    }

    pub(super) async fn poll_until_ready_with_preflight<P, PFut>(
        &self,
        request_id: &str,
        credential: &Zeroizing<String>,
        mut before_request: P,
        cancellation: &CancellationToken,
    ) -> Result<Vec<DiscoveryBusinessObservationInput>, OutscraperError>
    where
        P: FnMut() -> PFut,
        PFut: Future<Output = bool>,
    {
        validate_request_id(request_id)?;
        let request_url = format!(
            "{}/{request_id}",
            self.endpoints.requests.trim_end_matches('/')
        );
        let started = Instant::now();
        let mut retries = 0;

        loop {
            if started.elapsed() >= self.poll.total_timeout {
                return Err(OutscraperError::PollExhausted);
            }
            if cancellation.is_cancelled() || !before_request().await {
                return Err(OutscraperError::Cancelled);
            }
            let response = tokio::select! {
                () = cancellation.cancelled() => return Err(OutscraperError::Cancelled),
                result = self.http
                    .get(&request_url)
                    .header("X-API-KEY", credential.as_str())
                    .send() => result.map_err(classify_transport_error)?,
            };
            match classify_status(response.status()) {
                StatusDisposition::Parse => {
                    retries = 0;
                    let envelope = self.parse_response(response, cancellation).await?;
                    match interpret_envelope(envelope)? {
                        EnvelopeState::Pending(returned_id) => {
                            if returned_id != request_id {
                                return Err(OutscraperError::MalformedResponse);
                            }
                            self.wait_poll(cancellation).await?;
                        }
                        EnvelopeState::Ready(returned_id, observations) => {
                            if returned_id != request_id {
                                return Err(OutscraperError::MalformedResponse);
                            }
                            return Ok(observations);
                        }
                    }
                }
                StatusDisposition::Retry(_error) if retries < self.poll.max_retries => {
                    retries += 1;
                    self.wait_retry(retries, cancellation).await?;
                }
                StatusDisposition::Retry(error) | StatusDisposition::Terminal(error) => {
                    return Err(error);
                }
            }
        }
    }

    #[cfg(test)]
    pub(super) async fn poll_once_with_preflight<P, PFut>(
        &self,
        request_id: &str,
        credential: &Zeroizing<String>,
        before_request: P,
        cancellation: &CancellationToken,
    ) -> Result<OutscraperPollOutcome, OutscraperError>
    where
        P: FnOnce() -> PFut,
        PFut: Future<Output = bool>,
    {
        validate_request_id(request_id)?;
        if cancellation.is_cancelled() || !before_request().await {
            return Err(OutscraperError::Cancelled);
        }
        let request_url = format!(
            "{}/{request_id}",
            self.endpoints.requests.trim_end_matches('/')
        );
        let response = tokio::select! {
            () = cancellation.cancelled() => return Err(OutscraperError::Cancelled),
            result = self.http
                .get(&request_url)
                .header("X-API-KEY", credential.as_str())
                .send() => result.map_err(classify_transport_error)?,
        };
        match classify_status(response.status()) {
            StatusDisposition::Parse => {
                match interpret_envelope(self.parse_response(response, cancellation).await?)? {
                    EnvelopeState::Pending(returned_id) if returned_id == request_id => {
                        Ok(OutscraperPollOutcome::Pending)
                    }
                    EnvelopeState::Ready(returned_id, observations)
                        if returned_id == request_id =>
                    {
                        Ok(OutscraperPollOutcome::Ready(observations))
                    }
                    EnvelopeState::Pending(_) | EnvelopeState::Ready(_, _) => {
                        Err(OutscraperError::MalformedResponse)
                    }
                }
            }
            StatusDisposition::Retry(error) | StatusDisposition::Terminal(error) => Err(error),
        }
    }

    async fn parse_response(
        &self,
        response: Response,
        cancellation: &CancellationToken,
    ) -> Result<OutscraperEnvelope, OutscraperError> {
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = tokio::select! {
            () = cancellation.cancelled() => return Err(OutscraperError::Cancelled),
            result = stream.next() => result,
        } {
            let chunk = chunk.map_err(classify_transport_error)?;
            if body.len().saturating_add(chunk.len()) > self.poll.max_response_bytes {
                return Err(OutscraperError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| OutscraperError::MalformedResponse)
    }

    async fn wait_poll(&self, cancellation: &CancellationToken) -> Result<(), OutscraperError> {
        tokio::select! {
            () = cancellation.cancelled() => Err(OutscraperError::Cancelled),
            () = tokio::time::sleep(self.poll.poll_interval) => Ok(()),
        }
    }

    async fn wait_retry(
        &self,
        attempt: usize,
        cancellation: &CancellationToken,
    ) -> Result<(), OutscraperError> {
        let multiplier = u32::try_from(attempt).unwrap_or(u32::MAX);
        let duration = self
            .poll
            .retry_backoff
            .checked_mul(multiplier)
            .unwrap_or(self.poll.total_timeout);
        tokio::select! {
            () = cancellation.cancelled() => Err(OutscraperError::Cancelled),
            () = tokio::time::sleep(duration) => Ok(()),
        }
    }
}

fn interpret_envelope(envelope: OutscraperEnvelope) -> Result<EnvelopeState, OutscraperError> {
    let request_id = envelope
        .id
        .filter(|value| validate_request_id(value).is_ok())
        .ok_or(OutscraperError::MalformedResponse)?;
    match envelope
        .status
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("pending") => Ok(EnvelopeState::Pending(request_id)),
        Some("success") => {
            let values = extract_first_query(envelope.data)?;
            Ok(EnvelopeState::Ready(request_id, normalize_places(values)))
        }
        Some("failure" | "failed") => Err(OutscraperError::ProviderFailed),
        _ => Err(OutscraperError::MalformedResponse),
    }
}

fn extract_first_query(
    data: Option<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, OutscraperError> {
    let values = data
        .and_then(|value| value.as_array().cloned())
        .ok_or(OutscraperError::MalformedResponse)?;
    if let Some(first) = values.first() {
        if let Some(nested) = first.as_array() {
            return Ok(nested.clone());
        }
    }
    Ok(values)
}

fn validate_request_id(value: &str) -> Result<(), OutscraperError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(OutscraperError::MalformedResponse);
    }
    Ok(())
}

enum StatusDisposition {
    Parse,
    Retry(OutscraperError),
    Terminal(OutscraperError),
}

fn classify_status(status: StatusCode) -> StatusDisposition {
    match status {
        StatusCode::OK | StatusCode::ACCEPTED => StatusDisposition::Parse,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            StatusDisposition::Terminal(OutscraperError::CredentialRejected)
        }
        StatusCode::PAYMENT_REQUIRED => {
            StatusDisposition::Terminal(OutscraperError::BillingRequired)
        }
        StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => {
            StatusDisposition::Terminal(OutscraperError::InvalidRequest)
        }
        StatusCode::TOO_MANY_REQUESTS => StatusDisposition::Retry(OutscraperError::RateLimited),
        status if status.is_server_error() => {
            StatusDisposition::Retry(OutscraperError::ProviderUnavailable)
        }
        _ => StatusDisposition::Terminal(OutscraperError::ProviderFailed),
    }
}

fn classify_transport_error(error: reqwest::Error) -> OutscraperError {
    if error.is_timeout() {
        OutscraperError::RequestTimedOut
    } else {
        OutscraperError::ProviderUnavailable
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use axum::{
        extract::{Path, State},
        http::{HeaderMap, StatusCode as AxumStatus},
        response::IntoResponse,
        routing::{get, post},
        Router,
    };
    use serde_json::json;

    use super::*;

    #[derive(Clone, Copy)]
    enum Scenario {
        AsyncSuccess,
        ImmediateSuccess,
        Failure,
        Status(AxumStatus),
        TransientStatus(AxumStatus),
        Malformed,
        Oversized,
        Delayed,
        AlwaysPending,
    }

    struct TestState {
        scenario: Scenario,
        poll_count: AtomicUsize,
        submit_count: AtomicUsize,
        paths: Mutex<Vec<String>>,
    }

    async fn submit_handler(
        State(state): State<Arc<TestState>>,
        headers: HeaderMap,
        uri: axum::http::Uri,
    ) -> impl IntoResponse {
        let submit_count = state.submit_count.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok()),
            Some("test-key")
        );
        let query = uri.query().unwrap_or_default();
        let parameters = url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect::<HashMap<_, _>>();
        assert_eq!(parameters.len(), 6);
        assert_eq!(
            parameters.get("query").map(String::as_str),
            Some("dentist, Sandton")
        );
        assert_eq!(parameters.get("limit").map(String::as_str), Some("3"));
        assert_eq!(parameters.get("language").map(String::as_str), Some("en"));
        assert_eq!(parameters.get("region").map(String::as_str), Some("ZA"));
        assert_eq!(parameters.get("async").map(String::as_str), Some("true"));
        assert_eq!(
            parameters.get("fields").map(String::as_str),
            Some(OUTSCRAPER_FIELDS)
        );
        assert!(!parameters.contains_key("enrichment"));
        state.paths.lock().expect("paths").push(uri.to_string());
        if matches!(state.scenario, Scenario::Delayed) {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        match state.scenario {
            Scenario::ImmediateSuccess => (AxumStatus::OK, success_body("job-1")).into_response(),
            Scenario::Failure => (AxumStatus::ACCEPTED, failure_body()).into_response(),
            Scenario::Status(status) => (status, "provider detail must not escape").into_response(),
            Scenario::TransientStatus(status) if submit_count == 0 => {
                (status, "temporary provider detail must not escape").into_response()
            }
            Scenario::TransientStatus(_) => (AxumStatus::OK, success_body("job-1")).into_response(),
            Scenario::Malformed => (AxumStatus::OK, "not-json").into_response(),
            Scenario::Oversized => (AxumStatus::OK, "x".repeat(1024)).into_response(),
            Scenario::Delayed => (AxumStatus::OK, success_body("job-1")).into_response(),
            Scenario::AsyncSuccess | Scenario::AlwaysPending => (
                AxumStatus::ACCEPTED,
                json!({
                    "id": "job-1",
                    "status": "Pending",
                    "results_location": "http://127.0.0.1:9/secret"
                })
                .to_string(),
            )
                .into_response(),
        }
    }

    async fn poll_handler(
        State(state): State<Arc<TestState>>,
        Path(request_id): Path<String>,
        headers: HeaderMap,
        uri: axum::http::Uri,
    ) -> impl IntoResponse {
        assert_eq!(request_id, "job-1");
        assert_eq!(
            headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok()),
            Some("test-key")
        );
        state.paths.lock().expect("paths").push(uri.to_string());
        let count = state.poll_count.fetch_add(1, Ordering::SeqCst);
        match state.scenario {
            Scenario::AsyncSuccess if count == 0 => (
                AxumStatus::OK,
                json!({"id": "job-1", "status": "Pending"}).to_string(),
            )
                .into_response(),
            Scenario::AsyncSuccess => (AxumStatus::OK, success_body("job-1")).into_response(),
            Scenario::AlwaysPending => (
                AxumStatus::OK,
                json!({"id": "job-1", "status": "Pending"}).to_string(),
            )
                .into_response(),
            _ => (AxumStatus::INTERNAL_SERVER_ERROR, "unexpected poll").into_response(),
        }
    }

    fn success_body(id: &str) -> String {
        json!({
            "id": id,
            "status": "Success",
            "results_location": "http://127.0.0.1:9/must-not-follow",
            "data": [[{
                "name": "Sandton Dental Studio",
                "place_id": "ChIJ_test",
                "site": "https://dentist.example",
                "rating": 4.8,
                "unknown_provider_field": "discard me",
                "email_1": "discard@example.test"
            }]]
        })
        .to_string()
    }

    fn failure_body() -> String {
        json!({"id": "job-1", "status": "Failure", "error": "secret provider detail"}).to_string()
    }

    async fn server(
        scenario: Scenario,
    ) -> (
        OutscraperClient,
        Arc<TestState>,
        tokio::task::JoinHandle<()>,
    ) {
        let state = Arc::new(TestState {
            scenario,
            poll_count: AtomicUsize::new(0),
            submit_count: AtomicUsize::new(0),
            paths: Mutex::new(Vec::new()),
        });
        let router = Router::new()
            .route("/google-maps-search", post(submit_handler))
            .route("/requests/{id}", get(poll_handler))
            .with_state(Arc::clone(&state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("test server");
        });
        let policy = PollPolicy {
            request_timeout: Duration::from_millis(150),
            poll_interval: Duration::from_millis(5),
            total_timeout: Duration::from_millis(350),
            retry_backoff: Duration::from_millis(1),
            max_retries: 1,
            max_response_bytes: 512,
        };
        let endpoints = OutscraperEndpoints {
            search: format!("http://{address}/google-maps-search"),
            requests: format!("http://{address}/requests"),
        };
        (
            OutscraperClient::with_config(endpoints, policy).expect("test client"),
            state,
            handle,
        )
    }

    fn search() -> DiscoveryBusinessSearchSpec {
        DiscoveryBusinessSearchSpec {
            query: "dentist".to_string(),
            location: "Sandton".to_string(),
            limit: 3,
            language: "en".to_string(),
            region: Some("ZA".to_string()),
        }
    }

    #[tokio::test]
    async fn async_search_polls_fixed_local_request_url_and_normalizes_allowlist() {
        let (client, state, handle) = server(Scenario::AsyncSuccess).await;
        let credential = Zeroizing::new("test-key".to_string());
        let cancellation = CancellationToken::new();
        let submission = client
            .submit(&search(), &credential, &cancellation)
            .await
            .expect("submit");
        assert_eq!(submission.request_id, "job-1");
        assert!(submission.ready.is_none());
        let observations = client
            .poll_until_ready(&submission.request_id, &credential, &cancellation)
            .await
            .expect("poll");
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].name, "Sandton Dental Studio");
        assert_eq!(
            observations[0].website.as_deref(),
            Some("https://dentist.example")
        );
        let serialized = serde_json::to_string(&observations).expect("serialize observations");
        assert!(!serialized.contains("email_1"));
        assert!(!serialized.contains("unknown_provider_field"));
        let paths = state.paths.lock().expect("paths");
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.as_str() == "/requests/job-1")
                .count(),
            2
        );
        assert!(paths.iter().all(|path| !path.contains("127.0.0.1:9")));
        handle.abort();
    }

    #[tokio::test]
    async fn immediate_success_needs_no_poll() {
        let (client, state, handle) = server(Scenario::ImmediateSuccess).await;
        let result = client
            .submit(
                &search(),
                &Zeroizing::new("test-key".to_string()),
                &CancellationToken::new(),
            )
            .await
            .expect("immediate success");
        assert_eq!(result.ready.expect("ready").len(), 1);
        assert_eq!(state.poll_count.load(Ordering::SeqCst), 0);
        handle.abort();
    }

    #[tokio::test]
    async fn terminal_statuses_are_sanitized_and_actionable() {
        for (scenario, expected) in [
            (Scenario::Failure, OutscraperError::ProviderFailed),
            (
                Scenario::Status(AxumStatus::UNAUTHORIZED),
                OutscraperError::CredentialRejected,
            ),
            (
                Scenario::Status(AxumStatus::PAYMENT_REQUIRED),
                OutscraperError::BillingRequired,
            ),
            (
                Scenario::Status(AxumStatus::UNPROCESSABLE_ENTITY),
                OutscraperError::InvalidRequest,
            ),
            (
                Scenario::Status(AxumStatus::TOO_MANY_REQUESTS),
                OutscraperError::RateLimited,
            ),
            (
                Scenario::Status(AxumStatus::INTERNAL_SERVER_ERROR),
                OutscraperError::ProviderUnavailable,
            ),
            (Scenario::Malformed, OutscraperError::MalformedResponse),
            (Scenario::Oversized, OutscraperError::ResponseTooLarge),
            (Scenario::Delayed, OutscraperError::RequestTimedOut),
        ] {
            let (client, _, handle) = server(scenario).await;
            let error = client
                .submit(
                    &search(),
                    &Zeroizing::new("test-key".to_string()),
                    &CancellationToken::new(),
                )
                .await
                .expect_err("scenario must fail");
            assert_eq!(error, expected);
            let rendered = format!("{error:?} {error}");
            assert!(!rendered.contains("test-key"));
            assert!(!rendered.contains("secret provider detail"));
            assert!(!rendered.contains("dentist"));
            handle.abort();
        }
    }

    #[tokio::test]
    async fn submit_retries_rate_limit_but_not_ambiguous_server_failure() {
        let (client, state, handle) =
            server(Scenario::TransientStatus(AxumStatus::TOO_MANY_REQUESTS)).await;
        let preflights = AtomicUsize::new(0);
        let result = client
            .submit_with_preflight(
                &search(),
                &Zeroizing::new("test-key".to_string()),
                || {
                    preflights.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(true)
                },
                &CancellationToken::new(),
            )
            .await
            .expect("rate-limited submit must recover");
        assert_eq!(result.ready.expect("ready after retry").len(), 1);
        assert_eq!(state.submit_count.load(Ordering::SeqCst), 2);
        assert_eq!(preflights.load(Ordering::SeqCst), 2);
        handle.abort();

        let (client, state, handle) =
            server(Scenario::TransientStatus(AxumStatus::INTERNAL_SERVER_ERROR)).await;
        let error = client
            .submit(
                &search(),
                &Zeroizing::new("test-key".to_string()),
                &CancellationToken::new(),
            )
            .await
            .expect_err("ambiguous server failure must not repeat a paid submit");
        assert_eq!(error, OutscraperError::ProviderUnavailable);
        assert_eq!(state.submit_count.load(Ordering::SeqCst), 1);
        handle.abort();
    }

    #[tokio::test]
    async fn poll_preflights_every_provider_request() {
        let (client, state, handle) = server(Scenario::AsyncSuccess).await;
        let preflights = AtomicUsize::new(0);
        let observations = client
            .poll_until_ready_with_preflight(
                "job-1",
                &Zeroizing::new("test-key".to_string()),
                || {
                    preflights.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(true)
                },
                &CancellationToken::new(),
            )
            .await
            .expect("poll with lease preflight");
        assert_eq!(observations.len(), 1);
        assert_eq!(state.poll_count.load(Ordering::SeqCst), 2);
        assert_eq!(preflights.load(Ordering::SeqCst), 2);
        handle.abort();
    }

    #[tokio::test]
    async fn polling_is_bounded_and_cancellable() {
        let (client, _, handle) = server(Scenario::AlwaysPending).await;
        let credential = Zeroizing::new("test-key".to_string());
        let error = client
            .poll_until_ready("job-1", &credential, &CancellationToken::new())
            .await
            .expect_err("polling must exhaust");
        assert_eq!(error, OutscraperError::PollExhausted);

        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let error = client
            .poll_until_ready("job-1", &credential, &cancellation)
            .await
            .expect_err("cancelled poll");
        assert_eq!(error, OutscraperError::Cancelled);
        handle.abort();
    }

    #[test]
    fn request_ids_cannot_redirect_or_escape_the_fixed_endpoint() {
        for invalid in [
            "",
            "../secret",
            "job/secret",
            "job?redirect=1",
            "job#fragment",
            "job.with-dot",
            "job:with-colon",
        ] {
            assert_eq!(
                validate_request_id(invalid),
                Err(OutscraperError::MalformedResponse)
            );
        }
    }
}
