use nostr::{Keys, ToBech32};
use tauri::{AppHandle, State};

use super::agent_creation::ensure_unique_creation_request;
use crate::{
    app_state::AppState,
    managed_agents::{
        build_managed_agent_summary, current_instance_id, discover_provider_candidates,
        enrol_persona_in_coordination_team_after_hire, ensure_persona_is_active,
        find_managed_agent_mut, load_managed_agents, load_personas, load_teams,
        managed_agent_avatar_url, normalize_agent_args, provider_deploy, resolve_provider_binary,
        save_managed_agents, stop_managed_agent_process, stop_managed_agent_workspace_pair,
        sync_managed_agent_processes, try_regenerate_nest, validate_provider_config, BackendKind,
        CreateManagedAgentRequest, CreateManagedAgentResponse, ManagedAgentSummary,
        RelayMeshConfig, DEFAULT_ACP_COMMAND, DEFAULT_AGENT_PARALLELISM,
        DEFAULT_AGENT_TURN_TIMEOUT_SECONDS,
    },
    relay::{
        creation_relay_pin, effective_agent_relay_url, relay_ws_url_with_override,
        sync_managed_agent_profile,
    },
    util::now_iso,
};

// Retain-on-save moved to `managed_agents::reconcile`, next to the
// content-diff engine it delegates to. Re-exported under its old name and
// path so every existing call site in `commands/` (including
// `super::agents::retain_managed_agent_pending` and
// `crate::commands::agents::retain_managed_agent_pending` references
// elsewhere) keeps working unchanged.
pub(super) use crate::managed_agents::reconcile::retain_managed_agent_pending;

/// Purge a deleted agent's pending row and enqueue a NIP-09 tombstone, both
/// inside the `managed_agents_store_lock`-held delete body and NEVER across an
/// `.await`.
///
/// Mirrors `commands::personas::tombstone_persona_pending`: the agent row at
/// `(30177, owner, agent_pubkey)` is purged first so an unpublished edit can
/// never resurrect it after the tombstone publishes, then the kind:5 tombstone
/// is retained at its own `(5, owner, agent_pubkey)` coordinate with
/// `pending_sync = 1`. The `d_tag` is the agent's pubkey. Best-effort: a
/// failure is logged and swallowed so a retention hiccup never blocks the
/// disk-authoritative delete.
pub(super) fn tombstone_managed_agent_pending(
    app: &AppHandle,
    state: &AppState,
    agent_pubkey: &str,
) {
    use crate::managed_agents::{
        agent_events::build_agent_delete,
        retention::{
            delete_retained_event, open_retention_db, retain_event, tombstone_retention_d_tag,
            RetainedEvent,
        },
    };
    use buzz_core_pkg::kind::KIND_MANAGED_AGENT;
    use nostr::JsonUtil;

    const KIND_DELETE: u32 = 5;

    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let owner_pubkey = scope.owner_keys.public_key().to_hex();
        let event = build_agent_delete(agent_pubkey, &owner_pubkey)?
            .sign_with_keys(&scope.owner_keys)
            .map_err(|e| format!("failed to sign managed-agent tombstone: {e}"))?;
        let conn = open_retention_db(&scope.db_path)?;
        delete_retained_event(&conn, KIND_MANAGED_AGENT, &owner_pubkey, agent_pubkey)?;
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_DELETE,
                pubkey: owner_pubkey,
                // Key by the target coordinate so cross-kind d-tag tombstones
                // occupy distinct rows (F2c).
                d_tag: tombstone_retention_d_tag(KIND_MANAGED_AGENT, agent_pubkey),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: agent-tombstone: {e}");
    }
}

fn normalize_relay_mesh(
    config: Option<&RelayMeshConfig>,
    backend: &BackendKind,
) -> Result<Option<RelayMeshConfig>, String> {
    let Some(config) = config else {
        return Ok(None);
    };

    let model_ref = config.model_ref.trim();
    if model_ref.is_empty() {
        return Err("Colony shared compute model is required".to_string());
    }
    if backend != &BackendKind::Local {
        return Err("Colony shared compute agents must use the local backend".to_string());
    }

    Ok(Some(RelayMeshConfig {
        model_ref: model_ref.to_string(),
    }))
}

fn trim_to_optional_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn resolve_created_avatar_url(
    requested_avatar_url: Option<&str>,
    persona_avatar_url: Option<String>,
    agent_command: &str,
) -> Option<String> {
    requested_avatar_url
        .and_then(trim_to_optional_string)
        .or_else(|| {
            persona_avatar_url
                .as_deref()
                .and_then(trim_to_optional_string)
        })
        .or_else(|| managed_agent_avatar_url(agent_command))
}

#[cfg(feature = "mesh-llm")]
async fn ensure_relay_mesh_for_record(
    app: &AppHandle,
    model_id: Option<&str>,
    allow_fresh_create_start: bool,
) -> Result<(), String> {
    crate::commands::ensure_relay_mesh_for_record(app, model_id, allow_fresh_create_start).await
}

#[cfg(not(feature = "mesh-llm"))]
async fn ensure_relay_mesh_for_record(
    _app: &AppHandle,
    _model_id: Option<&str>,
    _allow_fresh_create_start: bool,
) -> Result<(), String> {
    Ok(())
}

pub(super) async fn start_local_agent_pairs_with_preflight(
    app: &AppHandle,
    state: &AppState,
    pubkey: &str,
    relay_urls: &[String],
) -> Result<ManagedAgentSummary, String> {
    let record_snapshot = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        load_managed_agents(app)?
            .into_iter()
            .find(|record| record.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?
    };
    if record_snapshot.backend != BackendKind::Local {
        return Err(format!("agent {pubkey} is not a local agent"));
    }
    let personas_for_preflight = load_personas(app).unwrap_or_default();
    let global_for_preflight =
        crate::managed_agents::load_global_agent_config(app).unwrap_or_default();
    let mesh_model_id =
        crate::managed_agents::effective_config::resolve_effective_relay_mesh_model_id(
            &record_snapshot,
            &personas_for_preflight,
            &global_for_preflight,
        );
    ensure_relay_mesh_for_record(app, mesh_model_id.as_deref(), false).await?;

    {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let mut records = load_managed_agents(app)?;
        let record = find_managed_agent_mut(&mut records, pubkey)?;
        let personas = load_personas(app).unwrap_or_default();
        if let Some(persona_id) = record.persona_id.clone() {
            if let Some(persona) = personas.iter().find(|persona| persona.id == persona_id) {
                crate::managed_agents::persona_events::apply_persona_snapshot(record, persona);
                record.updated_at = crate::util::now_iso();
            }
        }
        save_managed_agents(app, &records)?;
        if let Some(saved_record) = records.iter().find(|record| record.pubkey == pubkey) {
            retain_managed_agent_pending(app, state, saved_record);
        }
    }

    let mut errors = Vec::new();
    for relay_url in relay_urls {
        if let Err(error) = crate::managed_agents::start_managed_agent_runtime_pair_lazy(
            pubkey.to_string(),
            relay_url.clone(),
            app.clone(),
        ) {
            errors.push(format!("{relay_url}: {error}"));
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "failed to restart one or more managed-agent runtime pairs: {}",
            errors.join("; ")
        ));
    }

    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let records = load_managed_agents(app)?;
    let runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    let personas = load_personas(app).unwrap_or_default();
    let record = records
        .iter()
        .find(|record| record.pubkey == pubkey)
        .ok_or_else(|| format!("agent {pubkey} not found"))?;
    build_managed_agent_summary(
        app,
        record,
        &runtimes,
        &personas,
        &crate::managed_agents::load_global_agent_config(app).unwrap_or_default(),
    )
}

pub(super) async fn start_local_agent_with_preflight(
    app: &AppHandle,
    state: &AppState,
    pubkey: &str,
    _owner_hex: &str,
    allow_fresh_create_start: bool,
) -> Result<ManagedAgentSummary, String> {
    let record_snapshot = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let records = load_managed_agents(app)?;
        records
            .iter()
            .find(|record| record.pubkey == pubkey)
            .cloned()
            .ok_or_else(|| format!("agent {pubkey} not found"))?
    };

    if record_snapshot.backend != BackendKind::Local {
        return Err(format!("agent {pubkey} is not a local agent"));
    }

    let personas = load_personas(app).unwrap_or_default();
    let global = crate::managed_agents::load_global_agent_config(app).unwrap_or_default();
    let mesh_model_id =
        crate::managed_agents::effective_config::resolve_effective_relay_mesh_model_id(
            &record_snapshot,
            &personas,
            &global,
        );
    ensure_relay_mesh_for_record(app, mesh_model_id.as_deref(), allow_fresh_create_start).await?;

    let (record_relay_pin, personas) = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let mut records = load_managed_agents(app)?;
        let record = find_managed_agent_mut(&mut records, pubkey)?;
        if record.backend != BackendKind::Local {
            return Err(format!("agent {pubkey} is no longer a local agent"));
        }
        let personas = load_personas(app).unwrap_or_default();
        if let Some(persona_id) = record.persona_id.clone() {
            match personas.iter().find(|p| p.id == persona_id) {
                Some(persona) => {
                    crate::managed_agents::persona_events::apply_persona_snapshot(record, persona);
                    record.updated_at = crate::util::now_iso();
                }
                None => {
                    return Err(
                        crate::managed_agents::effective_config::ORPHANED_INSTANCE_ERROR
                            .to_string(),
                    );
                }
            }
        }
        let record_relay_pin = record.relay_url.clone();
        save_managed_agents(app, &records)?;
        if let Some(saved_record) = records.iter().find(|r| r.pubkey == pubkey) {
            retain_managed_agent_pending(app, state, saved_record);
        }
        (record_relay_pin, personas)
    };
    crate::managed_agents::start_managed_agent_runtime_pair_lazy(
        pubkey.to_string(),
        effective_agent_relay_url(&record_relay_pin, &relay_ws_url_with_override(state)),
        app.clone(),
    )?;
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let records = load_managed_agents(app)?;
    let runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    let record = records
        .iter()
        .find(|record| record.pubkey == pubkey)
        .ok_or_else(|| format!("agent {pubkey} not found"))?;
    build_managed_agent_summary(
        app,
        record,
        &runtimes,
        &personas,
        &crate::managed_agents::load_global_agent_config(app).unwrap_or_default(),
    )
}

/// Deploy an agent to a provider backend. Resolves the binary, calls deploy via
/// spawn_blocking, and persists the result (backend_agent_id or last_error).
///
/// Idempotency: calling deploy on an already-deployed agent sends the same payload
/// again. Providers are expected to handle this as an update-in-place or no-op —
/// the protocol does not include an explicit `undeploy` operation (deferred to v2).
///
/// Returns Ok(()) on success, Err(message) on failure. Either way the record is
/// updated and saved before returning.
// These inputs map directly to the provider boundary and its persisted record;
// grouping them would obscure which values are signed payload data, provider
// configuration, cached executable state, and the optional Website scope.
#[allow(clippy::too_many_arguments)]
async fn deploy_to_provider(
    app: &AppHandle,
    state: &AppState,
    pubkey: &str,
    provider_id: &str,
    config: &serde_json::Value,
    agent_json: serde_json::Value,
    cached_binary_path: Option<&str>,
    start_scope: Option<&ManagedAgentStartScope>,
) -> Result<(), String> {
    // Resolve via discovered candidates only. Cached path must match BOTH
    // "is a discovered candidate" AND "belongs to this provider_id". A tampered
    // record cannot redirect deploys to a different provider's binary.
    let bin_path = cached_binary_path
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .map(|p| p.canonicalize().unwrap_or(p))
        .filter(|canonical| {
            discover_provider_candidates().iter().any(|(id, cp)| {
                id == provider_id && cp.canonicalize().ok().as_ref() == Some(canonical)
            })
        })
        .map_or_else(|| resolve_provider_binary(provider_id), Ok)?;

    let config_clone = config.clone();
    let deploy_result =
        tokio::task::spawn_blocking(move || provider_deploy(&bin_path, &agent_json, &config_clone))
            .await
            .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    // A Website start carries the owner and relay captured before the async
    // provider call. The provider protocol has no undeploy/compensation
    // operation, so retain its result under the captured record before
    // returning a late scope error to the stale caller. This leaves the
    // backend id available for retry or owner cleanup.
    let scope_error = start_scope.and_then(|scope| scope.check_current(state).err());

    // Persist result under lock.
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(app)?;
    let workspace_relay = relay_ws_url_with_override(state);
    let rec = records
        .iter_mut()
        .find(|r| {
            r.pubkey == pubkey
                && start_scope
                    .map(|scope| scope.check_record(r, &workspace_relay).is_ok())
                    .unwrap_or(true)
        })
        .ok_or_else(|| {
            if start_scope.is_some() {
                format!("agent {pubkey} is not present in the captured account and business")
            } else {
                format!("agent {pubkey} not found")
            }
        })?;

    let persist_result = match deploy_result {
        Ok(backend_agent_id) => {
            rec.backend_agent_id = Some(backend_agent_id);
            rec.last_started_at = Some(now_iso());
            rec.updated_at = now_iso();
            rec.last_error = None;
            Ok(())
        }
        Err(ref e) => {
            rec.last_error = Some(e.clone());
            rec.updated_at = now_iso();
            Err(e.clone())
        }
    };
    save_managed_agents(app, &records)?;
    if let Some(scope_error) = scope_error {
        return Err(scope_error);
    }
    persist_result
}

mod create;
pub(crate) use create::{
    create_managed_agent_with_creation_request, create_managed_agent_with_preparation,
};

/// The owner and relay a Website provider start must keep for the whole
/// deployment boundary. Generic agent starts remain legacy and unscoped.
struct ManagedAgentStartScope {
    owner_pubkey: String,
    relay_url: String,
}

impl ManagedAgentStartScope {
    fn capture(
        expected_owner_pubkey: String,
        expected_relay_url: String,
        actual_owner_pubkey: &str,
        actual_relay_url: &str,
    ) -> Result<Self, String> {
        let owner_pubkey = expected_owner_pubkey.trim().to_ascii_lowercase();
        if owner_pubkey.len() != 64
            || !owner_pubkey
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("A signed-in account is required to start this Website teammate.".into());
        }
        let relay_url = buzz_core_pkg::relay::normalize_relay_url(&expected_relay_url)
            .map_err(|_| "A business connection is required to start this Website teammate.")?;
        let actual_relay_url = buzz_core_pkg::relay::normalize_relay_url(actual_relay_url)
            .map_err(|_| "The account or business changed while starting this teammate.")?;
        if owner_pubkey != actual_owner_pubkey.trim().to_ascii_lowercase()
            || relay_url != actual_relay_url
        {
            return Err(
                "The account or business changed while starting this teammate. Return to the original business and try again.".into(),
            );
        }
        Ok(Self {
            owner_pubkey,
            relay_url,
        })
    }

    fn check_current(&self, state: &AppState) -> Result<(), String> {
        let actual_owner_pubkey = workspace_owner_hex(state)?;
        let actual_relay_url = relay_ws_url_with_override(state);
        let actual_relay_url = buzz_core_pkg::relay::normalize_relay_url(&actual_relay_url)
            .map_err(|_| "The account or business changed while starting this teammate.")?;
        if self.owner_pubkey != actual_owner_pubkey.trim().to_ascii_lowercase()
            || self.relay_url != actual_relay_url
        {
            return Err(
                "The account or business changed while starting this teammate. Return to the original business and try again.".into(),
            );
        }
        Ok(())
    }

    fn check_record(
        &self,
        record: &crate::managed_agents::ManagedAgentRecord,
        workspace_relay: &str,
    ) -> Result<(), String> {
        if crate::managed_agents::owner_scope::effective_owner_pubkey(record).as_deref()
            != Some(self.owner_pubkey.as_str())
        {
            return Err("This Website teammate is not approved for the selected account.".into());
        }
        let record_relay =
            crate::relay::effective_agent_relay_url(&record.relay_url, workspace_relay);
        let record_relay = buzz_core_pkg::relay::normalize_relay_url(&record_relay)
            .map_err(|_| "This Website teammate is not assigned to the selected business.")?;
        if record_relay != self.relay_url {
            return Err("This Website teammate is not assigned to the selected business.".into());
        }
        Ok(())
    }
}

/// Start one managed agent and reconcile its profile in the background.
///
/// Website provider starts may pass the owner and relay captured by setup;
/// those optional fields are paired and checked before and after deployment.
/// Existing generic starts omit them and retain their legacy behavior.
#[tauri::command]
pub async fn start_managed_agent(
    pubkey: String,
    expected_owner_pubkey: Option<String>,
    expected_relay_url: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ManagedAgentSummary, String> {
    if expected_owner_pubkey.is_some() != expected_relay_url.is_some() {
        return Err(
            "Starting a Website teammate requires the original account and business.".into(),
        );
    }

    // Workspace apply takes the write side before changing the active relay.
    // Holding the read side across a scoped provider deployment keeps the
    // captured business stable; the owner is rechecked at every async
    // boundary because identity changes use a separate mutex.
    let _community_guard = if expected_owner_pubkey.is_some() {
        Some(state.community_operation_lock.read().await)
    } else {
        None
    };
    // Snapshot the workspace owner pubkey for the legacy auth_tag fallback.
    // Read outside the records lock to keep lock ordering simple.
    let owner_hex = workspace_owner_hex(&state)?;
    let start_scope = match (expected_owner_pubkey, expected_relay_url) {
        (Some(expected_owner), Some(expected_relay)) => Some(ManagedAgentStartScope::capture(
            expected_owner,
            expected_relay,
            &owner_hex,
            &relay_ws_url_with_override(&state),
        )?),
        (None, None) => None,
        _ => {
            return Err(
                "Starting a Website teammate requires the original account and business.".into(),
            )
        }
    };
    enum StartTarget {
        Local,
        Provider {
            backend: BackendKind,
            cached_binary_path: Option<String>,
            agent_json: serde_json::Value,
        },
    }

    // Collect backend info under lock; async preflight/spawn happens below.
    // Also snapshot profile reconciliation data for the background task.
    let (target, reconcile_data) = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut records = load_managed_agents(&app)?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;

        let (sync_changed, exited_pubkeys) =
            sync_managed_agent_processes(&mut records, &mut runtimes, &current_instance_id(&app));
        if sync_changed {
            save_managed_agents(&app, &records)?;
        }
        for pubkey in &exited_pubkeys {
            state.clear_agent_session_caches(pubkey);
        }

        let record = find_managed_agent_mut(&mut records, &pubkey)?;
        if let Some(scope) = &start_scope {
            // The scoped path is currently used by Website's provider branch;
            // local Website pairs use start_managed_agent_runtime, which has
            // its own owner/relay-fenced command.
            if record.backend == BackendKind::Local {
                return Err(
                    "Website local coordinators must use their pair-scoped runtime start.".into(),
                );
            }
            scope.check_record(record, &relay_ws_url_with_override(&state))?;
        }

        // An employee Colony provides runs the `buzz` this build ships, and a
        // brief naming a command that binary lacks is broken before it starts:
        // the agent reaches for something adjacent and produces work nobody
        // can act on. Checked HERE and not only at adoption, because the app
        // can be downgraded under a record a newer build wrote. Absent and
        // explained beats started and improvising.
        if !record.provisioned_requires_commands.is_empty() {
            let available =
                crate::commands::available_cli_commands(&record.provisioned_requires_commands);
            let missing = crate::managed_agents::provisioned::missing_commands(
                &record.provisioned_requires_commands,
                &available,
            );
            if !missing.is_empty() {
                return Err(
                    crate::managed_agents::provisioned::missing_commands_message(
                        &record.name,
                        &missing,
                    ),
                );
            }
        }

        // Profile reconcile: the carrier builder resolves the effective
        // harness through the one inheritance chain (the create-time snapshot
        // may be empty or stale for a persona-inherited harness).
        let reconcile_personas = load_personas(&app).unwrap_or_default();
        let reconcile = ProfileReconcileData::build(&app, record, &reconcile_personas);

        let target = if record.backend == BackendKind::Local {
            StartTarget::Local
        } else {
            StartTarget::Provider {
                backend: record.backend.clone(),
                cached_binary_path: record.provider_binary_path.clone(),
                agent_json: if let Some(scope) = &start_scope {
                    build_deploy_payload_for_owner(&app, &state, record, &scope.owner_pubkey)?
                } else {
                    build_deploy_payload(&app, &state, record)?
                },
            }
        };

        (target, reconcile)
    };

    let result = match target {
        StartTarget::Local => {
            start_local_agent_with_preflight(&app, &state, &pubkey, &owner_hex, false).await
        }
        StartTarget::Provider {
            backend: BackendKind::Provider { id, config },
            cached_binary_path,
            agent_json,
        } => {
            deploy_to_provider(
                &app,
                &state,
                &pubkey,
                &id,
                &config,
                agent_json,
                cached_binary_path.as_deref(),
                start_scope.as_ref(),
            )
            .await?;

            // Return updated summary.
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|e| e.to_string())?;
            let records = load_managed_agents(&app)?;
            let runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|e| e.to_string())?;
            let workspace_relay = relay_ws_url_with_override(&state);
            let record = records
                .iter()
                .find(|r| {
                    r.pubkey == pubkey
                        && start_scope
                            .as_ref()
                            .map(|scope| scope.check_record(r, &workspace_relay).is_ok())
                            .unwrap_or(true)
                })
                .ok_or_else(|| format!("agent {pubkey} not found"))?;
            let personas = load_personas(&app).unwrap_or_default();
            build_managed_agent_summary(
                &app,
                record,
                &runtimes,
                &personas,
                &crate::managed_agents::load_global_agent_config(&app).unwrap_or_default(),
            )
        }
        StartTarget::Provider { backend, .. } => Err(format!(
            "agent {pubkey} has unsupported backend kind: {backend:?}"
        )),
    };

    if result.is_ok() {
        if let Some(scope) = &start_scope {
            scope.check_current(&state)?;
        }
    }

    // ── Profile reconciliation (fire-and-forget) ────────────────────────────
    // On successful start, spawn a background task to ensure the agent's kind:0
    // profile is published on the relay. This self-heals cases where the initial
    // profile sync at creation time failed silently. For legacy records (pre-PR-921)
    // with no persisted avatar, this also backfills the avatar from the relay.
    if result.is_ok()
        && state
            .managed_agent_profile_reconcile_enabled
            .load(std::sync::atomic::Ordering::Acquire)
    {
        let reconcile_pubkey = pubkey.clone();
        let reconcile_app = app.clone();
        tauri::async_runtime::spawn(async move {
            use tauri::Manager;
            let state = reconcile_app.state::<AppState>();
            if let Err(e) =
                reconcile_agent_profile(&state, &reconcile_app, &reconcile_pubkey, &reconcile_data)
                    .await
            {
                eprintln!(
                    "buzz-desktop: profile reconciliation failed for agent {reconcile_pubkey}: {e}"
                );
            }
        });
    }

    result
}

#[tauri::command]
pub async fn stop_managed_agent(
    pubkey: String,
    app: AppHandle,
) -> Result<ManagedAgentSummary, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut records = load_managed_agents(&app)?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;

        let (sync_changed, exited_pubkeys) =
            sync_managed_agent_processes(&mut records, &mut runtimes, &current_instance_id(&app));
        if sync_changed {
            save_managed_agents(&app, &records)?;
        }
        for pubkey in &exited_pubkeys {
            state.clear_agent_session_caches(pubkey);
        }

        {
            let record = find_managed_agent_mut(&mut records, &pubkey)?;
            // Remote agents are stopped via !shutdown @mention from the frontend,
            // not via this backend command. Reject the call.
            if record.backend != BackendKind::Local {
                return Err(
                    "remote agents are stopped via !shutdown message, not this command".to_string(),
                );
            }
            // Pair-scoped: stops only the active workspace's pair; delete and
            // the config-restart flows still drain every pair.
            stop_managed_agent_workspace_pair(&app, record, &mut runtimes)?;
        }
        save_managed_agents(&app, &records)?;
        let record = records
            .iter()
            .find(|record| record.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?;
        let personas = load_personas(&app).unwrap_or_default();
        build_managed_agent_summary(
            &app,
            record,
            &runtimes,
            &personas,
            &crate::managed_agents::load_global_agent_config(&app).unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Refuse deletion of an agent record the owner cannot remove.
///
/// Provisioned agents are provided by Colony: the owner cannot delete them,
/// and the refusal names the agent and the product. Deployed remote agents
/// additionally need an explicit force so a caller cannot silently orphan
/// remote infrastructure. Pure so both refusals are unit-testable without an
/// `AppHandle`; the delete command calls this before it stops or removes
/// anything.
fn validate_managed_agent_deletion(
    record: &crate::managed_agents::ManagedAgentRecord,
    force_remote_delete: bool,
) -> Result<(), String> {
    if record.backend != BackendKind::Local
        && record.backend_agent_id.is_some()
        && !force_remote_delete
    {
        return Err(
            "cannot delete a deployed remote agent without force_remote_delete: true".to_string(),
        );
    }

    Ok(())
}

// Async so the blocking body (disk reads/writes, process termination, keyring
// delete, nest regeneration) runs off the main UI thread via spawn_blocking.
#[tauri::command]
pub async fn delete_managed_agent(
    pubkey: String,
    force_remote_delete: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let mut records = load_managed_agents(&app)?;
            let mut runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|error| error.to_string())?;

            let (sync_changed, exited_pubkeys) = sync_managed_agent_processes(
                &mut records,
                &mut runtimes,
                &current_instance_id(&app),
            );
            if sync_changed {
                save_managed_agents(&app, &records)?;
            }
            for pubkey in &exited_pubkeys {
                state.clear_agent_session_caches(pubkey);
            }

            // Guard: an employee Colony provides is not the workspace's to
            // delete. Ingest refuses every destructive path anyway, so a
            // delete here could only drop this machine's copy and leave the
            // employee standing, and the next community init would adopt it
            // straight back: a confusing no-op rather than an outcome. The
            // same refusal covers a pack this app installed, which is the
            // other way a record arrives already provided.
            //
            // Then the deployed-remote check, which the frontend clears only
            // after the user confirms the orphan warning. Both run before
            // anything is stopped or removed, so a buggy or compromised IPC
            // caller cannot bypass either.
            if let Some(record) = records.iter().find(|r| r.pubkey == pubkey) {
                crate::managed_agents::provisioned::refuse_delete_if_provisioned(record)?;
            }

            if let Some(record) = records.iter().find(|r| r.pubkey == pubkey) {
                validate_managed_agent_deletion(record, force_remote_delete.unwrap_or(false))?;
            }

            if let Some(record) = records.iter_mut().find(|record| record.pubkey == pubkey) {
                stop_managed_agent_process(&app, record, &mut runtimes)?;
            }
            state.clear_agent_session_caches(&pubkey);
            let initial_len = records.len();
            records.retain(|record| record.pubkey != pubkey);
            if records.len() == initial_len {
                return Err(format!("agent {pubkey} not found"));
            }
            save_managed_agents(&app, &records)?;
            // Remove the agent's nsec from the keyring after the record is gone.
            crate::managed_agents::delete_agent_key(&pubkey);
            // Tombstone-after-validation: only reached past the deployed-remote
            // guard above and a confirmed removal — never orphan a live remote
            // deployment's relay record. Inside the lock, before the block closes
            // (no .await here). Every agent published, so every delete tombstones.
            tombstone_managed_agent_pending(&app, &state, &pubkey);
            // NIP-IA: archive the deleted agent's identity on the relay so it
            // stops appearing in member pickers and autocomplete. Same
            // best-effort, inside-the-lock contract as the tombstone above.
            archive_managed_agent_pending(&app, &state, &pubkey);
        }
        try_regenerate_nest(&app);
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

// Remote agent shutdown is handled entirely by the frontend:
// 1. Frontend sends "!shutdown" @mention via WebSocket (signed by user's key)
// 2. Harness sees it, exits gracefully, sets presence to "offline"
// 3. Desktop's existing presence polling sees "offline" — UI updates automatically
// No backend Tauri command needed. Presence IS the status.
#[path = "agents_deploy.rs"]
mod deploy;
pub(super) mod provider_access;
use deploy::{build_deploy_payload, build_deploy_payload_for_owner};
#[cfg(test)]
use deploy::{deploy_payload_json, DeployProjections};
#[cfg(test)]
use deploy::{ensure_remote_provider_supported, resolve_deploy_model_provider};

#[path = "agents_archive.rs"]
mod archive;
pub(super) use archive::archive_managed_agent_pending;
#[cfg(test)]
use archive::build_agent_archive_request;

#[path = "agents_profile.rs"]
mod profile;
pub(super) use profile::workspace_owner_hex;
#[cfg(test)]
use profile::{profile_needs_sync, resolve_legacy_avatar};
pub(crate) use profile::{reconcile_agent_profile, reconcile_profile_at, ProfileReconcileData};

#[cfg(test)]
#[path = "agents_tests.rs"]
mod tests;
