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
        resolve_effective_agent_env, save_global_agent_config, save_managed_agents,
        stop_managed_agent_process, sync_managed_agent_processes, validate_global_config,
        AgentReadiness, BackendKind, CredentialMode, GlobalAgentConfig,
    },
};

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
    /// Number of agents whose stop succeeded but respawn failed.
    pub failed_restart_count: u32,
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
/// Restart is best-effort: per-agent errors are logged to stderr and persisted
/// to `last_error` but do not fail the command.  Returns the saved config and
/// the count of agents successfully restarted.
#[tauri::command]
pub async fn set_global_agent_config(
    config: GlobalAgentConfig,
    app: AppHandle,
) -> Result<GlobalAgentConfigSaveResult, String> {
    // ── Phase 1: disk write (sync, spawn_blocking) ────────────────────────
    //
    // Validate, snapshot old config, write new config, collect pre-filter
    // candidate pubkeys (local backend + recorded PID + old NotReady + new
    // Ready).  The candidate list is a hint — eligibility is re-checked under
    // lock in Phase 2 after sync_managed_agent_processes.
    let app_for_write = app.clone();
    let phase1 = tokio::task::spawn_blocking(move || {
        validate_global_config(&config)?;
        validate_provisioned_mode_eligibility(&config)?;

        let old_global = load_global_agent_config(&app_for_write)?;

        save_global_agent_config(&app_for_write, &config)?;

        // Re-read from disk so the returned value reflects the strip-on-write pass.
        let new_global = load_global_agent_config(&app_for_write)?;

        // Pre-filter: identify agents that look eligible before taking any locks.
        // This is a hint only; definitive eligibility check happens under lock
        // in Phase 2.
        let (candidates, personas_snapshot) =
            collect_restart_candidates(&app_for_write, &old_global, &new_global);

        Ok::<_, String>((new_global, old_global, candidates, personas_snapshot))
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
    // failed_restart_count surfaces stops that succeeded but respawn failed.
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
            )
            .await;
            match outcome {
                RestartOutcome::Restarted => restarted_count += 1,
                RestartOutcome::FailedAfterStop => failed_restart_count += 1,
                RestartOutcome::Skipped => {}
            }
        }
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
    /// Stop succeeded but the subsequent spawn failed.
    FailedAfterStop,
    /// Eligibility check failed under lock — agent skipped without touching it.
    Skipped,
}

/// Collect pubkeys of local agents that should be restarted after a global
/// config change, together with the personas snapshot used for the scan.
///
/// Pre-lock hint used by Phase 1 of `set_global_agent_config`. Eligibility is
/// re-verified under lock in Phase 2. The personas snapshot is threaded to
/// `restart_local_agent_on_config_change` so it is not reloaded per agent.
///
/// An agent is a candidate when it is a local backend with a recorded PID, and
/// either:
/// - its readiness transitions `NotReady → Ready` (was blocked on missing
///   provider/model key, now unblocked), OR
/// - it was already `Ready`, its process is currently alive, and its effective
///   env changed (provider, model, or env var update that needs a restart to
///   take effect, since env is baked at spawn time).
fn collect_restart_candidates(
    app: &AppHandle,
    old_global: &GlobalAgentConfig,
    new_global: &GlobalAgentConfig,
) -> (Vec<String>, Vec<crate::managed_agents::AgentDefinition>) {
    let records = match load_managed_agents(app) {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: failed to load agents for restart scan: {e}"
            );
            return (Vec::new(), Vec::new());
        }
    };
    let all_personas = match load_personas(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: failed to load personas for restart scan: {e}"
            );
            return (Vec::new(), Vec::new());
        }
    };
    use tauri::Manager;
    let state = app.state::<AppState>();
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .unwrap_or_else(|error| error.into_inner());

    let candidates = records
        .iter()
        .filter(|record| {
            if record.backend != BackendKind::Local {
                return false;
            }
            let mut has_live_runtime = false;
            let mut has_provisioned_runtime = false;
            for (key, runtime) in runtimes.iter_mut() {
                if key.pubkey.eq_ignore_ascii_case(&record.pubkey)
                    && runtime.child.try_wait().ok().flatten().is_none()
                {
                    has_live_runtime = true;
                    has_provisioned_runtime |= runtime.provisioned_lease.is_some();
                }
            }
            if !has_live_runtime {
                return false;
            }
            let provisioned_supported =
                provisioned_runtime_supported(record, &all_personas, new_global);
            let effective_cmd = record_agent_command(record, &all_personas);
            let runtime_meta = known_acp_runtime(&effective_cmd);
            let old_effective =
                resolve_effective_agent_env(record, &all_personas, runtime_meta, old_global);
            let new_effective =
                resolve_effective_agent_env(record, &all_personas, runtime_meta, new_global);
            let old_ready = matches!(agent_readiness(&old_effective), AgentReadiness::Ready);
            let new_ready = matches!(agent_readiness(&new_effective), AgentReadiness::Ready);
            // For a Ready+running agent: the process must be alive now and the
            // process-env map must differ.  The alive check avoids queuing a
            // restart for a process that already exited between the pre-filter
            // scan and Phase 2.  NotReady→Ready bypasses the alive check
            // because Phase 2 will stop-then-start unconditionally.
            let effective_env_changed = old_effective.env != new_effective.env;
            let mode_changed = old_global.credential_mode != new_global.credential_mode;
            let mode_restart_allowed = should_restart_for_credential_mode(
                old_global.credential_mode,
                new_global.credential_mode,
                provisioned_supported,
                has_provisioned_runtime,
                mode_changed,
            );
            should_restart_on_config_change(
                old_ready,
                new_ready,
                old_ready && effective_env_changed,
            ) || (mode_changed && mode_restart_allowed)
        })
        .map(|r| r.pubkey.clone())
        .collect();

    (candidates, all_personas)
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
/// All errors are logged to stderr. Returns `RestartOutcome::FailedAfterStop`
/// when the stop succeeded but the spawn failed — the caller surfaces this as
/// `failed_restart_count` so the UI can prompt the user to check the Agents tab.
async fn restart_local_agent_on_config_change(
    app: &AppHandle,
    pubkey: &str,
    old_global: &GlobalAgentConfig,
    new_global: &GlobalAgentConfig,
    personas_snapshot: &[crate::managed_agents::AgentDefinition],
) -> RestartOutcome {
    // ── Step 1: stop under lock, re-verifying eligibility ─────────────────
    let app_for_stop = app.clone();
    let pubkey_owned = pubkey.to_string();
    let old_global_clone = old_global.clone();
    let new_global_clone = new_global.clone();
    let personas_owned = personas_snapshot.to_vec();

    let stop_result = tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        let state = app_for_stop.state::<AppState>();

        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| format!("failed to acquire store lock: {e}"))?;

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
        let has_provisioned_runtime = runtime_keys.iter().any(|key| {
            runtimes
                .get(key)
                .and_then(|runtime| runtime.provisioned_lease.as_ref())
                .is_some()
        });
        let provisioned_supported =
            provisioned_runtime_supported(record, &personas_owned, &new_global_clone);
        // Re-check the eligibility predicate under lock:
        //   (old NotReady && new Ready)  OR  (old Ready && env changed)
        // TODO: busy/mid-turn deferral would slot in here
        //
        // Reuse personas_snapshot from Phase 1 — avoids loading personas again
        // per agent when the save-command personas haven't changed.
        let effective_cmd = record_agent_command(record, &personas_owned);
        let runtime_meta = known_acp_runtime(&effective_cmd);
        let old_effective =
            resolve_effective_agent_env(record, &personas_owned, runtime_meta, &old_global_clone);
        let new_effective =
            resolve_effective_agent_env(record, &personas_owned, runtime_meta, &new_global_clone);
        let old_ready = matches!(agent_readiness(&old_effective), AgentReadiness::Ready);
        let new_ready = matches!(agent_readiness(&new_effective), AgentReadiness::Ready);
        // Under lock, the alive check was already done above via process_is_running.
        let effective_env_changed = old_effective.env != new_effective.env;
        let mode_changed = old_global_clone.credential_mode != new_global_clone.credential_mode;
        let mode_restart_allowed = should_restart_for_credential_mode(
            old_global_clone.credential_mode,
            new_global_clone.credential_mode,
            provisioned_supported,
            has_provisioned_runtime,
            mode_changed,
        );
        if !(should_restart_on_config_change(
            old_ready,
            new_ready,
            old_ready && effective_env_changed,
        ) || mode_changed && mode_restart_allowed)
        {
            return Err(format!(
                "agent {pubkey_owned} restart condition no longer valid under lock"
            ));
        }

        // Stop the process.
        let record_mut = find_managed_agent_mut(&mut records, &pubkey_owned)?;
        stop_managed_agent_process(&app_for_stop, record_mut, &mut runtimes)?;
        save_managed_agents(&app_for_stop, &records)?;

        Ok(runtime_keys)
    })
    .await;

    let runtime_keys = match stop_result {
        Ok(Ok(runtime_keys)) => runtime_keys,
        Ok(Err(e)) => {
            eprintln!("buzz-desktop: set_global_agent_config: skipping restart of {pubkey}: {e}");
            return RestartOutcome::Skipped;
        }
        Err(e) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: spawn_blocking failed for stop of {pubkey}: {e}"
            );
            return RestartOutcome::Skipped;
        }
    };

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
            if let Err(save_err) = persist_last_error(app, pubkey, &e) {
                eprintln!(
                    "buzz-desktop: set_global_agent_config: failed to persist last_error for {pubkey}: {save_err}"
                );
            }
            RestartOutcome::FailedAfterStop
        }
    }
}

/// Persist a `last_error` on the agent record under the store lock.
///
/// Best-effort: called only after a failed restart to leave the record
/// in a diagnosable state rather than a silent "stopped with no error" state.
fn persist_last_error(app: &AppHandle, pubkey: &str, error: &str) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| format!("failed to acquire store lock: {e}"))?;
    let mut records = load_managed_agents(app)?;
    let record = find_managed_agent_mut(&mut records, pubkey)?;
    record.last_error = Some(error.to_string());
    record.updated_at = crate::util::now_iso();
    save_managed_agents(app, &records)
}

/// Whether the effective harness can consume the OpenAI-compatible provisioned
/// meter. This is evaluated per live record before any process is stopped.
fn provisioned_runtime_supported(
    record: &crate::managed_agents::ManagedAgentRecord,
    personas: &[crate::managed_agents::AgentDefinition],
    global: &GlobalAgentConfig,
) -> bool {
    let command = record_agent_command(record, personas);
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
        should_restart_for_credential_mode, should_restart_on_config_change,
        validate_provisioned_mode_eligibility,
    };
    use crate::managed_agents::CredentialMode;
    use crate::managed_agents::GlobalAgentConfig;
    use std::collections::BTreeMap;

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
