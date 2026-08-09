//! Anthropic model discovery — split from `agent_models.rs` (file-size
//! guard). Endpoint resolution and response normalization for the
//! Anthropic provider's model list.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::*;

#[derive(Debug, Deserialize)]
pub(super) struct AnthropicModelListResponse {
    pub(super) data: Vec<AnthropicModelListItem>,
    #[serde(default)]
    pub(super) has_more: bool,
    #[serde(default)]
    pub(super) last_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AnthropicModelListItem {
    pub(super) id: String,
    #[serde(default)]
    pub(super) display_name: Option<String>,
}

pub(super) fn is_anthropic_provider(provider: Option<&str>) -> bool {
    matches!(
        provider
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("anthropic")
    )
}

#[cfg(test)]
pub(super) fn anthropic_models_url(env: &BTreeMap<String, String>) -> String {
    let base_url = env_value(env, "ANTHROPIC_BASE_URL")
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    anthropic_models_url_from_base(&base_url)
}

pub(super) fn anthropic_models_url_for_discovery(env: &BTreeMap<String, String>) -> String {
    let base_url = env_or_process_value(env, "ANTHROPIC_BASE_URL")
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    anthropic_models_url_from_base(&base_url)
}

pub(super) fn anthropic_models_url_from_base(base_url: &str) -> String {
    let base_url = base_url.trim_end_matches('/');
    if base_url.ends_with("/v1") {
        format!("{base_url}/models")
    } else {
        format!("{base_url}/v1/models")
    }
}

pub(super) fn normalize_anthropic_models(
    response: AnthropicModelListResponse,
) -> Vec<AgentModelInfo> {
    let mut seen = HashSet::new();
    response
        .data
        .into_iter()
        .filter(|item| seen.insert(item.id.clone()))
        .map(|item| AgentModelInfo::new(item.id, item.display_name, None))
        .collect()
}

async fn fetch_anthropic_model_page(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    after_id: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Result<AnthropicModelListResponse, String> {
    let mut request = client
        .get(url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01");
    if let Some(after_id) = after_id {
        request = request.query(&[("after_id", after_id)]);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Anthropic model discovery request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body = crate::managed_agents::redact_env_values_in(&body, env);
        return Err(format!("Anthropic model discovery HTTP {status}: {body}"));
    }

    response
        .json::<AnthropicModelListResponse>()
        .await
        .map_err(|error| format!("Anthropic model discovery response parse failed: {error}"))
}

pub(super) async fn discover_anthropic_models(
    client: &reqwest::Client,
    provider: &DiscoveryProvider,
    env: &BTreeMap<String, String>,
    selected_model: Option<String>,
) -> Result<Option<AgentModelsResponse>, String> {
    if !is_anthropic_provider(provider.as_deref()) {
        return Ok(None);
    }

    let api_key = match provider.required_env(env, "ANTHROPIC_API_KEY")? {
        Some(api_key) => api_key,
        None => return Ok(None),
    };
    let redaction_env = redaction_env_with_value(env, "ANTHROPIC_API_KEY", &api_key);
    let url = anthropic_models_url_for_discovery(env);
    let mut models = Vec::new();
    let mut after_id: Option<String> = None;
    for _ in 0..20 {
        let response =
            fetch_anthropic_model_page(client, &url, &api_key, after_id.as_deref(), &redaction_env)
                .await?;
        let has_more = response.has_more;
        after_id = response.last_id.clone();
        models.extend(normalize_anthropic_models(response));
        if !has_more {
            break;
        }
        if after_id.as_deref().unwrap_or_default().is_empty() {
            return Err("Anthropic model discovery pagination did not return last_id".to_string());
        }
    }
    let mut seen = HashSet::new();
    models.retain(|model| seen.insert(model.id.clone()));
    if models.is_empty() {
        return Err("Anthropic model discovery returned no models".to_string());
    }

    Ok(Some(AgentModelsResponse {
        agent_name: provider
            .as_deref()
            .unwrap_or("anthropic")
            .trim()
            .to_string(),
        agent_version: "models-api".to_string(),
        models,
        agent_default_model: None,
        selected_model,
        supports_switching: true,
    }))
}

// ---------------------------------------------------------------------------
// Databricks model discovery (v1 + v2)
// ---------------------------------------------------------------------------
//
// Delegates to buzz_agent_pkg::catalog::discover_databricks_models, which
// acquires auth in-process via build_token_source:
//   - Static bearer (DATABRICKS_TOKEN): returned immediately.
//   - PKCE cache hit: returned from disk without a browser flow.
//   - No token, no cache: returns Err(LlmAuth) → we return Ok(None) and fall
//     through to run_agent_models_command. Never hangs, never opens a browser.
