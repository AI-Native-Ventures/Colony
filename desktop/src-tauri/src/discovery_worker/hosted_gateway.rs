use buzz_core_pkg::{
    discovery::DiscoveryProvider, discovery_worker::DiscoveryBusinessObservationInput,
};
use nostr::Keys;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{app_state::AppState, relay::build_nip98_auth_header_for_keys};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub(super) enum HostedProviderResponse {
    Pending {
        provider_request_id: String,
    },
    Ready {
        provider_request_id: String,
        observations: Vec<DiscoveryBusinessObservationInput>,
    },
}

#[derive(Serialize)]
struct SubmitRequest {
    run_id: Uuid,
    lease_id: Uuid,
    provider: DiscoveryProvider,
}

#[derive(Serialize)]
struct PollRequest<'a> {
    run_id: Uuid,
    lease_id: Uuid,
    provider: DiscoveryProvider,
    provider_request_id: &'a str,
}

pub(super) async fn submit(
    state: &AppState,
    keys: &Keys,
    api_base_url: &str,
    run_id: Uuid,
    lease_id: Uuid,
    provider: DiscoveryProvider,
) -> Result<HostedProviderResponse, String> {
    post(
        state,
        keys,
        api_base_url,
        "/api/discovery/provider/submit",
        &SubmitRequest {
            run_id,
            lease_id,
            provider,
        },
    )
    .await
}

pub(super) async fn poll(
    state: &AppState,
    keys: &Keys,
    api_base_url: &str,
    run_id: Uuid,
    lease_id: Uuid,
    provider: DiscoveryProvider,
    provider_request_id: &str,
) -> Result<HostedProviderResponse, String> {
    post(
        state,
        keys,
        api_base_url,
        "/api/discovery/provider/poll",
        &PollRequest {
            run_id,
            lease_id,
            provider,
            provider_request_id,
        },
    )
    .await
}

async fn post<T: Serialize>(
    state: &AppState,
    keys: &Keys,
    api_base_url: &str,
    path: &str,
    request: &T,
) -> Result<HostedProviderResponse, String> {
    let body = serde_json::to_vec(request)
        .map_err(|_| "Discovery provider request is invalid".to_owned())?;
    let url = format!("{}{path}", api_base_url.trim_end_matches('/'));
    let auth = build_nip98_auth_header_for_keys(keys, &Method::POST, &url, &body)?;
    let response = state
        .http_client
        .post(&url)
        .header("authorization", auth)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "Discovery provider gateway is unreachable".to_owned())?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "Discovery provider request is no longer authorized",
            409 => "Discovery provider request was already submitted",
            429 => "Discovery provider is temporarily rate limited",
            _ => "Discovery provider gateway could not complete the request",
        }
        .to_owned());
    }
    response
        .json::<HostedProviderResponse>()
        .await
        .map_err(|_| "Discovery provider gateway returned an invalid response".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_requests_contain_no_provider_secret_or_targeting() {
        let encoded = serde_json::to_string(&SubmitRequest {
            run_id: Uuid::nil(),
            lease_id: Uuid::from_u128(1),
            provider: DiscoveryProvider::Outscraper,
        })
        .expect("encode hosted request");
        assert_eq!(
            encoded,
            r#"{"run_id":"00000000-0000-0000-0000-000000000000","lease_id":"00000000-0000-0000-0000-000000000001","provider":"outscraper"}"#
        );
        for forbidden in ["key", "query", "location", "url", "header", "cursor"] {
            assert!(!encoded.contains(forbidden));
        }
    }
}
