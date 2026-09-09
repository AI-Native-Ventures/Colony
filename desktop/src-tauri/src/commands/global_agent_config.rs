//! Tauri commands for global agent configuration defaults.
//!
//! `get_global_agent_config` / `set_global_agent_config` — simple load/save
//! around the `global_config` module with the standard save-time validation.
//!
//! `set_global_agent_config` additionally auto-restarts any running local agent
//! whose effective env changes under the new global config — including agents
//! that were in setup-listener mode (`NotReady`) but become `Ready`, and agents
//! already running whose provider/model/env vars change.  This is the only
//! honest way to deliver new env vars to a running process — the env is baked
//! at spawn time and cannot be mutated in place.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{
        agent_readiness, current_instance_id, find_managed_agent_mut, known_acp_runtime,
        load_global_agent_config, load_managed_agents, load_personas, record_agent_command,
        resolve_effective_agent_env, save_managed_agents, stop_managed_agent_process,
        sync_managed_agent_processes, validate_global_config, AgentReadiness, BackendKind,
        CredentialMode, GlobalAgentConfig,
    },
};

mod restart_policy;
mod restart_readiness;

/// Result returned by `set_global_agent_config`.
///
/// Carries the canonical saved config together with restart counts. Use
/// `restarted_count` for "Restarted N agent(s)." feedback and
/// `failed_restart_count` to surface partial failures ("M failed to restart").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalAgentConfigSaveResult {
    /// The persisted global config (after strip-on-write).
    pub config: GlobalAgentConfig,
    /// Number of local agents successfully stopped and restarted.
    pub restarted_count: u32,
    /// Number of agents whose running process could not adopt the saved config.
    pub failed_restart_count: u32,
}

/// Optional caller context for a save that must belong to one onboarding session.
#[derive(Clone)]
struct ConfigSaveScope {
    owner: String,
    relay: String,
}

impl ConfigSaveScope {
    fn parse(owner: Option<String>, relay: Option<String>) -> Result<Option<Self>, String> {
        match (owner, relay) {
            (None, None) => Ok(None),
            (Some(owner), Some(relay)) if crate::company::transaction::is_event_id(&owner) => {
                Ok(Some(Self {
                    owner,
                    relay: buzz_core_pkg::relay::normalize_relay_url(&relay)
                        .map_err(|error| error.to_string())?,
                }))
            }
            _ => Err(
                "Saving agent defaults requires the original account and business connection."
                    .into(),
            ),
        }
    }

    fn check(&self, state: &AppState) -> Result<(), String> {
        if state
            .reset_failed
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Account recovery must finish before saving agent defaults.".into());
        }
        let owner = state.signing_keys()?.public_key().to_hex();
        let relay = state
            .relay_url_override
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_else(crate::relay::relay_ws_url);
        if owner != self.owner
            || buzz_core_pkg::relay::normalize_relay_url(&relay)
                .map_err(|error| error.to_string())?
                != self.relay
        {
            return Err("The account or business changed while saving agent defaults. Return to the original business and try again.".into());
        }
        Ok(())
    }

    fn owns_agent(&self, owner: Option<&str>, relay: &str) -> bool {
        owner.is_some_and(|owner| owner.eq_ignore_ascii_case(&self.owner))
            && buzz_core_pkg::relay::normalize_relay_url(relay)
                .ok()
                .as_deref()
                == Some(self.relay.as_str())
    }

    fn permits_restart_pairs(
        &self,
        keys: &[crate::managed_agents::ManagedAgentRuntimeKey],
    ) -> bool {
        // The legacy stop helper stops all pairs. Do not use it when even one
        // other community would be affected by a scoped onboarding save.
        keys.len() == 1 && keys[0].relay_url == self.relay
    }
}

/// Serialize a scoped disk write or stop with both forms of context change.
/// Runs only synchronously (in spawn_blocking); never holds guards across awaits.
fn with_config_save_scope<T>(
    state: &AppState,
    scope: Option<&ConfigSaveScope>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let Some(scope) = scope else {
        return operation();
    };
    // apply_community holds the write guard and may change both relay and keys;
    // import_identity uses identity_mutation independently of community changes.
    let _community_guard = state.community_operation_lock.blocking_read();
    let _identity_guard = state
        .identity_mutation
        .lock()
        .map_err(|error| error.to_string())?;
    scope.check(state)?;
    operation()
}

/// Read the current global agent configuration.
///
/// Returns the default (empty) config if `global-agent-config.json` has not
/// been written yet.
#[tauri::command]
pub fn get_global_agent_config(app: AppHandle) -> Result<GlobalAgentConfig, String> {
    load_global_agent_config(&app)
}

/// Validate and persist a new global agent configuration, then auto-restart
/// any running local agent whose effective env changes under the new config
/// (including setup-listener agents whose readiness flips to `Ready`).
///
/// Strips empty env values before writing (empty = "inherit" semantics), then
/// applies standard validation: POSIX key shape, reserved-key reject,
/// derived-provider-model-key reject, NUL/size caps.
///
/// Restart is best-effort: failures are counted without failing a completed
/// save. Unscoped restarts also persist `last_error`; scoped saves avoid writing
/// agent errors after the owner has changed. Returns the saved config and
/// the count of agents successfully restarted. Optional expected owner/relay
/// fields must be supplied together. They fence the disk write and restrict
/// restarts to that account's active community; omitted fields preserve legacy
/// global restart behavior.
#[tauri::command]
pub async fn set_global_agent_config(
    config: GlobalAgentConfig,
    expected_owner_pubkey: Option<String>,
    expected_relay_url: Option<String>,
    app: AppHandle,
) -> Result<GlobalAgentConfigSaveResult, String> {
    let scope = ConfigSaveScope::parse(expected_owner_pubkey, expected_relay_url)?;
    // ── Phase 1: disk write (sync, spawn_blocking) ────────────────────────
    //
    // Validate, snapshot old config, write new config, collect live local
    // candidates with changed Power settings or an unadopted saved choice.
    // The candidate list is a hint — eligibility is re-checked under
    // lock in Phase 2 after sync_managed_agent_processes.
    let app_for_write = app.clone();
    let scope_for_write = scope.clone();
    let phase1 = tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        let state = app_for_write.state::<AppState>();
        with_config_save_scope(&state, scope_for_write.as_ref(), || {
            validate_global_config(&config)?;
            validate_provisioned_mode_eligibility(&config)?;

            let old_global = load_global_agent_config(&app_for_write)?;

            // Return this publication's normalized value, never a later writer's.
            let new_global =
                crate::managed_agents::global_config::save_global_agent_config_canonical(
                    &app_for_write,
                    &config,
                )?;

            // Pre-filter before the agent store lock. Scoped context guards are
            // already held; definitive runtime eligibility is rechecked in Phase 2.
            let (candidates, personas_snapshot) = collect_restart_candidates(
                &app_for_write,
                &old_global,
                &new_global,
                scope_for_write.as_ref(),
            )?;

            Ok::<_, String>((new_global, old_global, candidates, personas_snapshot))
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;
    let (new_global, old_global, candidates, personas_snapshot) = phase1;

    // ── Phase 2: async restart (outside spawn_blocking) ──────────────────
    //
    // For each candidate: stop under the lock (re-verifying eligibility after
    // sync_managed_agent_processes), then start via start_local_agent_with_preflight
    // — the same path as a manual restart.  This ensures owner_hex is computed
    // and passed (NIP-OA auth_tag fallback), the persona is re-snapshotted, and
    // last_error is persisted on failure.
    //
    // Errors are non-fatal; the caller always receives the saved config.
    // failed_restart_count surfaces failed retirement and failed replacement starts.
    let mut restarted_count: u32 = 0;
    let mut failed_restart_count: u32 = 0;
    if !candidates.is_empty() {
        for pubkey in &candidates {
            let outcome = restart_local_agent_on_config_change(
                &app,
                pubkey,
                &old_global,
                &new_global,
                &personas_snapshot,
                scope.as_ref(),
            )
            .await;
            match outcome {
                RestartOutcome::Restarted => restarted_count += 1,
                RestartOutcome::AlreadyAdopted => {}
                RestartOutcome::Failed => failed_restart_count += 1,
            }
        }
    }

    if let Some(scope) = &scope {
        let (app, scope, expected) = (app.clone(), scope.clone(), new_global.clone());
        tokio::task::spawn_blocking(move || {
            use tauri::Manager;
            with_config_save_scope(&app.state::<AppState>(), Some(&scope), || {
                let _publication =
                    crate::managed_agents::global_config::publication::lock_expected(
                        &expected,
                        || load_global_agent_config(&app),
                    )?;
                Ok(())
            })
        })
        .await
        .map_err(|_| "Could not confirm the saved Power choice. Try again.".to_string())??;
    }

    Ok(GlobalAgentConfigSaveResult {
        config: new_global,
        restarted_count,
        failed_restart_count,
    })
}

/// Outcome of a single per-agent restart attempt in Phase 2.
#[derive(Debug)]
enum RestartOutcome {
    /// Stop succeeded and the agent re-launched with the new config.
    Restarted,
    /// Another save already replaced the process with the requested Power choice.
    AlreadyAdopted,
    /// The previous process could not be retired or the replacement could not start.
    Failed,
}

/// Collect pubkeys of local agents that should be restarted after a global
/// config change, together with the personas snapshot used for the scan.
///
/// Pre-lock hint used by Phase 1 of `set_global_agent_config`. Eligibility is
/// re-verified under lock in Phase 2. The personas snapshot is threaded to
/// `restart_local_agent_on_config_change` so it is not reloaded per agent.
///
/// Candidates have a live local process whose effective Power selection has
/// changed, whose stamped launch settings differ from the requested choice, or
/// whose normal connection has just become ready. The stamped comparison also
/// catches retrying a save after an earlier process stop failed.
fn collect_restart_candidates(
    app: &AppHandle,
    old_global: &GlobalAgentConfig,
    new_global: &GlobalAgentConfig,
    scope: Option<&ConfigSaveScope>,
) -> Result<(Vec<String>, Vec<crate::managed_agents::AgentDefinition>), String> {
    let records = load_managed_agents(app).map_err(|_| "Power was saved, but running teammates could not be checked. Stop them in Agents before continuing.".to_string())?;
    let all_personas = load_personas(app).map_err(|_| "Power was saved, but teammate settings could not be checked. Stop running teammates in Agents before continuing.".to_string())?;
    use tauri::Manager;
    let state = app.state::<AppState>();
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .unwrap_or_else(|error| error.into_inner());

    let candidates = records
        .iter()
        .filter(|record| {
            if record.backend != BackendKind::Local
                || scope.is_some_and(|scope| {
                    !scope.owns_agent(
                        crate::managed_agents::owner_scope::effective_owner_pubkey(record)
                            .as_deref(),
                        &record.relay_url,
                    )
                })
            {
                return false;
            }
            let mut has_live_runtime = false;
            let mut has_provisioned_runtime = false;
            let mut has_power_drift = false;
            for (key, runtime) in runtimes.iter_mut() {
                if key.pubkey.eq_ignore_ascii_case(&record.pubkey)
                    && runtime.child.try_wait().ok().flatten().is_none()
                {
                    has_live_runtime = true;
                    has_provisioned_runtime |= runtime.provisioned_lease.is_some();
                    has_power_drift |= restart_policy::running_power_differs(
                        record,
                        &all_personas,
                        new_global,
                        &runtime.spawn_config,
                        runtime.provisioned_lease.is_some(),
                    );
                }
            }
            if !has_live_runtime {
                return false;
            }
            has_power_drift
                || restart_policy::required(
                    record,
                    &all_personas,
                    old_global,
                    new_global,
                    has_provisioned_runtime,
                )
        })
        .map(|r| r.pubkey.clone())
        .collect();

    Ok((candidates, all_personas))
}

/// Stop-then-start a local agent whose effective env changed under the new
/// global config.
///
/// This is the per-agent restart step in Phase 2 of `set_global_agent_config`.
/// It mirrors the semantics of a manual agent restart:
///
/// 1. **Stop under lock** — acquires the store lock, calls
///    `sync_managed_agent_processes`, re-verifies eligibility (local backend,
///    live process, effective env changed or readiness transition), then stops
///    the process and saves the record.  The lock is released before the start
///    so `start_local_agent_with_preflight` can re-acquire it cleanly.
///    `personas_snapshot` is reused here instead of loading from disk again.
///
/// 2. **Start via the normal preflight path** — calls
///    `start_local_agent_with_preflight`, which computes and passes `owner_hex`
///    (NIP-OA fallback for legacy records without `auth_tag`), re-snapshots the
///    persona (agent starts with current persona config), saves the updated
///    record, and retains the event for relay sync.  On failure, `last_error` is
///    persisted under lock so the UI surfaces a diagnosable stopped state.
///
/// All errors are logged to stderr. Returns `RestartOutcome::Failed`
/// when retirement or replacement fails — the caller surfaces this as
/// `failed_restart_count` so the UI can prompt the user to check the Agents tab.
async fn restart_local_agent_on_config_change(
    app: &AppHandle,
    pubkey: &str,
    old_global: &GlobalAgentConfig,
    new_global: &GlobalAgentConfig,
    personas_snapshot: &[crate::managed_agents::AgentDefinition],
    scope: Option<&ConfigSaveScope>,
) -> RestartOutcome {
    // ── Step 1: stop under lock, re-verifying eligibility ─────────────────
    let app_for_stop = app.clone();
    let pubkey_owned = pubkey.to_string();
    let old_global_clone = old_global.clone();
    let new_global_clone = new_global.clone();
    let personas_owned = personas_snapshot.to_vec();
    let scope_for_stop = scope.cloned();

    let stop_result = tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        let state = app_for_stop.state::<AppState>();
        with_config_save_scope(&state, scope_for_stop.as_ref(), || {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|e| format!("failed to acquire store lock: {e}"))?;
            let _publication = crate::managed_agents::global_config::publication::lock_expected(
                &new_global_clone, || load_global_agent_config(&app_for_stop),
            )?;

            let mut records = load_managed_agents(&app_for_stop)?;
            let mut runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|e| format!("failed to acquire runtimes lock: {e}"))?;

            // Sync process state so PID liveness reflects current reality.
            let (sync_changed, _) = sync_managed_agent_processes(
                &mut records,
                &mut runtimes,
                &current_instance_id(&app_for_stop),
            );
            if sync_changed {
                save_managed_agents(&app_for_stop, &records)?;
            }

            // Re-check eligibility under lock with current record state.
            let record = records
                .iter()
                .find(|r| r.pubkey == pubkey_owned)
                .ok_or_else(|| format!("agent {pubkey_owned} not found"))?;

            if record.backend != BackendKind::Local {
                return Err(format!("agent {pubkey_owned} is no longer a local agent"));
            }
            let runtime_keys =
                crate::managed_agents::managed_agent_runtime_keys(&runtimes, &pubkey_owned);
            if runtime_keys.is_empty() {
                return Err(format!(
                    "agent {pubkey_owned} no longer has a live pair runtime after sync"
                ));
            }
            if let Some(scope) = &scope_for_stop {
                if !scope.owns_agent(
                    crate::managed_agents::owner_scope::effective_owner_pubkey(record).as_deref(),
                    &record.relay_url,
                ) || !scope.permits_restart_pairs(&runtime_keys) {
                    return Err(
                        "This agent has a different account or business; its running work was left unchanged."
                            .into(),
                    );
                }
            }
            let has_provisioned_runtime = runtime_keys.iter().any(|key| {
                runtimes
                    .get(key)
                    .and_then(|runtime| runtime.provisioned_lease.as_ref())
                    .is_some()
            });
            let has_power_drift = runtime_keys.iter().any(|key| {
                runtimes.get(key).is_some_and(|runtime| restart_policy::running_power_differs(
                    record, &personas_owned, &new_global_clone, &runtime.spawn_config,
                    runtime.provisioned_lease.is_some(),
                ))
            });
            let has_setup_runtime = runtime_keys.iter().any(|key| {
                runtimes.get(key).is_some_and(|runtime| runtime.setup_mode)
            });
            if restart_policy::already_adopted(has_power_drift, has_setup_runtime) {
                return Ok(None);
            }
            if !has_power_drift && !restart_policy::required(record, &personas_owned, &old_global_clone, &new_global_clone, has_provisioned_runtime) {
                return Err(format!("agent {pubkey_owned} restart condition no longer valid under lock"));
            }
            // Stop the process.
            let record_mut = find_managed_agent_mut(&mut records, &pubkey_owned)?;
            stop_managed_agent_process(&app_for_stop, record_mut, &mut runtimes)?;
            save_managed_agents(&app_for_stop, &records)?;

            Ok(Some(runtime_keys))
        })
    })
    .await;

    let runtime_keys = match stop_result {
        Ok(Ok(Some(runtime_keys))) => runtime_keys,
        Ok(Ok(None)) => return RestartOutcome::AlreadyAdopted,
        Ok(Err(e)) => {
            eprintln!("buzz-desktop: set_global_agent_config: could not retire {pubkey}: {e}");
            return RestartOutcome::Failed;
        }
        Err(e) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: spawn_blocking failed for stop of {pubkey}: {e}"
            );
            return RestartOutcome::Failed;
        }
    };

    // The old process is already stopped. Check the new dedicated connection
    // without third-party adapter or host-login probes before restarting it.
    if let Err(error) =
        restart_readiness::ensure_ready(app, pubkey, new_global, &runtime_keys, scope).await
    {
        eprintln!("buzz-desktop: defaults restart is not ready: {error}");
        if let Err(save_error) = persist_restart_error(app, pubkey, &error, new_global, scope).await
        {
            eprintln!("buzz-desktop: defaults restart error could not be saved: {save_error}");
        }
        return RestartOutcome::Failed;
    }

    if let Some(scope) = scope {
        let app_for_start = app.clone();
        let pubkey_for_start = pubkey.to_owned();
        let scope_for_start = scope.clone();
        let expected_global = new_global.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            use tauri::Manager;
            {
                let state = app_for_start.state::<AppState>();
                with_config_save_scope(&state, Some(&scope_for_start), || {
                    if load_global_agent_config(&app_for_start)? != expected_global {
                        return Err("Power settings changed again. Review the saved connection and try again.".into());
                    }
                    Ok(())
                })?;
            }
            // The pair-start boundary checks this exact config during spawn
            // and registration; no identity guard spans lease network I/O.
            crate::managed_agents::start_managed_agent_runtime_with_config(
                pubkey_for_start,
                scope_for_start.relay,
                scope_for_start.owner,
                expected_global,
                app_for_start,
            )
        })
        .await;
        return match outcome {
            Ok(Ok(_)) => RestartOutcome::Restarted,
            Ok(Err(error)) => {
                eprintln!("buzz-desktop: scoped defaults restart failed: {error}");
                let _ = persist_restart_error(app, pubkey, &error, new_global, Some(scope)).await;
                RestartOutcome::Failed
            }
            Err(error) => {
                eprintln!("buzz-desktop: scoped defaults restart task failed: {error}");
                RestartOutcome::Failed
            }
        };
    }

    let relay_urls: Vec<_> = runtime_keys.into_iter().map(|key| key.relay_url).collect();
    use tauri::Manager;
    let state = app.state::<AppState>();
    match super::agents::start_local_agent_pairs_with_preflight(app, &state, pubkey, &relay_urls)
        .await
    {
        Ok(_) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: restarted agent {pubkey} with updated config"
            );
            RestartOutcome::Restarted
        }
        Err(e) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: failed to start {pubkey} after restart: {e}"
            );
            if let Err(save_err) = persist_restart_error(app, pubkey, &e, new_global, None).await {
                eprintln!(
                    "buzz-desktop: set_global_agent_config: failed to persist last_error for {pubkey}: {save_err}"
                );
            }
            RestartOutcome::Failed
        }
    }
}

/// Persist a `last_error` on the agent record under the store lock.
///
/// Retain only a still-current failure on a stopped teammate. A later settings
/// save or live generation takes precedence over an older restart failure.
async fn persist_restart_error(
    app: &AppHandle,
    pubkey: &str,
    error: &str,
    expected: &GlobalAgentConfig,
    scope: Option<&ConfigSaveScope>,
) -> Result<(), String> {
    let (app, pubkey, error, expected, scope) = (
        app.clone(),
        pubkey.to_owned(),
        error.to_owned(),
        expected.clone(),
        scope.cloned(),
    );
    tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        with_config_save_scope(&state, scope.as_ref(), || {
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|e| e.to_string())?;
            // Card edits already take store → publication. Keep that order,
            // and hold publication through the error write so a new Power save
            // cannot make this failure stale between comparison and persistence.
            let _publication = crate::managed_agents::global_config::publication::lock()?;
            let current = load_global_agent_config(&app)?;
            if current != expected {
                return Ok(());
            }
            let mut runtimes = state
                .managed_agent_processes
                .lock()
                .map_err(|e| e.to_string())?;
            // last_error is record-wide, so protect every live pair for this
            // pubkey, even when the failed save targeted only one community.
            let has_live_runtime = runtimes.iter_mut().any(|(key, runtime)| {
                key.pubkey.eq_ignore_ascii_case(&pubkey)
                    && runtime.child.try_wait().ok().flatten().is_none()
            });
            let mut records = load_managed_agents(&app)?;
            let record = find_managed_agent_mut(&mut records, &pubkey)?;
            if scope.as_ref().is_some_and(|scope| {
                !scope.owns_agent(
                    crate::managed_agents::owner_scope::effective_owner_pubkey(record).as_deref(),
                    &record.relay_url,
                )
            }) {
                return Err("The teammate moved to another business while restarting.".into());
            }
            if stamp_restart_error(record, &error, &expected, &current, has_live_runtime) {
                save_managed_agents(&app, &records)?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|_| "Could not retain the restart error".to_string())?
}

fn stamp_restart_error(
    record: &mut crate::managed_agents::ManagedAgentRecord,
    error: &str,
    expected: &GlobalAgentConfig,
    current: &GlobalAgentConfig,
    has_live_runtime: bool,
) -> bool {
    if current != expected || has_live_runtime {
        return false;
    }
    record.last_error = Some(error.to_owned());
    record.updated_at = crate::util::now_iso();
    true
}

/// Whether the effective harness can consume the OpenAI-compatible provisioned
/// meter. This is evaluated per live record before any process is stopped.
fn provisioned_runtime_supported(
    record: &crate::managed_agents::ManagedAgentRecord,
    personas: &[crate::managed_agents::AgentDefinition],
    global: &GlobalAgentConfig,
) -> bool {
    let command = crate::managed_agents::effective_config::resolve_effective_harness_command(
        record, personas, global,
    )
    .unwrap_or_else(|_| record_agent_command(record, personas));
    let runtime_id = known_acp_runtime(&command)
        .map(|runtime| runtime.id)
        .unwrap_or("custom");
    if runtime_id == "codex" {
        return true;
    }
    if !matches!(runtime_id, "goose" | "buzz-agent") {
        return false;
    }
    let effective =
        resolve_effective_agent_env(record, personas, known_acp_runtime(&command), global);
    let key = if runtime_id == "goose" {
        "GOOSE_PROVIDER"
    } else {
        "BUZZ_AGENT_PROVIDER"
    };
    let provider = effective
        .env
        .get(key)
        .map(String::as_str)
        .or(global.provider.as_deref())
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    matches!(provider.as_deref(), Some("openai" | "openai-compat"))
}

/// Reject a saved global Colony Credits mode when its explicit preferred
/// runtime can never consume the OpenAI-compatible meter. This mirrors the UI
/// handle's provider-aware disabled state and prevents a mode that would only
/// fail later at spawn from being persisted. A missing preferred runtime keeps
/// the existing default (Codex) behavior.
fn validate_provisioned_mode_eligibility(config: &GlobalAgentConfig) -> Result<(), String> {
    if config.credential_mode != CredentialMode::ColonyCredits {
        return Ok(());
    }
    let Some(runtime_id) = config.preferred_runtime.as_deref() else {
        return Ok(());
    };
    if runtime_id == "codex" {
        return Ok(());
    }
    let provider_key = match runtime_id {
        "goose" => "GOOSE_PROVIDER",
        "buzz-agent" => "BUZZ_AGENT_PROVIDER",
        _ => {
            return Err(format!(
                "Colony Credits is unavailable for the {runtime_id} harness; choose BYOK"
            ));
        }
    };
    let provider = config
        .env_vars
        .get(provider_key)
        .map(String::as_str)
        .or(config.provider.as_deref())
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    if matches!(provider.as_deref(), Some("openai" | "openai-compat")) {
        Ok(())
    } else {
        Err(format!(
            "Colony Credits requires an OpenAI or OpenAI-compatible provider for {runtime_id}; choose BYOK"
        ))
    }
}

/// Whether a live record may be restarted for a global credential-mode change.
/// Unsupported pairs remain untouched for either direction of a mode-only
/// change; their own provider/model/env changes still use the normal restart
/// predicate below.
fn should_restart_for_credential_mode(
    old_mode: CredentialMode,
    new_mode: CredentialMode,
    provisioned_supported: bool,
    has_provisioned_runtime: bool,
    mode_changed: bool,
) -> bool {
    if !mode_changed {
        return true;
    }
    if has_provisioned_runtime && new_mode == CredentialMode::Byok {
        return true;
    }
    if !provisioned_supported {
        return false;
    }
    if old_mode == CredentialMode::ColonyCredits
        && new_mode == CredentialMode::Byok
        && !has_provisioned_runtime
    {
        return false;
    }
    true
}

/// Pure predicate: should an agent be restarted given resolved readiness and
/// effective-env snapshots?
///
/// Extracted so the restart decision logic can be unit-tested without an
/// `AppHandle` or `EffectiveAgentEnv`.  Both `collect_restart_candidates` and
/// the under-lock eligibility check in `restart_local_agent_on_config_change`
/// delegate to this predicate.
///
/// Conditions:
/// - `NotReady → Ready`: blocked on missing key, now unblocked.
/// - `Ready + env changed`: running with stale env; env is baked at spawn time.
///   Also covers `Ready → NotReady` when the env changed (key removed).
///
/// **Readiness invariant (T,F,F):** For `buzz-agent` and `goose`, readiness is
/// derived purely from `EffectiveAgentEnv` — it cannot flip without an env delta.
/// For `claude`/`codex`, `cli_login_requirements` queries runtime auth state
/// (e.g. `claude auth status`), so readiness CAN flip Ready→NotReady without
/// an env change. In that case combo (T,F,F) evaluates to `false` — the running
/// agent is NOT restarted. This is intentional: the env is unchanged, and a
/// restart would not repair the missing auth token. If the binary disappears,
/// the process would already be dead and the PID alive-check in the candidate
/// scan would have excluded it.
fn should_restart_on_config_change(old_ready: bool, new_ready: bool, env_changed: bool) -> bool {
    (!old_ready && new_ready) || (old_ready && env_changed)
}

#[cfg(test)]
mod tests {
    use super::{
        should_restart_for_credential_mode, should_restart_on_config_change, stamp_restart_error,
        validate_provisioned_mode_eligibility,
    };
    use crate::managed_agents::CredentialMode;
    use crate::managed_agents::GlobalAgentConfig;
    use std::collections::BTreeMap;

    #[test]
    fn late_restart_failure_preserves_newer_settings_and_live_generation_status() {
        let expected = GlobalAgentConfig::default();
        let newer = GlobalAgentConfig {
            model: Some("newer-model".into()),
            ..expected.clone()
        };
        let original = crate::managed_agents::ManagedAgentRecord {
            name: "Scout".into(),
            last_error: Some("current status".into()),
            updated_at: "newer-generation-time".into(),
            runtime_pid: Some(42),
            ..Default::default()
        };
        for (current, live) in [(&newer, false), (&expected, true), (&newer, true)] {
            let mut record = original.clone();
            assert!(!stamp_restart_error(
                &mut record,
                "older failure",
                &expected,
                current,
                live
            ));
            assert_eq!(
                record, original,
                "a losing restart must not alter any field on the newer generation"
            );
        }
        let mut stopped = crate::managed_agents::ManagedAgentRecord {
            runtime_pid: None,
            ..original
        };
        assert!(stamp_restart_error(
            &mut stopped,
            "current failure",
            &expected,
            &expected,
            false
        ));
        assert_eq!(stopped.last_error.as_deref(), Some("current failure"));
        assert_eq!(stopped.runtime_pid, None);
        assert_ne!(stopped.updated_at, "newer-generation-time");
    }

    #[test]
    fn mixed_fleet_mode_change_leaves_unsupported_byok_pairs_running() {
        assert!(!should_restart_for_credential_mode(
            CredentialMode::Byok,
            CredentialMode::ColonyCredits,
            false,
            false,
            true,
        ));
        assert!(!should_restart_for_credential_mode(
            CredentialMode::ColonyCredits,
            CredentialMode::Byok,
            false,
            false,
            true,
        ));
    }

    #[test]
    fn provisioned_pair_can_return_to_byok() {
        assert!(should_restart_for_credential_mode(
            CredentialMode::ColonyCredits,
            CredentialMode::Byok,
            true,
            true,
            true,
        ));
    }

    #[test]
    fn same_mode_does_not_apply_mode_eligibility_guard() {
        assert!(should_restart_for_credential_mode(
            CredentialMode::ColonyCredits,
            CredentialMode::ColonyCredits,
            false,
            false,
            false,
        ));
    }

    #[test]
    fn provisioned_mode_rejects_unsupported_preferred_provider() {
        let config = GlobalAgentConfig {
            credential_mode: CredentialMode::ColonyCredits,
            env_vars: BTreeMap::new(),
            provider: Some("anthropic".to_string()),
            model: None,
            preferred_runtime: Some("goose".to_string()),
        };
        assert!(validate_provisioned_mode_eligibility(&config).is_err());
        let supported = GlobalAgentConfig {
            provider: Some("openai-compat".to_string()),
            ..config
        };
        assert!(validate_provisioned_mode_eligibility(&supported).is_ok());
    }

    /// Running agent (Ready) whose effective env changed → restart candidate.
    #[test]
    fn env_changed_running_agent_is_candidate() {
        // old_ready=true, new_ready=true, env_changed=true
        assert!(
            should_restart_on_config_change(true, true, true),
            "running agent with changed env must be restarted"
        );
    }

    /// Running agent (Ready) whose effective env did NOT change → not a candidate.
    #[test]
    fn unchanged_running_agent_is_not_candidate() {
        // old_ready=true, new_ready=true, env_changed=false
        assert!(
            !should_restart_on_config_change(true, true, false),
            "running agent with identical env must NOT be restarted"
        );
    }

    /// NotReady → Ready transition is admitted regardless of env diff.
    #[test]
    fn not_ready_to_ready_is_candidate() {
        // old_ready=false, new_ready=true, env_changed=false (env_changed irrelevant)
        assert!(
            should_restart_on_config_change(false, true, false),
            "NotReady → Ready must be a restart candidate"
        );
    }

    /// Ready → NotReady (config became invalid, env changed) is admitted so the
    /// agent restarts into setup-listener mode via the normal spawn path.
    #[test]
    fn ready_to_not_ready_env_changed_is_candidate() {
        // old_ready=true (had key), new_ready=false (key removed), env_changed=true
        assert!(
            should_restart_on_config_change(true, false, true),
            "Ready → NotReady with env change must be a restart candidate"
        );
    }

    /// Both NotReady, env unchanged → not a candidate (nothing to restart).
    #[test]
    fn both_not_ready_unchanged_is_not_candidate() {
        // old_ready=false, new_ready=false, env_changed=false
        assert!(
            !should_restart_on_config_change(false, false, false),
            "both NotReady with no env change must NOT be a candidate"
        );
    }

    /// NotReady + env changed but new still NotReady → not a candidate.
    #[test]
    fn not_ready_env_changed_still_not_ready_is_not_candidate() {
        // Changed one unrelated env var but still missing the required key.
        // old_ready=false, new_ready=false, env_changed=true
        assert!(
            !should_restart_on_config_change(false, false, true),
            "NotReady→NotReady (env changed but still broken) must NOT be a candidate"
        );
    }

    /// NotReady → Ready AND env also changed → still a restart candidate.
    ///
    /// Guards against a future `&& !env_changed` regression on the
    /// NotReady→Ready branch: env_changed is irrelevant when readiness
    /// unblocks — the agent must restart regardless of whether env also differed.
    #[test]
    fn not_ready_to_ready_with_env_change_is_candidate() {
        // old_ready=false, new_ready=true, env_changed=true
        assert!(
            should_restart_on_config_change(false, true, true),
            "NotReady → Ready (with env change) must be a restart candidate"
        );
    }
}

#[cfg(test)]
#[path = "global_agent_config_scope_tests.rs"]
mod scope_tests;
