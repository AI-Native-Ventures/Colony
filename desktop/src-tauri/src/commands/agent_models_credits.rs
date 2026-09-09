//! Credits model discovery uses the same private lease as launch, never a user's API key.

use serde::Deserialize;
use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{AgentModelInfo, AgentModelsResponse},
    provisioned_credits::ensure_lease_blocking,
    relay::{classify_request_error, relay_ws_url_with_override},
};

#[derive(Deserialize)]
struct ModelList {
    data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
}

pub(super) async fn discover_credits_models(
    app: &AppHandle,
    state: &AppState,
    selected_model: Option<String>,
) -> Result<AgentModelsResponse, String> {
    let relay = relay_ws_url_with_override(state);
    let app = app.clone();
    // Minting/reusing a lease performs no inference and spends no credits. Its
    // signer and relay are captured by the lease manager; the token stays native.
    let lease =
        tokio::task::spawn_blocking(move || ensure_lease_blocking(&app, &relay, None, false))
            .await
            .map_err(|_| "Could not load Colony Credits models".to_string())??;
    let url = format!("{}/gateway/openai/v1/models", lease.key.relay_origin);
    #[cfg(feature = "onboarding-fixture")]
    crate::relay::validate_fixture_url(&url)?;
    let models = fetch_models(&state.http_client, &url, lease.token.as_str()).await?;
    if models.is_empty() {
        return Err("No Colony Credits models are available for this business yet.".to_string());
    }
    Ok(AgentModelsResponse {
        agent_name: "Colony Credits".to_string(),
        agent_version: "gateway-catalog".to_string(),
        models,
        agent_default_model: None,
        selected_model,
        supports_switching: true,
    })
}

/// Query only an existing lease. Reply controls never acquire credentials.
pub(super) async fn discover_credits_reply_models(
    app: &AppHandle,
    state: &AppState,
    selected_model: Option<String>,
) -> Result<AgentModelsResponse, String> {
    let relay = relay_ws_url_with_override(state);
    let lease = crate::provisioned_credits::cached_catalog_lease(app, &relay)?;
    let url = format!("{}/gateway/openai/v1/models", lease.key.relay_origin);
    #[cfg(feature = "onboarding-fixture")]
    crate::relay::validate_fixture_url(&url)?;
    let served = fetch_models(&state.http_client, &url, lease.token.as_str()).await?;
    if served.is_empty() {
        return Err("No Colony Credits models are available for this business yet.".into());
    }
    // Native hosted discovery and the runtime use the same reasoning capability source.
    let models: Vec<AgentModelInfo> = served
        .iter()
        .filter(|model| buzz_agent_pkg::session_models::is_reply_model_id(&model.id))
        .flat_map(|model| {
            buzz_agent_pkg::session_models::supported_reply_model_ids(
                buzz_agent_pkg::config::Provider::OpenAi,
                &model.id,
            )
            .into_iter()
            .map(|id| AgentModelInfo::new(id.clone(), Some(id), None))
        })
        .collect();
    if models.is_empty() {
        return Err("No conversation models are available through Colony Credits.".into());
    }
    Ok(AgentModelsResponse {
        agent_name: "Colony Credits".into(),
        agent_version: "reply-catalog".into(),
        models,
        agent_default_model: selected_model.clone(),
        selected_model,
        supports_switching: true,
    })
}

async fn fetch_models(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<Vec<AgentModelInfo>, String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|error| classify_request_error(&error))?;
    if !response.status().is_success() {
        return Err(match response.status() {
            reqwest::StatusCode::NOT_FOUND => {
                "Colony Credits is unavailable for this business. Choose another way to power your agents or contact Colony support.".to_string()
            }
            reqwest::StatusCode::UNAUTHORIZED => {
                "Colony Credits connection expired. Reconnect and try again.".to_string()
            }
            _ => "Could not load Colony Credits models. Try again.".to_string(),
        });
    }
    let response = response
        .json::<ModelList>()
        .await
        .map_err(|_| "Colony Credits returned an invalid model catalog".to_string())?;
    let models: Vec<AgentModelInfo> = response
        .data
        .into_iter()
        .filter(|model| !model.id.trim().is_empty())
        .map(|model| AgentModelInfo::new(model.id.clone(), Some(model.id), None))
        .collect();
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn catalog_uses_private_gateway_auth_without_a_provider_key_or_inference() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept catalog");
            let mut bytes = Vec::new();
            let mut buffer = [0; 2048];
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).expect("read catalog request");
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(bytes).expect("request text");
            assert!(request.starts_with("GET /gateway/openai/v1/models HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer synthetic-lease"));
            assert!(request
                .to_ascii_lowercase()
                .contains("cache-control: no-store"));
            let body = r#"{"data":[{"id":"served-model"}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).expect("respond");
        });
        let models = fetch_models(
            &reqwest::Client::new(),
            &format!("http://{address}/gateway/openai/v1/models"),
            "synthetic-lease",
        )
        .await
        .expect("served catalog");
        server.join().expect("catalog fixture");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "served-model");
    }
}
