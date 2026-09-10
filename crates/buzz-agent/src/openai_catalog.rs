//! Read-only model discovery through the provider connection already configured at launch.

use std::collections::HashSet;
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::Deserialize;
use tokio::sync::OnceCell;

use crate::{config::Config, AgentError, ModelEntry};

const MAX_CATALOG_BYTES: usize = 1024 * 1024;
const MAX_CATALOG_MODELS: usize = 1000;

enum DiscoveryError {
    Unsupported,
    Failed(AgentError),
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
}

/// Cache only a successfully served catalog. A custom endpoint without a
/// catalog retains its configured model and retries discovery next session.
pub(crate) async fn resolve(
    cfg: &Config,
    cache: &OnceCell<Vec<ModelEntry>>,
) -> Result<Vec<ModelEntry>, AgentError> {
    match cache.get_or_try_init(|| discover(cfg)).await {
        Ok(models) => Ok(models.clone()),
        Err(DiscoveryError::Unsupported) => Ok(crate::configured_model_fallback(&cfg.model)),
        Err(DiscoveryError::Failed(error)) => Err(error),
    }
}

fn optional_catalog(base: &url::Url) -> bool {
    let official = base
        .host_str()
        .is_some_and(|host| host == "api.openai.com" || host.ends_with(".api.openai.com"));
    let managed = base.path().contains("/openai/k/")
        || base.path().contains("/gateway/openai")
        || base.path().starts_with("/openai/v1");
    !official && !managed
}

async fn discover(cfg: &Config) -> Result<Vec<ModelEntry>, DiscoveryError> {
    let fail = |message: &str| DiscoveryError::Failed(AgentError::Llm(message.into()));
    let base = url::Url::parse(&cfg.base_url)
        .map_err(|_| fail("Model catalog connection has an invalid base URL"))?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err(fail("Model catalog connection requires HTTP or HTTPS"));
    }
    // Match the inference path's base suffix exactly. Meter bases already end
    // in /v1 and contain a virtual credential in the path, so never log URLs.
    let url = format!("{}/models", cfg.base_url.trim_end_matches('/'));
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| fail("Could not initialize model catalog connection"))?;
    let mut response = client
        .get(url)
        .bearer_auth(&cfg.api_key)
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| fail("Model catalog request failed; check the teammate's connection"))?;
    let status = response.status();
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return Err(DiscoveryError::Failed(AgentError::LlmAuth(format!(
            "Model catalog rejected the configured credential (HTTP {})",
            status.as_u16()
        ))));
    }
    if matches!(
        status,
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
    ) && optional_catalog(&base)
    {
        return Err(DiscoveryError::Unsupported);
    }
    if !status.is_success() {
        return Err(DiscoveryError::Failed(AgentError::Llm(format!(
            "Model catalog request failed (HTTP {})",
            status.as_u16()
        ))));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_CATALOG_BYTES as u64)
    {
        return Err(fail("Model catalog exceeds the 1 MiB response limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| fail("Model catalog response could not be read"))?
    {
        if chunk.len() > MAX_CATALOG_BYTES.saturating_sub(bytes.len()) {
            return Err(fail("Model catalog exceeds the 1 MiB response limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let parsed = serde_json::from_slice::<ModelList>(&bytes)
        .map_err(|_| fail("Model catalog returned an invalid response"))?;
    if parsed.data.len() > MAX_CATALOG_MODELS {
        return Err(fail("Model catalog exceeds the 1000 model entry limit"));
    }
    let mut seen = HashSet::new();
    let models: Vec<_> = parsed
        .data
        .into_iter()
        .filter(|model| crate::session_models::is_reply_model_id(&model.id))
        .filter(|model| seen.insert(model.id.clone()))
        .map(|model| ModelEntry {
            name: model.id.clone(),
            id: model.id,
        })
        .collect();
    if models.is_empty() {
        return Err(fail("Model catalog contains no selectable models"));
    }
    Ok(models)
}

#[cfg(test)]
#[path = "openai_catalog_tests.rs"]
mod tests;
