use std::{fmt, future::Future, time::Duration};

use buzz_core_pkg::{
    discovery::DiscoveryBusinessSearchSpec,
    discovery_worker::{DiscoveryBusinessObservationInput, DiscoveryProvider},
};
use futures_util::StreamExt as _;
use reqwest::{header::HeaderMap, Response, StatusCode};
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

#[derive(Debug)]
pub(crate) struct BraveSearchFailure {
    pub(crate) error: BraveError,
    pub(crate) request_count: u16,
    pub(crate) local_error: Option<String>,
}

impl BraveSearchFailure {
    fn provider(error: BraveError, request_count: u16) -> Self {
        Self {
            error,
            request_count,
            local_error: None,
        }
    }

    fn local(error: String, request_count: u16) -> Self {
        Self {
            error: BraveError::ProviderFailed,
            request_count,
            local_error: Some(error),
        }
    }
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

struct BravePageRequest<'a> {
    search: &'a DiscoveryBusinessSearchSpec,
    query: &'a str,
    count: usize,
    offset: u8,
    credential: &'a Zeroizing<String>,
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

    #[cfg(test)]
    pub(super) fn for_local_test(endpoint: String) -> Result<Self, BraveError> {
        Self::with_config(
            endpoint,
            BravePolicy {
                request_timeout: Duration::from_secs(2),
                retry_backoff: Duration::from_millis(1),
                max_retries: 2,
                max_response_bytes: 512 * 1024,
            },
        )
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

    pub(crate) fn validate_search(search: &DiscoveryBusinessSearchSpec) -> Result<(), BraveError> {
        search.validate().map_err(|_| BraveError::InvalidRequest)?;
        let query = search.provider_query();
        if query.chars().count() > 400 || query.split_whitespace().count() > 50 {
            return Err(BraveError::InvalidRequest);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn search(
        &self,
        search: &DiscoveryBusinessSearchSpec,
        credential: &Zeroizing<String>,
        remaining_target: usize,
        cancellation: &CancellationToken,
    ) -> Result<BraveSearchOutcome, BraveError> {
        self.search_with_remaining(search, credential, || remaining_target, cancellation)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn search_with_remaining<F>(
        &self,
        search: &DiscoveryBusinessSearchSpec,
        credential: &Zeroizing<String>,
        remaining_target: F,
        cancellation: &CancellationToken,
    ) -> Result<BraveSearchOutcome, BraveError>
    where
        F: Fn() -> usize,
    {
        self.search_with_hooks(
            search,
            credential,
            remaining_target,
            || std::future::ready(true),
            |_, _| std::future::ready(Ok(())),
            cancellation,
        )
        .await
        .map_err(|failure| failure.error)
    }

    pub(crate) async fn search_with_hooks<F, P, PFut, R, RFut>(
        &self,
        search: &DiscoveryBusinessSearchSpec,
        credential: &Zeroizing<String>,
        remaining_target: F,
        mut before_request: P,
        mut page_ready: R,
        cancellation: &CancellationToken,
    ) -> Result<BraveSearchOutcome, BraveSearchFailure>
    where
        F: Fn() -> usize,
        P: FnMut() -> PFut,
        PFut: Future<Output = bool>,
        R: FnMut(Vec<DiscoveryBusinessObservationInput>, u16) -> RFut,
        RFut: Future<Output = Result<(), String>>,
    {
        Self::validate_search(search).map_err(|error| BraveSearchFailure::provider(error, 0))?;
        let source_limit = usize::from(search.limit);
        if remaining_target().min(source_limit) == 0 {
            return Ok(BraveSearchOutcome {
                observations: Vec::new(),
                request_count: 0,
            });
        }

        let query = search.provider_query();
        let mut observations = Vec::new();
        let mut request_count = 0_u16;
        let mut provider_budget = source_limit;
        for offset in 0..=MAX_BRAVE_OFFSET {
            let remaining = remaining_target().min(provider_budget);
            if remaining == 0 {
                break;
            }
            let count = remaining.min(MAX_BRAVE_COUNT);
            let (envelope, page_requests) = match self
                .request_page(
                    BravePageRequest {
                        search,
                        query: &query,
                        count,
                        offset,
                        credential,
                    },
                    &mut before_request,
                    cancellation,
                )
                .await
            {
                Ok(result) => result,
                Err(mut failure) => {
                    failure.request_count = failure.request_count.saturating_add(request_count);
                    return Err(failure);
                }
            };
            provider_budget = provider_budget.saturating_sub(count);
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
            let page = page
                .into_iter()
                .filter(|observation| known.insert(observation.provider_record_id.clone()))
                .take(remaining)
                .collect::<Vec<_>>();
            page_ready(page.clone(), request_count)
                .await
                .map_err(|error| BraveSearchFailure::local(error, request_count))?;
            observations.extend(page);
            if !more_results_available {
                break;
            }
        }
        Ok(BraveSearchOutcome {
            observations,
            request_count,
        })
    }

    async fn request_page<P, PFut>(
        &self,
        page: BravePageRequest<'_>,
        before_request: &mut P,
        cancellation: &CancellationToken,
    ) -> Result<(BraveEnvelope, u16), BraveSearchFailure>
    where
        P: FnMut() -> PFut,
        PFut: Future<Output = bool>,
    {
        let count = page.count.clamp(1, MAX_BRAVE_COUNT).to_string();
        let offset = page.offset.min(MAX_BRAVE_OFFSET).to_string();
        let mut parameters = vec![
            ("q", page.query),
            ("count", count.as_str()),
            ("offset", offset.as_str()),
            ("search_lang", page.search.language.as_str()),
            ("safesearch", "moderate"),
            ("spellcheck", "true"),
            ("text_decorations", "false"),
            ("result_filter", "web"),
        ];
        if let Some(country) = &page.search.region {
            parameters.push(("country", country.as_str()));
        }

        let mut retries = 0_usize;
        let mut request_count = 0_u16;
        loop {
            if cancellation.is_cancelled() {
                return Err(BraveSearchFailure::provider(
                    BraveError::Cancelled,
                    request_count,
                ));
            }
            if !before_request().await {
                return Err(BraveSearchFailure::provider(
                    BraveError::Cancelled,
                    request_count,
                ));
            }
            request_count = request_count.saturating_add(1);
            let response = tokio::select! {
                () = cancellation.cancelled() => return Err(BraveSearchFailure::provider(BraveError::Cancelled, request_count)),
                result = self.http
                    .get(&self.endpoint)
                    .header("Accept", "application/json")
                    .header("X-Subscription-Token", page.credential.as_str())
                    .query(&parameters)
                    .send() => result.map_err(|error| BraveSearchFailure::provider(classify_transport_error(error), request_count))?,
            };
            let retry_after = retry_after_delay(response.headers(), self.policy.request_timeout);
            match classify_status(response.status()) {
                StatusDisposition::Parse => {
                    let envelope = self
                        .parse_response(response, cancellation)
                        .await
                        .map_err(|error| BraveSearchFailure::provider(error, request_count))?;
                    return Ok((envelope, request_count));
                }
                StatusDisposition::Retry(_) if retries < self.policy.max_retries => {
                    retries += 1;
                    self.wait_retry(retries, retry_after, cancellation)
                        .await
                        .map_err(|error| BraveSearchFailure::provider(error, request_count))?;
                }
                StatusDisposition::Retry(error) | StatusDisposition::Terminal(error) => {
                    return Err(BraveSearchFailure::provider(error, request_count));
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
        retry_after: Option<Duration>,
        cancellation: &CancellationToken,
    ) -> Result<(), BraveError> {
        let exponent = u32::try_from(attempt.saturating_sub(1)).unwrap_or(u32::MAX);
        let multiplier = 2_u32.saturating_pow(exponent);
        let backoff = self
            .policy
            .retry_backoff
            .checked_mul(multiplier)
            .unwrap_or(self.policy.request_timeout)
            .min(self.policy.request_timeout);
        let duration = retry_after.unwrap_or_default().max(backoff);
        tokio::select! {
            () = cancellation.cancelled() => Err(BraveError::Cancelled),
            () = tokio::time::sleep(duration) => Ok(()),
        }
    }
}

fn retry_after_delay(headers: &HeaderMap, cap: Duration) -> Option<Duration> {
    let seconds = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()?;
    (seconds > 0).then(|| Duration::from_secs(seconds).min(cap))
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
#[path = "brave_tests.rs"]
mod tests;
