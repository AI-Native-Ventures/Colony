use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    app_state::AppState,
    managed_agents::{
        load_managed_agents, load_personas, BackendKind, CreateManagedAgentRequest,
        CreatePersonaRequest, ManagedAgentRecord, PersonaBehaviorRequest, RespondTo,
        UpdatePersonaRequest,
    },
};

use super::{
    create_managed_agent_with_creation_request, create_persona_with_id, start_managed_agent,
    update_persona,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposalSafeAction {
    request_id: String,
    definition: AgentProposalDefinition,
    run_on: AgentProposalRunOn,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentProposalDefinition {
    #[serde(default)]
    id: Option<String>,
    display_name: String,
    #[serde(default)]
    avatar_url: Option<String>,
    system_prompt: String,
    #[serde(default)]
    runtime: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    behavior: Option<AgentProposalBehavior>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentProposalBehavior {
    #[serde(default)]
    respond_to: Option<RespondTo>,
    #[serde(default)]
    respond_to_allowlist: Vec<String>,
    #[serde(default)]
    parallelism: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum AgentProposalRunOn {
    Local,
    Provider { id: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AgentProposalExecutionOutcome {
    Applied {
        definition_id: String,
        agent_pubkey: String,
        recovered: bool,
    },
    Failed {
        safe_message: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum CreationRecovery {
    Complete {
        definition_id: String,
        agent_pubkey: String,
    },
    ResumeAgent {
        definition_id: String,
        agent_pubkey: String,
    },
    ResumeDefinition,
    CreateDefinition,
}

fn trim_required(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required"));
    }
    Ok(trimmed.to_string())
}

fn trim_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_avatar_url(value: &Option<String>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let parsed = url::Url::parse(value).map_err(|_| "avatar URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("avatar must be an uploaded HTTP(S) URL".to_string());
    }
    Ok(())
}

fn normalized_behavior(
    behavior: &Option<AgentProposalBehavior>,
) -> Result<PersonaBehaviorRequest, String> {
    let behavior = behavior.clone().unwrap_or(AgentProposalBehavior {
        respond_to: None,
        respond_to_allowlist: Vec::new(),
        parallelism: None,
    });
    if behavior.respond_to == Some(RespondTo::Allowlist) && behavior.respond_to_allowlist.is_empty()
    {
        return Err("allowlist mode requires at least one member".to_string());
    }
    if behavior
        .parallelism
        .is_some_and(|parallelism| !(1..=32).contains(&parallelism))
    {
        return Err("parallelism must be between 1 and 32".to_string());
    }
    Ok(PersonaBehaviorRequest {
        respond_to: behavior.respond_to,
        respond_to_allowlist: behavior.respond_to_allowlist,
        parallelism: behavior.parallelism,
    })
}

fn definition_matches_action(
    existing: &crate::managed_agents::AgentDefinition,
    action: &AgentProposalDefinition,
    request_id: &str,
) -> bool {
    let behavior = action.behavior.as_ref();
    existing.id == request_id
        && existing.display_name == action.display_name.trim()
        && existing.avatar_url == trim_optional(&action.avatar_url)
        && existing.system_prompt == action.system_prompt
        && existing.runtime == trim_optional(&action.runtime)
        && existing.provider == trim_optional(&action.provider)
        && existing.model == trim_optional(&action.model)
        && existing.respond_to.as_deref()
            == behavior
                .and_then(|value| value.respond_to)
                .map(RespondTo::as_str)
        && existing.respond_to_allowlist
            == behavior
                .map(|value| value.respond_to_allowlist.clone())
                .unwrap_or_default()
        && existing.parallelism == behavior.and_then(|value| value.parallelism)
        && !existing.is_builtin
        && existing.source_team.is_none()
}

fn inspect_creation_recovery(
    definitions: &[crate::managed_agents::AgentDefinition],
    records: &[ManagedAgentRecord],
    action: &AgentProposalSafeAction,
) -> Result<CreationRecovery, String> {
    let definition = definitions
        .iter()
        .find(|definition| definition.id == action.request_id);
    let record = records
        .iter()
        .find(|record| record.creation_request_id.as_deref() == Some(action.request_id.as_str()));

    match (definition, record) {
        (Some(definition), Some(record)) => {
            if !definition_matches_action(definition, &action.definition, &action.request_id) {
                return Err("saved definition no longer matches this proposal".to_string());
            }
            let operational = match &record.backend {
                // Local runtimes are keyed by (pubkey, active relay), while the
                // legacy scalar PID is not community-scoped. Re-entering the
                // idempotent start path is the only reliable verification that
                // this exact workspace pair is alive.
                BackendKind::Local => false,
                BackendKind::Provider { .. } => {
                    record.last_error.is_none() && record.backend_agent_id.is_some()
                }
            };
            let recovery = if operational {
                CreationRecovery::Complete {
                    definition_id: definition.id.clone(),
                    agent_pubkey: record.pubkey.clone(),
                }
            } else {
                CreationRecovery::ResumeAgent {
                    definition_id: definition.id.clone(),
                    agent_pubkey: record.pubkey.clone(),
                }
            };
            Ok(recovery)
        }
        (Some(definition), None) => {
            if !definition_matches_action(definition, &action.definition, &action.request_id) {
                return Err("saved definition no longer matches this proposal".to_string());
            }
            Ok(CreationRecovery::ResumeDefinition)
        }
        (None, Some(_)) => Err("managed agent exists without its definition".to_string()),
        (None, None) => Ok(CreationRecovery::CreateDefinition),
    }
}

fn load_creation_recovery(
    app: &AppHandle,
    state: &AppState,
    action: &AgentProposalSafeAction,
) -> Result<CreationRecovery, String> {
    let _guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let definitions = load_personas(app)?;
    let records = load_managed_agents(app)?;
    inspect_creation_recovery(&definitions, &records, action)
}

fn recovered_outcome(recovery: CreationRecovery) -> Option<AgentProposalExecutionOutcome> {
    match recovery {
        CreationRecovery::Complete {
            definition_id,
            agent_pubkey,
        } => Some(AgentProposalExecutionOutcome::Applied {
            definition_id,
            agent_pubkey,
            recovered: true,
        }),
        CreationRecovery::ResumeAgent { .. }
        | CreationRecovery::ResumeDefinition
        | CreationRecovery::CreateDefinition => None,
    }
}

fn normalized_relay_scope(relay_url: &str) -> &str {
    relay_url.trim().trim_end_matches('/')
}

fn safe_failure(message: impl Into<String>) -> AgentProposalExecutionOutcome {
    AgentProposalExecutionOutcome::Failed {
        safe_message: message.into(),
    }
}

fn create_persona_input(
    definition: &AgentProposalDefinition,
) -> Result<CreatePersonaRequest, String> {
    Ok(CreatePersonaRequest {
        display_name: trim_required(&definition.display_name, "Display name")?,
        role_id: None,
        role_title: None,
        avatar_url: trim_optional(&definition.avatar_url),
        system_prompt: definition.system_prompt.clone(),
        runtime: trim_optional(&definition.runtime),
        model: trim_optional(&definition.model),
        provider: trim_optional(&definition.provider),
        name_pool: Vec::new(),
        env_vars: BTreeMap::new(),
        behavior: Some(normalized_behavior(&definition.behavior)?),
        catalog_source: None,
    })
}

fn create_agent_input(
    action: &AgentProposalSafeAction,
    backend_config: Option<serde_json::Value>,
) -> Result<CreateManagedAgentRequest, String> {
    let behavior = normalized_behavior(&action.definition.behavior)?;
    let (backend, local) = match &action.run_on {
        AgentProposalRunOn::Local => {
            if backend_config.is_some() {
                return Err("provider configuration is invalid for a local agent".to_string());
            }
            (BackendKind::Local, true)
        }
        AgentProposalRunOn::Provider { id } => {
            let id = trim_required(id, "Provider")?;
            let config =
                backend_config.ok_or_else(|| "provider configuration is required".to_string())?;
            if !config.is_object() {
                return Err("provider configuration is invalid".to_string());
            }
            (BackendKind::Provider { id, config }, false)
        }
    };
    Ok(CreateManagedAgentRequest {
        name: trim_required(&action.definition.display_name, "Display name")?,
        persona_id: Some(action.request_id.clone()),
        team_id: None,
        relay_url: None,
        acp_command: local.then(|| "buzz-acp".to_string()),
        // The linked definition's runtime and the Rust runtime catalog remain
        // authoritative. No parallel runtime table is created here.
        agent_command: None,
        harness_override: false,
        agent_args: Vec::new(),
        mcp_command: None,
        turn_timeout_seconds: None,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: behavior.parallelism,
        system_prompt: Some(action.definition.system_prompt.clone()),
        avatar_url: trim_optional(&action.definition.avatar_url),
        model: trim_optional(&action.definition.model),
        provider: trim_optional(&action.definition.provider),
        env_vars: BTreeMap::new(),
        spawn_after_create: true,
        start_on_app_launch: local,
        backend,
        respond_to: behavior.respond_to,
        respond_to_allowlist: behavior.respond_to_allowlist,
        relay_mesh: None,
        community: None,
    })
}

fn update_persona_input(
    current: &crate::managed_agents::AgentDefinition,
    definition: &AgentProposalDefinition,
) -> Result<UpdatePersonaRequest, String> {
    Ok(UpdatePersonaRequest {
        id: current.id.clone(),
        display_name: trim_required(&definition.display_name, "Display name")?,
        role_id: None,
        role_title: None,
        avatar_url: trim_optional(&definition.avatar_url),
        system_prompt: definition.system_prompt.clone(),
        runtime: trim_optional(&definition.runtime),
        model: trim_optional(&definition.model),
        provider: trim_optional(&definition.provider),
        // Not in the signed contract: preserve instead of manufacturing state.
        name_pool: current.name_pool.clone(),
        // Secrets are never accepted by this command and therefore never
        // replaced by Agent Proposal execution.
        env_vars: None,
        behavior: Some(normalized_behavior(&definition.behavior)?),
    })
}

fn validate_action(action: &AgentProposalSafeAction) -> Result<(), String> {
    Uuid::parse_str(&action.request_id).map_err(|_| "request ID must be a UUID".to_string())?;
    validate_avatar_url(&action.definition.avatar_url)?;
    trim_required(&action.definition.display_name, "Display name")?;
    if action.definition.id.as_deref() == Some(action.request_id.as_str()) {
        return Err("an update cannot target the deterministic create ID".to_string());
    }
    normalized_behavior(&action.definition.behavior)?;
    Ok(())
}

#[tauri::command]
pub async fn execute_agent_proposal(
    action: AgentProposalSafeAction,
    backend_config: Option<serde_json::Value>,
    community_relay_url: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentProposalExecutionOutcome, String> {
    let Some(community_relay_url) = community_relay_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(safe_failure(
            "The proposal lost its community context. Reopen Review and retry.",
        ));
    };
    let _community_operation_guard = state.community_operation_lock.read().await;
    if normalized_relay_scope(community_relay_url)
        != normalized_relay_scope(&crate::relay::relay_ws_url_with_override(&state))
    {
        return Ok(safe_failure(
            "The active community changed. Reopen Review and retry.",
        ));
    }
    if let Err(error) = validate_action(&action) {
        return Ok(safe_failure(error));
    }

    if let Some(target_id) = action.definition.id.clone() {
        if backend_config.is_some() {
            return Ok(safe_failure(
                "Provider configuration is only accepted while creating an agent.",
            ));
        }
        let current = {
            let _guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let definitions = load_personas(&app)?;
            let Some(current) = definitions
                .into_iter()
                .find(|definition| definition.id == target_id)
            else {
                return Ok(safe_failure("The agent definition no longer exists."));
            };
            if current.is_builtin || current.source_team.is_some() {
                return Ok(safe_failure(
                    "Built-in and team agent definitions cannot be changed here.",
                ));
            }
            current
        };
        let input = match update_persona_input(&current, &action.definition) {
            Ok(input) => input,
            Err(error) => return Ok(safe_failure(error)),
        };
        if update_persona(input, app.clone()).await.is_err() {
            return Ok(safe_failure(
                "Could not update this agent. Reopen Review and retry.",
            ));
        }
        let agent_pubkey = {
            let _guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            load_managed_agents(&app)?
                .into_iter()
                .find(|record| record.persona_id.as_deref() == Some(target_id.as_str()))
                .map(|record| record.pubkey)
                .unwrap_or_default()
        };
        return Ok(AgentProposalExecutionOutcome::Applied {
            definition_id: target_id,
            agent_pubkey,
            recovered: false,
        });
    }

    let recovery = load_creation_recovery(&app, &state, &action);
    match recovery {
        Ok(CreationRecovery::Complete {
            definition_id,
            agent_pubkey,
        }) => {
            return Ok(AgentProposalExecutionOutcome::Applied {
                definition_id,
                agent_pubkey,
                recovered: true,
            });
        }
        Ok(CreationRecovery::ResumeAgent {
            definition_id,
            agent_pubkey,
        }) => {
            if start_managed_agent(agent_pubkey.clone(), app.clone(), state.clone())
                .await
                .is_err()
            {
                return Ok(safe_failure(
                    "The agent was saved but could not start. Reopen Review and retry.",
                ));
            }
            return Ok(AgentProposalExecutionOutcome::Applied {
                definition_id,
                agent_pubkey,
                recovered: true,
            });
        }
        Err(_) => {
            return Ok(safe_failure(
                "Saved agent state no longer matches this proposal.",
            ));
        }
        Ok(CreationRecovery::CreateDefinition) => {
            let input = match create_persona_input(&action.definition) {
                Ok(input) => input,
                Err(error) => return Ok(safe_failure(error)),
            };
            if create_persona_with_id(input, Some(action.request_id.clone()), app.clone())
                .await
                .is_err()
            {
                match load_creation_recovery(&app, &state, &action) {
                    Ok(CreationRecovery::ResumeDefinition) => {}
                    Ok(CreationRecovery::ResumeAgent { .. }) => {
                        return Ok(safe_failure(
                            "Saved agent state changed while applying this proposal. Reopen Review and retry.",
                        ));
                    }
                    Ok(recovery) => {
                        if let Some(outcome) = recovered_outcome(recovery) {
                            return Ok(outcome);
                        }
                        return Ok(safe_failure(
                            "Could not save this agent definition. Reopen Review and retry.",
                        ));
                    }
                    Err(_) => {
                        return Ok(safe_failure(
                            "Saved agent state no longer matches this proposal.",
                        ));
                    }
                }
            }
        }
        Ok(CreationRecovery::ResumeDefinition) => {}
    }

    let input = match create_agent_input(&action, backend_config) {
        Ok(input) => input,
        Err(error) => return Ok(safe_failure(error)),
    };
    match create_managed_agent_with_creation_request(
        input,
        app.clone(),
        &state,
        Some(action.request_id.clone()),
    )
    .await
    {
        Ok(created) => {
            if created.spawn_error.is_some() {
                return Ok(safe_failure(
                    "The agent was saved but could not start. Reopen Review and retry.",
                ));
            }
            Ok(AgentProposalExecutionOutcome::Applied {
                definition_id: action.request_id,
                agent_pubkey: created.agent.pubkey,
                recovered: false,
            })
        }
        Err(_) => match load_creation_recovery(&app, &state, &action) {
            Ok(recovery) => Ok(recovered_outcome(recovery).unwrap_or_else(|| {
                safe_failure("Could not create this agent. Reopen Review and retry.")
            })),
            Err(_) => Ok(safe_failure(
                "Saved agent state no longer matches this proposal.",
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::AgentDefinition;
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;

    fn action() -> AgentProposalSafeAction {
        AgentProposalSafeAction {
            request_id: "11111111-1111-4111-8111-111111111111".to_string(),
            definition: AgentProposalDefinition {
                id: None,
                display_name: "Researcher".to_string(),
                avatar_url: None,
                system_prompt: "Research leads.".to_string(),
                runtime: Some("codex".to_string()),
                provider: None,
                model: None,
                behavior: None,
            },
            run_on: AgentProposalRunOn::Local,
        }
    }

    fn definition(action: &AgentProposalSafeAction) -> AgentDefinition {
        AgentDefinition {
            id: action.request_id.clone(),
            role_id: None,
            role_title: None,
            display_name: action.definition.display_name.clone(),
            avatar_url: None,
            system_prompt: action.definition.system_prompt.clone(),
            runtime: action.definition.runtime.clone(),
            model: None,
            provider: None,
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            env_vars: BTreeMap::new(),
            respond_to: None,
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        }
    }

    #[test]
    fn agent_proposal_create_recovery_converges_after_each_durable_write() {
        let action = action();
        assert_eq!(
            inspect_creation_recovery(&[], &[], &action).unwrap(),
            CreationRecovery::CreateDefinition
        );
        let definition = definition(&action);
        assert_eq!(
            inspect_creation_recovery(std::slice::from_ref(&definition), &[], &action).unwrap(),
            CreationRecovery::ResumeDefinition
        );
        let mut record = definition.clone().into_agent_record();
        record.pubkey = "a".repeat(64);
        record.creation_request_id = Some(action.request_id.clone());
        assert_eq!(
            inspect_creation_recovery(
                std::slice::from_ref(&definition),
                std::slice::from_ref(&record),
                &action
            )
            .unwrap(),
            CreationRecovery::ResumeAgent {
                definition_id: action.request_id.clone(),
                agent_pubkey: "a".repeat(64),
            }
        );

        assert_eq!(
            inspect_creation_recovery(&[definition], &[record], &action).unwrap(),
            CreationRecovery::ResumeAgent {
                definition_id: action.request_id,
                agent_pubkey: "a".repeat(64),
            }
        );
    }

    #[test]
    fn agent_proposal_provider_recovery_requires_successful_deploy() {
        let action = action();
        let definition = definition(&action);
        let mut record = definition.clone().into_agent_record();
        record.pubkey = "a".repeat(64);
        record.creation_request_id = Some(action.request_id.clone());
        record.backend = BackendKind::Provider {
            id: "blox".to_string(),
            config: serde_json::json!({"region": "us-east"}),
        };
        record.last_error = Some("provider unavailable".to_string());

        assert_eq!(
            inspect_creation_recovery(
                std::slice::from_ref(&definition),
                std::slice::from_ref(&record),
                &action
            )
            .unwrap(),
            CreationRecovery::ResumeAgent {
                definition_id: action.request_id.clone(),
                agent_pubkey: "a".repeat(64),
            }
        );

        record.backend_agent_id = Some("provider-agent".to_string());
        record.last_error = None;
        assert_eq!(
            inspect_creation_recovery(&[definition], &[record], &action).unwrap(),
            CreationRecovery::Complete {
                definition_id: action.request_id,
                agent_pubkey: "a".repeat(64),
            }
        );
    }

    #[test]
    fn agent_proposal_concurrent_replays_reserve_one_creation_request() {
        let request_id = action().request_id;
        let records = Arc::new(Mutex::new(Vec::<ManagedAgentRecord>::new()));
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();

        for index in 0..2 {
            let records = Arc::clone(&records);
            let barrier = Arc::clone(&barrier);
            let request_id = request_id.clone();
            workers.push(thread::spawn(move || {
                barrier.wait();
                let mut records = records.lock().expect("test records lock");
                if crate::commands::ensure_unique_creation_request(&records, Some(&request_id))
                    .is_err()
                {
                    return false;
                }
                let mut record = definition(&action()).into_agent_record();
                record.pubkey = format!("{index:064x}");
                record.creation_request_id = Some(request_id);
                records.push(record);
                true
            }));
        }
        barrier.wait();
        let winners = workers
            .into_iter()
            .map(|worker| worker.join().expect("worker joins"))
            .filter(|won| *won)
            .count();
        let records = records.lock().expect("test records lock");
        assert_eq!(winners, 1);
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].creation_request_id.as_deref(),
            Some(request_id.as_str())
        );
    }

    #[test]
    fn agent_proposal_provider_config_is_separate_and_required_before_create() {
        let mut action = action();
        action.run_on = AgentProposalRunOn::Provider {
            id: "blox".to_string(),
        };
        assert!(create_agent_input(&action, None)
            .unwrap_err()
            .contains("required"));
        let input = create_agent_input(&action, Some(serde_json::json!({"token": "local"})))
            .expect("separate trusted config");
        assert!(matches!(input.backend, BackendKind::Provider { .. }));
    }

    #[test]
    fn agent_proposal_relay_scope_allows_only_the_pinned_community() {
        assert_eq!(
            normalized_relay_scope("wss://relay.example/"),
            normalized_relay_scope(" wss://relay.example ")
        );
        assert_ne!(
            normalized_relay_scope("wss://relay-a.example"),
            normalized_relay_scope("wss://relay-b.example")
        );
    }

    #[test]
    fn agent_proposal_rejects_data_uri_avatar_before_store_access() {
        let mut action = action();
        action.definition.avatar_url = Some("data:image/png;base64,AAAA".to_string());
        assert!(validate_action(&action).unwrap_err().contains("HTTP(S)"));
    }
}
