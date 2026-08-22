//! Bounded Colony-hosted provider transport for paid Discovery runs.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use buzz_core::discovery::DiscoveryBusinessSearchSpec;
use buzz_core::discovery_worker::{
    deterministic_business_observation_id, DiscoveryBusinessObservationInput,
    DiscoveryBusinessStatus, DiscoveryProvider,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

const DEFAULT_SEARCH_URL: &str = "https://api.outscraper.com/google-maps-search";
const DEFAULT_REQUESTS_URL: &str = "https://api.outscraper.com/requests";
const DEFAULT_BRAVE_URL: &str = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_EXA_URL: &str = "https://api.exa.ai/search";
const OUTSCRAPER_FIELDS: &str = "name,place_id,google_id,cid,phone,site,website,full_address,address,city,state,postal_code,country,country_code,latitude,longitude,rating,reviews,type,category,subtypes,business_status,verified,location_link,photo,logo";
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Server-only provider configuration.
#[derive(Clone)]
pub struct DiscoveryGatewayConfig {
    outscraper_api_key: String,
    brave_api_key: String,
    exa_api_key: String,
    search_url: String,
    requests_url: String,
    brave_url: String,
    exa_url: String,
}

impl std::fmt::Debug for DiscoveryGatewayConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DiscoveryGatewayConfig")
            .field(
                "outscraper_api_key_configured",
                &!self.outscraper_api_key.is_empty(),
            )
            .field("brave_api_key_configured", &!self.brave_api_key.is_empty())
            .field("exa_api_key_configured", &!self.exa_api_key.is_empty())
            .field("search_url", &self.search_url)
            .field("requests_url", &self.requests_url)
            .field("brave_url", &self.brave_url)
            .field("exa_url", &self.exa_url)
            .finish()
    }
}

/// Read hosted Discovery configuration. An absent key leaves the routes disabled.
pub fn config_from_env() -> anyhow::Result<Option<DiscoveryGatewayConfig>> {
    let Some(outscraper_api_key) = configured_secret("OUTSCRAPER_API_KEY") else {
        return Ok(None);
    };
    let Some(brave_api_key) = configured_secret("BRAVE_SEARCH_API_KEY") else {
        return Ok(None);
    };
    let Some(exa_api_key) = configured_secret("EXA_SEARCH_API_KEY") else {
        return Ok(None);
    };
    let search_url = std::env::var("BUZZ_DISCOVERY_OUTSCRAPER_SEARCH_URL")
        .unwrap_or_else(|_| DEFAULT_SEARCH_URL.to_owned());
    let requests_url = std::env::var("BUZZ_DISCOVERY_OUTSCRAPER_REQUESTS_URL")
        .unwrap_or_else(|_| DEFAULT_REQUESTS_URL.to_owned());
    let brave_url = std::env::var("BUZZ_DISCOVERY_BRAVE_SEARCH_URL")
        .unwrap_or_else(|_| DEFAULT_BRAVE_URL.to_owned());
    let exa_url = std::env::var("BUZZ_DISCOVERY_EXA_SEARCH_URL")
        .unwrap_or_else(|_| DEFAULT_EXA_URL.to_owned());
    for (name, value) in [
        ("BUZZ_DISCOVERY_OUTSCRAPER_SEARCH_URL", &search_url),
        ("BUZZ_DISCOVERY_OUTSCRAPER_REQUESTS_URL", &requests_url),
        ("BUZZ_DISCOVERY_BRAVE_SEARCH_URL", &brave_url),
        ("BUZZ_DISCOVERY_EXA_SEARCH_URL", &exa_url),
    ] {
        let parsed = reqwest::Url::parse(value)
            .map_err(|_| anyhow::anyhow!("{name} must be an absolute HTTP URL"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            anyhow::bail!("{name} must be an absolute HTTP URL");
        }
    }
    Ok(Some(DiscoveryGatewayConfig {
        outscraper_api_key,
        brave_api_key,
        exa_api_key,
        search_url,
        requests_url,
        brave_url,
        exa_url,
    }))
}

fn configured_secret(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Shared hosted Discovery provider client.
pub struct DiscoveryGatewayState {
    config: DiscoveryGatewayConfig,
    client: reqwest::Client,
}

impl std::fmt::Debug for DiscoveryGatewayState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DiscoveryGatewayState")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl DiscoveryGatewayState {
    /// Build a timeout-bounded client that refuses redirects.
    pub fn new(config: DiscoveryGatewayConfig) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| anyhow::anyhow!("Discovery provider client: {error}"))?;
        Ok(Self { config, client })
    }
}

#[derive(Clone)]
struct ApiState {
    app: Arc<crate::state::AppState>,
    provider: Arc<DiscoveryGatewayState>,
}

/// Mount hosted Discovery routes only when a server provider key exists.
pub fn router(app: Arc<crate::state::AppState>, provider: Arc<DiscoveryGatewayState>) -> Router {
    Router::new()
        .route("/api/discovery/provider/submit", post(submit))
        .route("/api/discovery/provider/poll", post(poll))
        .route_layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .with_state(ApiState { app, provider })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmitRequest {
    run_id: Uuid,
    lease_id: Uuid,
    provider: DiscoveryProvider,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PollRequest {
    run_id: Uuid,
    lease_id: Uuid,
    provider: DiscoveryProvider,
    provider_request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
enum ProviderResponse {
    Pending {
        provider_request_id: String,
    },
    Ready {
        provider_request_id: String,
        observations: Vec<DiscoveryBusinessObservationInput>,
    },
}

impl ProviderResponse {
    fn provider_request_id(&self) -> &str {
        match self {
            Self::Pending {
                provider_request_id,
            }
            | Self::Ready {
                provider_request_id,
                ..
            } => provider_request_id,
        }
    }
}

async fn submit(
    State(state): State<ApiState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ProviderResponse>, (StatusCode, Json<Value>)> {
    let (tenant, actor) = authenticate(
        &state.app,
        &headers,
        "POST",
        "/api/discovery/provider/submit",
        &body,
    )
    .await?;
    let request: SubmitRequest = serde_json::from_slice(&body)
        .map_err(|_| safe_error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let context = state
        .app
        .db
        .discovery_gateway_run_context(
            tenant.community(),
            &actor.to_bytes(),
            request.run_id,
            request.lease_id,
            request.provider,
        )
        .await
        .map_err(map_db_error)?;
    if context.request_cursor.is_some() {
        return Err(safe_error(StatusCode::CONFLICT, "already_submitted"));
    }
    let fence = format!("colony_pending_{}", Uuid::new_v4().simple());
    let fenced = state
        .app
        .db
        .fence_discovery_gateway_submission(
            tenant.community(),
            &actor.to_bytes(),
            request.run_id,
            request.lease_id,
            request.provider,
            &fence,
        )
        .await
        .map_err(map_db_error)?;
    if !fenced {
        return Err(safe_error(StatusCode::CONFLICT, "already_submitted"));
    }
    let parsed = submit_to_provider(
        &state.provider,
        request.provider,
        &context.business_search,
        context.remaining_target,
    )
    .await?;
    let finalized = state
        .app
        .db
        .finalize_discovery_gateway_submission(
            tenant.community(),
            request.run_id,
            request.provider,
            &fence,
            parsed.provider_request_id(),
        )
        .await
        .map_err(map_db_error)?;
    if !finalized {
        return Err(safe_error(StatusCode::CONFLICT, "request_not_fenced"));
    }
    Ok(Json(parsed))
}

async fn submit_to_provider(
    state: &DiscoveryGatewayState,
    provider: DiscoveryProvider,
    search: &DiscoveryBusinessSearchSpec,
    remaining_target: u16,
) -> Result<ProviderResponse, (StatusCode, Json<Value>)> {
    match provider {
        DiscoveryProvider::Outscraper => submit_outscraper(state, search, remaining_target).await,
        DiscoveryProvider::BraveSearch => submit_brave(state, search, remaining_target).await,
        DiscoveryProvider::ExaSearch => submit_exa(state, search, remaining_target).await,
    }
}

async fn submit_outscraper(
    state: &DiscoveryGatewayState,
    search: &DiscoveryBusinessSearchSpec,
    remaining_target: u16,
) -> Result<ProviderResponse, (StatusCode, Json<Value>)> {
    let query = search.provider_query();
    let limit = remaining_target.to_string();
    let mut parameters = vec![
        ("query", query.as_str()),
        ("limit", limit.as_str()),
        ("language", search.language.as_str()),
        ("async", "true"),
        ("fields", OUTSCRAPER_FIELDS),
    ];
    if let Some(region) = &search.region {
        parameters.push(("region", region.as_str()));
    }
    let mut search_url = reqwest::Url::parse(&state.config.search_url)
        .map_err(|_| safe_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"))?;
    search_url.query_pairs_mut().extend_pairs(parameters);
    let response = state
        .client
        .post(search_url)
        .header("x-api-key", &state.config.outscraper_api_key)
        .send()
        .await
        .map_err(|_| safe_error(StatusCode::BAD_GATEWAY, "provider_unavailable"))?;
    parse_provider_response(response).await
}

#[derive(Deserialize)]
struct BraveEnvelope {
    web: Option<BraveWebResults>,
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
    thumbnail: Option<BraveThumbnail>,
}

#[derive(Deserialize)]
struct BraveProfile {
    name: Option<String>,
    img: Option<String>,
}

#[derive(Deserialize)]
struct BraveThumbnail {
    src: Option<String>,
    original: Option<String>,
}

async fn submit_brave(
    state: &DiscoveryGatewayState,
    search: &DiscoveryBusinessSearchSpec,
    remaining_target: u16,
) -> Result<ProviderResponse, (StatusCode, Json<Value>)> {
    let query = search.provider_query();
    let count = usize::from(remaining_target).min(20).to_string();
    let mut url = reqwest::Url::parse(&state.config.brave_url)
        .map_err(|_| safe_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"))?;
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("count", &count)
        .append_pair("search_lang", &search.language);
    if let Some(region) = &search.region {
        url.query_pairs_mut().append_pair("country", region);
    }
    let response = state
        .client
        .get(url)
        .header("accept", "application/json")
        .header("x-subscription-token", &state.config.brave_api_key)
        .send()
        .await
        .map_err(|_| safe_error(StatusCode::BAD_GATEWAY, "provider_unavailable"))?;
    ensure_provider_success(response.status())?;
    let bytes = read_bounded_body(response).await?;
    let envelope: BraveEnvelope = serde_json::from_slice(&bytes)
        .map_err(|_| safe_error(StatusCode::BAD_GATEWAY, "provider_malformed"))?;
    let candidates = envelope
        .web
        .map(|web| web.results)
        .unwrap_or_default()
        .into_iter()
        .map(|result| {
            let profile_name = result.profile.as_ref().and_then(|value| value.name.clone());
            let profile_image = result.profile.and_then(|value| value.img);
            WebCandidate {
                title: result.title,
                url: result.url,
                description: result.description,
                image_url: profile_image.or_else(|| {
                    result
                        .thumbnail
                        .and_then(|value| value.src.or(value.original))
                }),
                profile_name,
            }
        })
        .collect();
    Ok(ProviderResponse::Ready {
        provider_request_id: format!("brave_{}", Uuid::new_v4().simple()),
        observations: normalize_web_candidates(DiscoveryProvider::BraveSearch, candidates, search),
    })
}

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
    #[serde(default)]
    results: Vec<ExaResult>,
}

#[derive(Deserialize)]
struct ExaResult {
    title: Option<String>,
    url: Option<String>,
    image: Option<String>,
    favicon: Option<String>,
}

async fn submit_exa(
    state: &DiscoveryGatewayState,
    search: &DiscoveryBusinessSearchSpec,
    remaining_target: u16,
) -> Result<ProviderResponse, (StatusCode, Json<Value>)> {
    let query = search.provider_query();
    let request = ExaRequest {
        query: &query,
        num_results: usize::from(remaining_target).min(100),
        search_type: "auto",
        category: "company",
        user_location: search.region.as_deref(),
    };
    let response = state
        .client
        .post(&state.config.exa_url)
        .header("accept", "application/json")
        .header("x-api-key", &state.config.exa_api_key)
        .json(&request)
        .send()
        .await
        .map_err(|_| safe_error(StatusCode::BAD_GATEWAY, "provider_unavailable"))?;
    ensure_provider_success(response.status())?;
    let bytes = read_bounded_body(response).await?;
    let envelope: ExaEnvelope = serde_json::from_slice(&bytes)
        .map_err(|_| safe_error(StatusCode::BAD_GATEWAY, "provider_malformed"))?;
    if !valid_request_id(&envelope.request_id) {
        return Err(safe_error(StatusCode::BAD_GATEWAY, "provider_malformed"));
    }
    let candidates = envelope
        .results
        .into_iter()
        .map(|result| WebCandidate {
            title: result.title,
            url: result.url,
            description: None,
            image_url: result.image.or(result.favicon),
            profile_name: None,
        })
        .collect();
    Ok(ProviderResponse::Ready {
        provider_request_id: envelope.request_id,
        observations: normalize_web_candidates(DiscoveryProvider::ExaSearch, candidates, search),
    })
}

fn ensure_provider_success(status: reqwest::StatusCode) -> Result<(), (StatusCode, Json<Value>)> {
    match status {
        reqwest::StatusCode::OK => Ok(()),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => Err(safe_error(
            StatusCode::BAD_GATEWAY,
            "provider_configuration",
        )),
        reqwest::StatusCode::PAYMENT_REQUIRED => {
            Err(safe_error(StatusCode::BAD_GATEWAY, "provider_billing"))
        }
        reqwest::StatusCode::TOO_MANY_REQUESTS => Err(safe_error(
            StatusCode::TOO_MANY_REQUESTS,
            "provider_rate_limited",
        )),
        status if status.is_server_error() => {
            Err(safe_error(StatusCode::BAD_GATEWAY, "provider_unavailable"))
        }
        _ => Err(safe_error(StatusCode::BAD_GATEWAY, "provider_failed")),
    }
}

async fn poll(
    State(state): State<ApiState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ProviderResponse>, (StatusCode, Json<Value>)> {
    let (tenant, actor) = authenticate(
        &state.app,
        &headers,
        "POST",
        "/api/discovery/provider/poll",
        &body,
    )
    .await?;
    let request: PollRequest = serde_json::from_slice(&body)
        .map_err(|_| safe_error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    if !valid_request_id(&request.provider_request_id) {
        return Err(safe_error(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let context = state
        .app
        .db
        .discovery_gateway_run_context(
            tenant.community(),
            &actor.to_bytes(),
            request.run_id,
            request.lease_id,
            request.provider,
        )
        .await
        .map_err(map_db_error)?;
    if context.request_cursor.as_deref() != Some(&request.provider_request_id) {
        return Err(safe_error(StatusCode::FORBIDDEN, "request_not_fenced"));
    }
    if request.provider != DiscoveryProvider::Outscraper {
        return Err(safe_error(StatusCode::CONFLICT, "request_already_ready"));
    }
    let url = format!(
        "{}/{}",
        state.provider.config.requests_url.trim_end_matches('/'),
        request.provider_request_id
    );
    let response = state
        .provider
        .client
        .get(url)
        .header("x-api-key", &state.provider.config.outscraper_api_key)
        .send()
        .await
        .map_err(|_| safe_error(StatusCode::BAD_GATEWAY, "provider_unavailable"))?;
    parse_provider_response(response).await.map(Json)
}

async fn authenticate(
    state: &Arc<crate::state::AppState>,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: &[u8],
) -> Result<(buzz_core::TenantContext, nostr::PublicKey), (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| safe_error(StatusCode::NOT_FOUND, "community_not_found"))?;
    let url = crate::api::bridge::nip98_expected_url(&state.config.relay_url, &tenant, path);
    let (actor, event_id) = crate::api::bridge::verify_bridge_auth_with_options(
        headers,
        method,
        &url,
        Some(body),
        true,
        true,
    )?;
    crate::api::bridge::check_nip98_replay(state, &tenant, event_id).await?;
    Ok((tenant, actor))
}

#[derive(Deserialize)]
struct OutscraperEnvelope {
    id: Option<String>,
    status: Option<String>,
    data: Option<Value>,
}

async fn parse_provider_response(
    response: reqwest::Response,
) -> Result<ProviderResponse, (StatusCode, Json<Value>)> {
    match response.status() {
        reqwest::StatusCode::OK | reqwest::StatusCode::ACCEPTED => {}
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            return Err(safe_error(
                StatusCode::BAD_GATEWAY,
                "provider_configuration",
            ));
        }
        reqwest::StatusCode::PAYMENT_REQUIRED => {
            return Err(safe_error(StatusCode::BAD_GATEWAY, "provider_billing"));
        }
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            return Err(safe_error(
                StatusCode::TOO_MANY_REQUESTS,
                "provider_rate_limited",
            ));
        }
        status if status.is_server_error() => {
            return Err(safe_error(StatusCode::BAD_GATEWAY, "provider_unavailable"));
        }
        _ => return Err(safe_error(StatusCode::BAD_GATEWAY, "provider_failed")),
    }
    let bytes = read_bounded_body(response).await?;
    let envelope: OutscraperEnvelope = serde_json::from_slice(&bytes)
        .map_err(|_| safe_error(StatusCode::BAD_GATEWAY, "provider_malformed"))?;
    let request_id = envelope
        .id
        .filter(|value| valid_request_id(value))
        .ok_or_else(|| safe_error(StatusCode::BAD_GATEWAY, "provider_malformed"))?;
    match envelope
        .status
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("pending") => Ok(ProviderResponse::Pending {
            provider_request_id: request_id,
        }),
        Some("success") => {
            let values = extract_values(envelope.data)
                .ok_or_else(|| safe_error(StatusCode::BAD_GATEWAY, "provider_malformed"))?;
            Ok(ProviderResponse::Ready {
                provider_request_id: request_id,
                observations: normalize_places(values),
            })
        }
        Some("failure" | "failed") => Err(safe_error(StatusCode::BAD_GATEWAY, "provider_failed")),
        _ => Err(safe_error(StatusCode::BAD_GATEWAY, "provider_malformed")),
    }
}

async fn read_bounded_body(
    response: reqwest::Response,
) -> Result<Vec<u8>, (StatusCode, Json<Value>)> {
    use futures_util::StreamExt;

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| safe_error(StatusCode::BAD_GATEWAY, "provider_unavailable"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err(safe_error(
                StatusCode::BAD_GATEWAY,
                "provider_response_too_large",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn extract_values(data: Option<Value>) -> Option<Vec<Value>> {
    let values = data?.as_array()?.clone();
    if let Some(nested) = values.first().and_then(Value::as_array) {
        Some(nested.clone())
    } else {
        Some(values)
    }
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawSubtypes {
    Text(String),
    List(Vec<String>),
}

#[derive(Deserialize)]
struct RawPlace {
    name: Option<String>,
    place_id: Option<String>,
    google_id: Option<String>,
    cid: Option<String>,
    phone: Option<String>,
    site: Option<String>,
    website: Option<String>,
    full_address: Option<String>,
    address: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postal_code: Option<String>,
    country: Option<String>,
    country_code: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    rating: Option<f64>,
    reviews: Option<u64>,
    #[serde(rename = "type")]
    place_type: Option<String>,
    category: Option<String>,
    subtypes: Option<RawSubtypes>,
    business_status: Option<String>,
    verified: Option<bool>,
    location_link: Option<String>,
    photo: Option<String>,
    logo: Option<String>,
}

fn normalize_places(values: Vec<Value>) -> Vec<DiscoveryBusinessObservationInput> {
    let mut ids = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| serde_json::from_value::<RawPlace>(value).ok())
        .filter_map(normalize_place)
        .filter(|observation| ids.insert(observation.provider_record_id.clone()))
        .collect()
}

fn normalize_place(raw: RawPlace) -> Option<DiscoveryBusinessObservationInput> {
    let name = text(raw.name, 256)?;
    let place_id = identifier(raw.place_id);
    let google_id = identifier(raw.google_id);
    let cid = identifier(raw.cid);
    let provider_record_id = if let Some(value) = &place_id {
        format!("place:{value}")
    } else if let Some(value) = &google_id {
        format!("google:{value}")
    } else {
        format!("cid:{}", cid.as_deref()?)
    };
    let observation = DiscoveryBusinessObservationInput {
        observation_id: deterministic_business_observation_id(
            DiscoveryProvider::Outscraper,
            &provider_record_id,
        ),
        provider: DiscoveryProvider::Outscraper,
        provider_record_id,
        place_id,
        google_id,
        name,
        website: web_url(raw.website.or(raw.site)),
        phone: text(raw.phone, 64),
        full_address: text(raw.full_address.or(raw.address), 512),
        city: text(raw.city, 128),
        state: text(raw.state, 128),
        postal_code: text(raw.postal_code, 128),
        country: text(raw.country, 128),
        country_code: country_code(raw.country_code),
        latitude_micros: coordinate(raw.latitude, 90.0),
        longitude_micros: coordinate(raw.longitude, 180.0),
        category: text(raw.category.or(raw.place_type), 128),
        subtypes: subtypes(raw.subtypes),
        rating_hundredths: rating(raw.rating),
        reviews_count: raw.reviews.and_then(|value| u32::try_from(value).ok()),
        business_status: raw.business_status.and_then(status),
        verified: raw.verified,
        source_url: web_url(raw.location_link),
        image_url: web_url(raw.photo.or(raw.logo)),
        description: None,
    };
    observation.validate().ok()?;
    Some(observation)
}

fn identifier(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty()
        && value.len() <= 240
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_')))
    .then_some(value)
}

fn text(value: Option<String>, maximum: usize) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control))
        .then_some(value)
}

fn web_url(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    (value.len() <= 2048
        && !value.chars().any(char::is_control)
        && matches!(reqwest::Url::parse(&value).ok()?.scheme(), "http" | "https"))
    .then_some(value)
}

fn country_code(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_ascii_uppercase();
    (value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_uppercase())).then_some(value)
}

fn coordinate(value: Option<f64>, maximum: f64) -> Option<i32> {
    let value = value?;
    if !value.is_finite() || !(-maximum..=maximum).contains(&value) {
        return None;
    }
    let micros = (value * 1_000_000.0).round();
    (micros >= f64::from(i32::MIN) && micros <= f64::from(i32::MAX)).then_some(micros as i32)
}

fn rating(value: Option<f64>) -> Option<u16> {
    let value = value?;
    (value.is_finite() && (0.0..=5.0).contains(&value)).then_some((value * 100.0).round() as u16)
}

fn subtypes(value: Option<RawSubtypes>) -> Vec<String> {
    let values = match value {
        Some(RawSubtypes::Text(value)) => value.split(',').map(str::to_owned).collect(),
        Some(RawSubtypes::List(values)) => values,
        None => Vec::new(),
    };
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| text(Some(value), 128))
        .filter(|value| seen.insert(value.clone()))
        .take(20)
        .collect()
}

fn status(value: String) -> Option<DiscoveryBusinessStatus> {
    match value.trim().to_ascii_uppercase().as_str() {
        "OPERATIONAL" | "OPEN" => Some(DiscoveryBusinessStatus::Operational),
        "CLOSED_TEMPORARILY" | "TEMPORARILY_CLOSED" => {
            Some(DiscoveryBusinessStatus::TemporarilyClosed)
        }
        "CLOSED_PERMANENTLY" | "PERMANENTLY_CLOSED" => {
            Some(DiscoveryBusinessStatus::PermanentlyClosed)
        }
        _ => None,
    }
}

struct WebCandidate {
    title: Option<String>,
    url: Option<String>,
    description: Option<String>,
    image_url: Option<String>,
    profile_name: Option<String>,
}

fn normalize_web_candidates(
    provider: DiscoveryProvider,
    candidates: Vec<WebCandidate>,
    search: &DiscoveryBusinessSearchSpec,
) -> Vec<DiscoveryBusinessObservationInput> {
    let mut ids = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|candidate| normalize_web_candidate(provider, candidate, search))
        .filter(|observation| ids.insert(observation.provider_record_id.clone()))
        .collect()
}

fn normalize_web_candidate(
    provider: DiscoveryProvider,
    candidate: WebCandidate,
    search: &DiscoveryBusinessSearchSpec,
) -> Option<DiscoveryBusinessObservationInput> {
    let website = canonical_business_url(candidate.url?)?;
    let provider_record_id = format!("url:{}", hex::encode(Sha256::digest(website.as_bytes())));
    let name = text(candidate.profile_name, 256)
        .or_else(|| title_name(candidate.title))
        .or_else(|| domain_name(&website))?;
    let observation = DiscoveryBusinessObservationInput {
        observation_id: deterministic_business_observation_id(provider, &provider_record_id),
        provider,
        provider_record_id,
        place_id: None,
        google_id: None,
        name,
        website: Some(website.clone()),
        phone: None,
        full_address: None,
        city: text(Some(search.location.clone()), 128),
        state: None,
        postal_code: None,
        country: None,
        country_code: country_code(search.region.clone()),
        latitude_micros: None,
        longitude_micros: None,
        category: text(Some(search.query.clone()), 128),
        subtypes: Vec::new(),
        rating_hundredths: None,
        reviews_count: None,
        business_status: None,
        verified: None,
        source_url: Some(website),
        image_url: web_url(candidate.image_url),
        description: text(candidate.description, 2_048),
    };
    observation.validate().ok()?;
    Some(observation)
}

fn canonical_business_url(value: String) -> Option<String> {
    let mut url = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if [
        "facebook.com",
        "google.com",
        "instagram.com",
        "linkedin.com",
        "tripadvisor.com",
        "wikipedia.org",
        "x.com",
        "yelp.com",
        "youtube.com",
    ]
    .iter()
    .any(|excluded| host == *excluded || host.ends_with(&format!(".{excluded}")))
    {
        return None;
    }
    url.set_host(Some(&host)).ok()?;
    url.set_fragment(None);
    let mut query = url
        .query_pairs()
        .into_owned()
        .filter(|(name, _)| {
            let name = name.to_ascii_lowercase();
            !name.starts_with("utm_") && !matches!(name.as_str(), "fbclid" | "gclid")
        })
        .collect::<Vec<_>>();
    query.sort();
    url.set_query(None);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    let value = url.to_string();
    (value.len() <= 2_048).then_some(value)
}

fn title_name(value: Option<String>) -> Option<String> {
    let value = value?;
    let name = value
        .split(['|', '\u{2013}', '-'])
        .map(str::trim)
        .find(|part| !part.is_empty())?;
    text(Some(name.to_owned()), 256)
}

fn domain_name(value: &str) -> Option<String> {
    let host = reqwest::Url::parse(value).ok()?.host_str()?.to_owned();
    let label = host.split('.').next()?.replace(['-', '_'], " ");
    let name = label
        .split_whitespace()
        .map(|part| {
            let mut characters = part.chars();
            characters
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ");
    text(Some(name), 256)
}

fn map_db_error(error: buzz_db::DbError) -> (StatusCode, Json<Value>) {
    match error {
        buzz_db::DbError::NotFound(_) => safe_error(StatusCode::NOT_FOUND, "run_not_found"),
        buzz_db::DbError::AccessDenied(_) => {
            safe_error(StatusCode::FORBIDDEN, "provider_request_not_allowed")
        }
        _ => safe_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    }
}

fn safe_error(status: StatusCode, code: &'static str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": code })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_config(base_url: &str) -> DiscoveryGatewayConfig {
        DiscoveryGatewayConfig {
            outscraper_api_key: "fixture-secret-must-not-escape".into(),
            brave_api_key: "fixture-brave-secret-must-not-escape".into(),
            exa_api_key: "fixture-exa-secret-must-not-escape".into(),
            search_url: format!("{base_url}/outscraper"),
            requests_url: format!("{base_url}/requests"),
            brave_url: format!("{base_url}/brave"),
            exa_url: format!("{base_url}/exa"),
        }
    }

    fn search() -> DiscoveryBusinessSearchSpec {
        DiscoveryBusinessSearchSpec {
            query: "dentists".into(),
            location: "Cape Town".into(),
            limit: 3,
            language: "en".into(),
            region: Some("ZA".into()),
        }
    }

    #[test]
    fn provider_config_debug_never_contains_the_key() {
        let config = provider_config("https://provider.test");
        assert!(!format!("{config:?}").contains("fixture-secret-must-not-escape"));
        assert!(!format!("{config:?}").contains("fixture-brave-secret-must-not-escape"));
        assert!(!format!("{config:?}").contains("fixture-exa-secret-must-not-escape"));
    }

    #[test]
    fn normalized_output_is_light_and_deterministic() {
        let values = vec![json!({
            "name": "Sandton Dental",
            "place_id": "place_123",
            "website": "https://dentist.example",
            "phone": "+27110000000",
            "rating": 4.7,
            "reviews": 52,
            "emails": ["secret-shape@example.test"],
            "owner_data": {"must": "not escape"}
        })];
        let first = normalize_places(values.clone());
        let second = normalize_places(values);
        assert_eq!(first, second);
        assert_eq!(first.len(), 1);
        let encoded = serde_json::to_string(&first).expect("encode light result");
        assert!(!encoded.contains("owner_data"));
        assert!(!encoded.contains("secret-shape"));
    }

    #[tokio::test]
    async fn brave_and_exa_use_server_keys_and_return_light_observations() {
        async fn brave(
            headers: axum::http::HeaderMap,
            axum::extract::Query(query): axum::extract::Query<
                std::collections::HashMap<String, String>,
            >,
        ) -> Json<Value> {
            assert_eq!(
                headers
                    .get("x-subscription-token")
                    .and_then(|value| value.to_str().ok()),
                Some("fixture-brave-secret-must-not-escape")
            );
            assert_eq!(
                query.get("q").map(String::as_str),
                Some("dentists, Cape Town")
            );
            assert_eq!(query.get("country").map(String::as_str), Some("ZA"));
            Json(json!({
                "web": {"results": [{
                    "title": "Cape Dental | Home",
                    "url": "https://cape-dental.example/?utm_source=test",
                    "description": "Public dental practice"
                }]}
            }))
        }

        async fn exa(headers: axum::http::HeaderMap, Json(body): Json<Value>) -> Json<Value> {
            assert_eq!(
                headers
                    .get("x-api-key")
                    .and_then(|value| value.to_str().ok()),
                Some("fixture-exa-secret-must-not-escape")
            );
            assert_eq!(
                body.get("query").and_then(Value::as_str),
                Some("dentists, Cape Town")
            );
            assert_eq!(
                body.get("category").and_then(Value::as_str),
                Some("company")
            );
            Json(json!({
                "requestId": "exa_request_1",
                "results": [{
                    "title": "Sea Point Dental",
                    "url": "https://sea-point-dental.example/",
                    "image": "https://sea-point-dental.example/logo.png"
                }]
            }))
        }

        let app = Router::new()
            .route("/brave", axum::routing::get(brave))
            .route("/exa", axum::routing::post(exa));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind provider fixture");
        let address = listener.local_addr().expect("provider fixture address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve provider fixture");
        });
        let state = DiscoveryGatewayState::new(provider_config(&format!("http://{address}")))
            .expect("provider state");

        let brave = submit_brave(&state, &search(), 3)
            .await
            .expect("Brave response");
        let exa = submit_exa(&state, &search(), 3)
            .await
            .expect("Exa response");
        server.abort();

        let ProviderResponse::Ready {
            observations: brave,
            ..
        } = brave
        else {
            panic!("Brave is synchronous");
        };
        let ProviderResponse::Ready {
            observations: exa, ..
        } = exa
        else {
            panic!("Exa is synchronous");
        };
        assert_eq!(brave.len(), 1);
        assert_eq!(brave[0].provider, DiscoveryProvider::BraveSearch);
        assert_eq!(brave[0].name, "Cape Dental");
        assert_eq!(
            brave[0].website.as_deref(),
            Some("https://cape-dental.example/")
        );
        assert_eq!(exa.len(), 1);
        assert_eq!(exa[0].provider, DiscoveryProvider::ExaSearch);
        assert_eq!(exa[0].name, "Sea Point Dental");
    }
}
