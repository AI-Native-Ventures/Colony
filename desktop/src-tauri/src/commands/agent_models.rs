use std::collections::{BTreeMap, HashSet};

use nostr::Keys;
use serde::Deserialize;
use tauri::{AppHandle, State};

use super::agent_model_process::run_agent_models_command;
use super::managed_agent_definition::apply_model_provider_prompt_update;
// Production discovery uses the process-env variant; tests use map-only helpers.
#[cfg(test)]
use super::agent_models_env::env_value;
use super::agent_models_env::{
    effective_discovery_provider, env_or_process_value, redaction_env_with_value, DiscoveryProvider,
};
use super::agent_update_rollback::{rollback_failed_agent_update, AgentUpdateRollback};

use crate::{
    app_state::AppState,
    managed_agents::{
        build_managed_agent_summary, current_instance_id, discovery_env_with_baked_floor,
        find_managed_agent_mut, known_acp_runtime, load_global_agent_config, load_managed_agents,
        load_personas, managed_agent_avatar_url, missing_command_message, normalize_agent_args,
        resolve_command, save_managed_agents, sync_managed_agent_processes, try_regenerate_nest,
        AgentModelInfo, AgentModelsResponse, CredentialMode, ManagedAgentRecord,
        UpdateManagedAgentRequest, UpdateManagedAgentResponse, DEFAULT_ACP_COMMAND,
    },
    relay::{relay_ws_url_with_override, sync_managed_agent_profile},
    util::now_iso,
};

/// Query the effective provider catalog, or the private gateway catalog for Credits.
#[tauri::command]
pub async fn get_agent_models(
    pubkey: String,
    reply_scope: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentModelsResponse, String> {
    let (resolved_acp, agent_command, discovery) = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let mut records = load_managed_agents(&app)?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        let (sync_changed, exited_pubkeys) =
            sync_managed_agent_processes(&mut records, &mut runtimes, &current_instance_id(&app));
        if sync_changed {
            save_managed_agents(&app, &records)?;
        }
        for pubkey in &exited_pubkeys {
            state.clear_agent_session_caches(pubkey);
        }

        let record = records
            .iter()
            .find(|r| r.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?;

        let resolved = resolve_command(&record.acp_command)
            .ok_or_else(|| missing_command_message(&record.acp_command, "ACP harness command"))?;

        // Resolve current persona/default inheritance exactly as spawn does.
        let personas = load_personas(&app).unwrap_or_default();
        let global = load_global_agent_config(&app).unwrap_or_default();

        // The shared resolver rejects dangling harness references.
        let discovery = agent_model_discovery_config(record, &personas, &global)
            .map_err(|e| model_discovery_error(&pubkey, &e))?;

        let resolved_agent = resolve_command(&discovery.command)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| discovery.command.clone());

        (resolved, resolved_agent, discovery)
    }; // store lock released — subprocess runs without holding the lock

    let AgentModelDiscoveryConfig {
        args: agent_args,
        model: persisted_model,
        provider: saved_provider,
        provider_env_var,
        env: merged_env,
        command: _,
    } = discovery;

    if reply_scope == Some(true) {
        return reply::discover(
            &app,
            &state,
            resolved_acp,
            agent_command,
            agent_args,
            persisted_model,
            saved_provider,
            merged_env,
        )
        .await;
    }
    if load_global_agent_config(&app)?.credential_mode == CredentialMode::ColonyCredits {
        return discover_credits_models(&app, &state, persisted_model).await;
    }
    let merged_env = discovery_env_with_baked_floor(merged_env);
    // Resolve against the baked/process env when the record saved no provider,
    // so a build-provided provider still gets live discovery.
    let effective_provider =
        effective_discovery_provider(saved_provider.as_deref(), provider_env_var, &merged_env);
    if let Some(models) = discover_openrouter_models(
        &state.http_client,
        &effective_provider,
        &merged_env,
        persisted_model.clone(),
    )
    .await?
    {
        return Ok(models);
    }

    if let Some(models) = discover_openai_compatible_models(
        &state.http_client,
        &effective_provider,
        &merged_env,
        persisted_model.clone(),
    )
    .await?
    {
        return Ok(models);
    }

    if let Some(models) = discover_anthropic_models(
        &state.http_client,
        &effective_provider,
        &merged_env,
        persisted_model.clone(),
    )
    .await?
    {
        return Ok(models);
    }

    if let Some(models) = discover_databricks_models(
        &state.http_client,
        &effective_provider,
        &merged_env,
        persisted_model.clone(),
    )
    .await?
    {
        return Ok(models);
    }

    run_agent_models_command(
        resolved_acp,
        agent_command,
        agent_args,
        persisted_model,
        merged_env,
    )
    .await
}

#[path = "agent_models_reply.rs"]
mod reply;

#[path = "agent_models_credits.rs"]
mod credits;
use credits::discover_credits_models;

#[path = "agent_models_discovery_config.rs"]
mod discovery_config;
use discovery_config::{
    agent_model_discovery_config, draft_agent_model_discovery_env, model_discovery_error,
    AgentModelDiscoveryConfig,
};

pub use discovery_config::DiscoverAgentModelsInput;

/// Query an unsaved configuration; Credits reads the host-owned gateway catalog.
#[tauri::command]
pub async fn discover_agent_models(
    input: DiscoverAgentModelsInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentModelsResponse, String> {
    if input.credential_mode == CredentialMode::ColonyCredits {
        return discover_credits_models(&app, &state, None).await;
    }
    crate::managed_agents::validate_user_env_keys(&input.env_vars)?;
    crate::managed_agents::validate_user_env_keys(&input.definition_env)?;

    let acp_command = input
        .acp_command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ACP_COMMAND);
    let resolved_acp = resolve_command(acp_command)
        .ok_or_else(|| missing_command_message(acp_command, "ACP harness command"))?;

    let agent_command = input.agent_command.trim();
    if agent_command.is_empty() {
        return Err("agent command is required for model discovery".to_string());
    }
    let agent_args = normalize_agent_args(agent_command, input.agent_args);
    let resolved_agent = resolve_command(agent_command)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| agent_command.to_string());

    let runtime_meta = known_acp_runtime(agent_command);
    let merged_env = draft_agent_model_discovery_env(
        agent_command,
        input.provider.as_deref(),
        &input.definition_env,
        &input.env_vars,
    );
    let merged_env = discovery_env_with_baked_floor(merged_env);
    // Respect the build provider when the draft has none.
    let effective_provider = effective_discovery_provider(
        input.provider.as_deref(),
        runtime_meta.and_then(|meta| meta.provider_env_var),
        &merged_env,
    );

    // Buzz shared compute discovery must not depend on the local OpenAI ingress: that
    // client endpoint is started only after a live target is selected.
    #[cfg(feature = "mesh-llm")]
    if input.provider.as_deref().map(str::trim)
        == Some(crate::managed_agents::RELAY_MESH_PROVIDER_ID)
    {
        let events = crate::relay::query_relay(
            &state,
            &[
                crate::mesh_llm::mesh_status_filter(),
                crate::mesh_llm::relay_membership_filter(),
            ],
        )
        .await
        .map_err(|error| format!("Colony shared compute model discovery failed: {error}"))?;
        let availability = crate::mesh_llm::availability_from_events(events);
        if availability.models.is_empty() {
            return Err(availability.reason.unwrap_or_else(|| {
                "No live Colony shared compute models are available".to_string()
            }));
        }
        return Ok(AgentModelsResponse {
            agent_name: crate::managed_agents::RELAY_MESH_PROVIDER_ID.to_string(),
            agent_version: "relay-availability".to_string(),
            models: availability
                .models
                .into_iter()
                .map(|model| AgentModelInfo::new(model.id, model.name, None))
                .collect(),
            agent_default_model: None,
            selected_model: None,
            supports_switching: true,
        });
    }
    #[cfg(not(feature = "mesh-llm"))]
    if input.provider.as_deref().map(str::trim)
        == Some(crate::managed_agents::RELAY_MESH_PROVIDER_ID)
    {
        return Err("Colony shared compute is not available in this build".to_string());
    }

    if let Some(models) =
        discover_openrouter_models(&state.http_client, &effective_provider, &merged_env, None)
            .await?
    {
        return Ok(models);
    }

    if let Some(models) = discover_openai_compatible_models(
        &state.http_client,
        &effective_provider,
        &merged_env,
        None,
    )
    .await?
    {
        return Ok(models);
    }

    if let Some(models) =
        discover_anthropic_models(&state.http_client, &effective_provider, &merged_env, None)
            .await?
    {
        return Ok(models);
    }

    if let Some(models) =
        discover_databricks_models(&state.http_client, &effective_provider, &merged_env, None)
            .await?
    {
        return Ok(models);
    }

    run_agent_models_command(resolved_acp, resolved_agent, agent_args, None, merged_env).await
}

#[derive(Debug, Deserialize)]
struct OpenAiModelListResponse {
    data: Vec<OpenAiModelListItem>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelListItem {
    id: String,
    #[serde(default)]
    created: Option<i64>,
}

#[path = "agent_models_openrouter.rs"]
mod openrouter;
use openrouter::discover_openrouter_models;
#[cfg(test)]
use openrouter::{
    filter_openrouter_models, is_openrouter_provider, openrouter_models_url,
    OpenRouterModelListItem, OpenRouterModelListResponse,
};

fn is_openai_compatible_provider(provider: Option<&str>) -> bool {
    matches!(
        provider
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("openai" | "openai-compat" | "deepseek" | "google")
    )
}

#[cfg(test)]
fn openai_compatible_models_url(env: &BTreeMap<String, String>) -> String {
    let base_url = env_value(env, "OPENAI_COMPAT_BASE_URL")
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    format!("{}/models", base_url.trim_end_matches('/'))
}

fn openai_compatible_models_url_for_discovery(
    env: &BTreeMap<String, String>,
    provider: Option<&str>,
) -> String {
    // Ids come from the live `/models` listing, so no static list is kept here.
    // Google's default id is `gemma-4-31b-it`, fallback `gemini-3.5-flash-lite`.
    let default_base = match provider
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("deepseek") => "https://api.deepseek.com/v1",
        Some("google") => "https://generativelanguage.googleapis.com/v1beta/openai",
        _ => "https://api.openai.com/v1",
    };
    let base_url = env_or_process_value(env, "OPENAI_COMPAT_BASE_URL")
        .unwrap_or_else(|| default_base.to_string());
    format!("{}/models", base_url.trim_end_matches('/'))
}

fn is_agent_text_model_id(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    if [
        "audio",
        "dall-e",
        "embedding",
        "image",
        "moderation",
        "realtime",
        "speech",
        "transcribe",
        "tts",
        "whisper",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return false;
    }

    lower.starts_with("gpt-") || lower.starts_with('o') || lower.starts_with("chatgpt-")
}

fn openai_dated_snapshot_alias(id: &str) -> Option<String> {
    let (base, date) = id.rsplit_once('-')?;
    if date.len() != 2 || !date.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let (base, month) = base.rsplit_once('-')?;
    if month.len() != 2 || !month.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let (base, year) = base.rsplit_once('-')?;
    if year.len() != 4 || !year.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }

    Some(base.to_string())
}

fn openai_model_display_name(id: &str) -> String {
    let canonical = openai_dated_snapshot_alias(id).unwrap_or_else(|| id.to_string());
    if let Some(rest) = canonical.strip_prefix("chatgpt-") {
        return format!("ChatGPT {}", title_case_model_suffix(rest));
    }
    if let Some(rest) = canonical.strip_prefix("gpt-") {
        return format!("GPT-{}", title_case_model_suffix(rest));
    }

    canonical
}

fn title_case_model_suffix(value: &str) -> String {
    value
        .split('-')
        .enumerate()
        .map(|(index, part)| {
            let part = if part.eq_ignore_ascii_case("pro") {
                "Pro".to_string()
            } else if part.eq_ignore_ascii_case("mini") {
                "mini".to_string()
            } else if part.eq_ignore_ascii_case("nano") {
                "nano".to_string()
            } else {
                part.to_string()
            };

            if index == 0 {
                part
            } else {
                format!(" {part}")
            }
        })
        .collect::<String>()
}

fn normalize_openai_compatible_models(
    response: OpenAiModelListResponse,
    provider: Option<&str>,
) -> Vec<AgentModelInfo> {
    let mut seen = HashSet::new();
    let mut items = response.data;
    let filter_to_openai_text_models = matches!(
        provider
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("openai")
    );
    let all_ids = items
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<String>>();
    items.sort_by(|left, right| {
        right
            .created
            .cmp(&left.created)
            .then_with(|| left.id.cmp(&right.id))
    });

    items
        .into_iter()
        .filter(|item| !filter_to_openai_text_models || is_agent_text_model_id(&item.id))
        .filter(|item| match openai_dated_snapshot_alias(&item.id) {
            Some(alias) if filter_to_openai_text_models => !all_ids.contains(&alias),
            Some(_) | None => true,
        })
        .filter(|item| seen.insert(item.id.clone()))
        .map(|item| {
            let name = openai_model_display_name(&item.id);
            AgentModelInfo::new(item.id, Some(name), None)
        })
        .collect()
}

/// Credential env var for an OpenAI-compatible provider. The Pi-family
/// harnesses (Oh My Pi, Prime Agent) resolve their native `deepseek` provider
/// from `DEEPSEEK_API_KEY`; everything else uses `OPENAI_COMPAT_API_KEY`.
/// Legacy configs that stored a DeepSeek key under `OPENAI_COMPAT_API_KEY`
/// keep working via the fallback.
fn openai_compatible_api_key_env(provider: Option<&str>) -> &'static str {
    if matches!(
        provider
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("deepseek")
    ) {
        "DEEPSEEK_API_KEY"
    } else {
        "OPENAI_COMPAT_API_KEY"
    }
}

async fn discover_openai_compatible_models(
    client: &reqwest::Client,
    provider: &DiscoveryProvider,
    env: &BTreeMap<String, String>,
    selected_model: Option<String>,
) -> Result<Option<AgentModelsResponse>, String> {
    let relay_mesh =
        provider.as_deref().map(str::trim) == Some(crate::managed_agents::RELAY_MESH_PROVIDER_ID);
    if !relay_mesh && !is_openai_compatible_provider(provider.as_deref()) {
        return Ok(None);
    }

    let api_key = if relay_mesh {
        crate::managed_agents::RELAY_MESH_API_KEY_PLACEHOLDER.to_string()
    } else {
        let primary = openai_compatible_api_key_env(provider.as_deref());
        let legacy = if primary == "DEEPSEEK_API_KEY" {
            Some("OPENAI_COMPAT_API_KEY")
        } else {
            None
        };
        // Legacy configs may hold the DeepSeek key under OPENAI_COMPAT_API_KEY.
        let found = env_or_process_value(env, primary)
            .or_else(|| legacy.and_then(|key| env_or_process_value(env, key)));
        match found {
            Some(api_key) => api_key,
            None => match provider.required_env(env, primary)? {
                Some(api_key) => api_key,
                None => return Ok(None),
            },
        }
    };
    let redaction_env = redaction_env_with_value(env, "OPENAI_COMPAT_API_KEY", &api_key);
    let url = if relay_mesh {
        format!("{}/models", crate::managed_agents::RELAY_MESH_API_BASE_URL)
    } else {
        openai_compatible_models_url_for_discovery(env, provider.as_deref())
    };
    #[cfg(feature = "onboarding-fixture")]
    crate::relay::validate_fixture_url(&url)?;
    let response = client
        .get(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|error| format!("OpenAI model discovery request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body = crate::managed_agents::redact_env_values_in(&body, &redaction_env);
        return Err(format!("OpenAI model discovery HTTP {status}: {body}"));
    }

    let response = response
        .json::<OpenAiModelListResponse>()
        .await
        .map_err(|error| format!("OpenAI model discovery response parse failed: {error}"))?;
    let models = normalize_openai_compatible_models(response, provider.as_deref());
    if models.is_empty() {
        return Err("OpenAI model discovery returned no compatible text models".to_string());
    }

    Ok(Some(AgentModelsResponse {
        agent_name: provider.as_deref().unwrap_or("openai").trim().to_string(),
        agent_version: "models-api".to_string(),
        models,
        agent_default_model: None,
        selected_model,
        supports_switching: true,
    }))
}

fn is_databricks_provider(provider: Option<&str>) -> bool {
    matches!(
        provider
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("databricks" | "databricks_v2" | "databricks-v2")
    )
}

fn databricks_agent_provider(provider: &str) -> buzz_agent_pkg::config::Provider {
    if provider.trim().eq_ignore_ascii_case("databricks_v2")
        || provider.trim().eq_ignore_ascii_case("databricks-v2")
    {
        buzz_agent_pkg::config::Provider::DatabricksV2
    } else {
        buzz_agent_pkg::config::Provider::Databricks
    }
}

async fn discover_databricks_models(
    _client: &reqwest::Client,
    provider: &DiscoveryProvider,
    env: &BTreeMap<String, String>,
    selected_model: Option<String>,
) -> Result<Option<AgentModelsResponse>, String> {
    let provider_str = match provider.as_deref() {
        Some(p) if is_databricks_provider(Some(p)) => p,
        _ => return Ok(None),
    };

    let host = match env_or_process_value(env, "DATABRICKS_HOST") {
        Some(h) => h,
        None => return Ok(None), // no host → fall through to subprocess
    };

    // api_key = DATABRICKS_TOKEN (empty string = use PKCE cache).
    let api_key = env_or_process_value(env, "DATABRICKS_TOKEN").unwrap_or_default();

    let agent_provider = databricks_agent_provider(provider_str);
    let cfg = buzz_agent_pkg::config::Config::for_discovery(agent_provider, api_key, host);

    // Build a redaction env so the token never appears in surfaced errors.
    let token_for_redact = env_or_process_value(env, "DATABRICKS_TOKEN").unwrap_or_default();
    let redaction_env = redaction_env_with_value(env, "DATABRICKS_TOKEN", &token_for_redact);

    let entries = match buzz_agent_pkg::discover_databricks_models(&cfg).await {
        Ok(e) => e,
        Err(buzz_agent_pkg::AgentError::LlmAuth(_)) => {
            // No token + no PKCE cache → fall through to subprocess.
            return Ok(None);
        }
        Err(e) => {
            let msg = crate::managed_agents::redact_env_values_in(&e.to_string(), &redaction_env);
            return Err(format!("Databricks model discovery failed: {msg}"));
        }
    };

    if entries.is_empty() {
        return Err("Databricks model discovery returned no models".to_string());
    }

    let models = entries
        .into_iter()
        .map(|e| AgentModelInfo::new(e.id, Some(e.name), None))
        .collect();

    Ok(Some(AgentModelsResponse {
        agent_name: provider_str.trim().to_string(),
        agent_version: "models-api".to_string(),
        models,
        agent_default_model: None,
        selected_model,
        supports_switching: true,
    }))
}

#[path = "agent_models_update.rs"]
mod update;
pub use update::update_managed_agent;
pub(super) use update::{flush_managed_agent_policy, managed_agent_access_policy_changed};

#[path = "agent_models_anthropic.rs"]
mod anthropic;
use anthropic::discover_anthropic_models;
#[cfg(test)]
use anthropic::{
    anthropic_models_url, normalize_anthropic_models, AnthropicModelListItem,
    AnthropicModelListResponse,
};

// ── Model normalization ───────────────────────────────────────────────────────

/// Normalize raw `buzz-acp models --json` output into a typed DTO for the frontend.
///
/// Merges models from both ACP paths (stable configOptions + unstable SessionModelState),
/// deduplicates by ID (stable takes precedence), and returns a unified list.
pub(super) fn normalize_agent_models(
    raw: &serde_json::Value,
    persisted_model: Option<String>,
) -> AgentModelsResponse {
    let agent_name = raw["agent"]["name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let agent_version = raw["agent"]["version"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    let mut models: Vec<AgentModelInfo> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();

    // 1. Stable configOptions (preferred). Only entries with category "model"
    //    are model options — the CLI pre-filters, but we're defensive here.
    if let Some(config_options) = raw["stable"]["configOptions"].as_array() {
        for opt in config_options {
            if opt.get("category").and_then(|c| c.as_str()) != Some("model") {
                continue;
            }
            if let Some(options) = opt.get("options").and_then(|v| v.as_array()) {
                for o in options {
                    if let Some(value) = o.get("value").and_then(|v| v.as_str()) {
                        if seen_ids.insert(value.to_string()) {
                            models.push(AgentModelInfo::new(
                                value.to_string(),
                                o.get("displayName")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                None,
                            ));
                        }
                    }
                }
            }
        }
    }

    // 2. Unstable availableModels (fallback — skip duplicates from stable).
    let mut agent_default_model: Option<String> = None;
    if let Some(unstable) = raw.get("unstable") {
        agent_default_model = unstable["currentModelId"].as_str().map(str::to_string);
        if let Some(available) = unstable["availableModels"].as_array() {
            for m in available {
                if let Some(id) = m.get("modelId").and_then(|v| v.as_str()) {
                    if seen_ids.insert(id.to_string()) {
                        models.push(AgentModelInfo::new(
                            id.to_string(),
                            m.get("name").and_then(|v| v.as_str()).map(str::to_string),
                            m.get("description")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                        ));
                    }
                }
            }
        }
    }

    let supports_switching = !models.is_empty();

    AgentModelsResponse {
        agent_name,
        agent_version,
        models,
        agent_default_model,
        selected_model: persisted_model,
        supports_switching,
    }
}

#[cfg(test)]
#[path = "agent_models_tests.rs"]
mod tests;
