use std::collections::BTreeMap;

use serde::Deserialize;

use crate::managed_agents::{AgentModelInfo, AgentModelsResponse};

#[cfg(test)]
use super::env_value;
use super::{env_or_process_value, DiscoveryProvider};

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(Clone))]
pub(super) struct OpenRouterModelListResponse {
    pub data: Vec<OpenRouterModelListItem>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(Clone))]
pub(super) struct OpenRouterModelListItem {
    pub id: String,
    #[serde(default)]
    pub supported_parameters: Vec<String>,
}

pub(super) fn is_openrouter_provider(provider: Option<&str>) -> bool {
    matches!(
        provider
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("openrouter")
    )
}

#[cfg(test)]
pub(super) fn openrouter_models_url(env: &BTreeMap<String, String>) -> String {
    let base_url = env_value(env, "OPENROUTER_BASE_URL")
        .unwrap_or_else(|| "https://openrouter.ai/api/v1".to_string());
    format!("{}/models", base_url.trim_end_matches('/'))
}

fn openrouter_models_url_for_discovery(env: &BTreeMap<String, String>) -> String {
    let base_url = env_or_process_value(env, "OPENROUTER_BASE_URL")
        .unwrap_or_else(|| "https://openrouter.ai/api/v1".to_string());
    format!("{}/models", base_url.trim_end_matches('/'))
}

pub(super) async fn discover_openrouter_models(
    client: &reqwest::Client,
    provider: &DiscoveryProvider,
    env: &BTreeMap<String, String>,
    selected_model: Option<String>,
) -> Result<Option<AgentModelsResponse>, String> {
    if !is_openrouter_provider(provider.as_deref()) {
        return Ok(None);
    }

    let api_key = match provider.required_env(env, "OPENROUTER_API_KEY")? {
        Some(api_key) => api_key,
        None => return Ok(None),
    };
    let url = openrouter_models_url_for_discovery(env);
    #[cfg(feature = "onboarding-fixture")]
    crate::relay::validate_fixture_url(&url)?;
    let key_url = format!("{}/key", url.trim_end_matches("/models"));
    validate_openrouter_key(client, &key_url, &api_key).await?;
    let response = client
        .get(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|error| format!("OpenRouter model discovery request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "OpenRouter model discovery HTTP {status}. Try again."
        ));
    }

    let response = response
        .json::<OpenRouterModelListResponse>()
        .await
        .map_err(|error| format!("OpenRouter model discovery response parse failed: {error}"))?;

    filter_openrouter_models(response, selected_model)
}

pub(super) fn filter_openrouter_models(
    response: OpenRouterModelListResponse,
    selected_model: Option<String>,
) -> Result<Option<AgentModelsResponse>, String> {
    let models: Vec<AgentModelInfo> = response
        .data
        .into_iter()
        .filter(|m| m.supported_parameters.iter().any(|p| p == "tools"))
        .map(|m| AgentModelInfo::new(m.id.clone(), Some(m.id), None))
        .collect();

    if models.is_empty() {
        return Err("OpenRouter model discovery returned no tools-capable models".to_string());
    }

    Ok(Some(AgentModelsResponse {
        agent_name: "openrouter".to_string(),
        agent_version: "models-api".to_string(),
        models,
        agent_default_model: None,
        selected_model,
        supports_switching: true,
    }))
}

/// The public model list does not prove a saved key still authenticates.
async fn validate_openrouter_key(
    client: &reqwest::Client,
    url: &str,
    key: &str,
) -> Result<(), String> {
    #[cfg(feature = "onboarding-fixture")]
    crate::relay::validate_fixture_url(url)?;
    let response = client
        .get(url)
        .bearer_auth(key)
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| "Could not check your OpenRouter connection. Try again.".to_string())?;
    if !response.status().is_success() {
        return Err(if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            "Your OpenRouter connection expired or was revoked. Reconnect OpenRouter.".to_string()
        } else {
            "Could not check your OpenRouter connection. Try again.".to_string()
        });
    }
    let metadata = response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| "OpenRouter returned invalid account information".to_string())?;
    if !metadata
        .get("data")
        .is_some_and(serde_json::Value::is_object)
    {
        return Err("OpenRouter returned invalid account information".to_string());
    }
    if metadata["data"]["is_management_key"].as_bool() == Some(true) {
        return Err(
            "Connect an OpenRouter inference account instead of a management key.".to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod key_auth_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    async fn key_response(status: &str, body: &str) -> Result<(), String> {
        let listener = TcpListener::bind("127.0.0.1:0").expect("key fixture");
        let address = listener.local_addr().expect("key fixture address");
        let status = status.to_owned();
        let body = body.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept key metadata request");
            let mut request = Vec::new();
            let mut buffer = [0; 2048];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).expect("read metadata request");
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).expect("HTTP text");
            assert!(request.starts_with("GET /api/v1/key HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer synthetic-key"));
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("metadata response");
        });
        let result = validate_openrouter_key(
            &reqwest::Client::new(),
            &format!("http://{address}/api/v1/key"),
            "synthetic-key",
        )
        .await;
        server.join().expect("metadata fixture completion");
        result
    }

    #[tokio::test]
    async fn invalid_key_is_not_accepted_even_when_models_are_public() {
        let error = key_response("401 Unauthorized", r#"{"error":"private response text"}"#)
            .await
            .expect_err("revoked key must fail");
        assert!(error.contains("Reconnect OpenRouter"));
        assert!(!error.contains("private response text"));
    }

    #[tokio::test]
    async fn a_valid_free_key_needs_no_purchase_or_inference_request_to_connect() {
        key_response(
            "200 OK",
            r#"{"data":{"is_free_tier":true,"limit_remaining":0}}"#,
        )
        .await
        .expect("valid free key");
    }
}
