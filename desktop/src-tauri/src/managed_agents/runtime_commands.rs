use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager};

use super::{
    agent_readiness, append_log_marker, current_instance_id, find_managed_agent_mut,
    load_global_agent_config, load_managed_agents, load_personas, managed_agent_runtime_log_path,
    process_is_running, record_agent_command, resolve_effective_agent_env, save_managed_agents,
    spawn_agent_child, terminate_process, terminate_untracked_pair_runtime,
    write_agent_runtime_receipt, AgentReadiness, BackendKind, ManagedAgentPairRuntime,
    ManagedAgentRuntimeKey, ManagedAgentRuntimeLifecycle, ManagedAgentRuntimeReceipt,
    ManagedAgentRuntimeStatus,
};
use crate::app_state::AppState;
use crate::provisioned_credits::{normalized_relay_http_origin, GatewayLease};

const STATUS_EVENT: &str = "managed-agent-runtime-status";

/// Failure returned while rotating a provisioned-credit token.  A handoff can
/// fail after one or more pairs have already accepted the replacement; the
/// lease manager must keep that replacement cached in that case so those
/// pairs are not stranded and the token is not revoked out from under them.
pub(crate) struct ProvisionedCreditsHandoffError {
    pub(crate) message: String,
    pub(crate) replacement_in_use: bool,
    pub(crate) remaining_old_keys: Vec<ManagedAgentRuntimeKey>,
}

impl ProvisionedCreditsHandoffError {
    fn new(
        message: impl Into<String>,
        replacement_in_use: bool,
        remaining_old_keys: Vec<ManagedAgentRuntimeKey>,
    ) -> Self {
        Self {
            message: message.into(),
            replacement_in_use,
            remaining_old_keys,
        }
    }
}

pub(crate) struct ProvisionedCreditsHandoff {
    pub(crate) remaining_old_keys: Vec<ManagedAgentRuntimeKey>,
}

/// Drain live provisioned pairs owned by a previous signing identity. The
/// lease cache remains relay-bound and is not blindly revoked on community
/// switches; only an explicit owner change isolates the old generation.
pub(crate) fn isolate_provisioned_credits_owner(
    app: &AppHandle,
    owner_pubkey: &str,
) -> Result<(), String> {
    crate::provisioned_credits::begin_identity_transition(app, owner_pubkey)?;
    let result = isolate_provisioned_credits_runtime_owner(app, owner_pubkey);
    if result.is_err() {
        let _ = crate::provisioned_credits::finish_identity_transition(app);
    }
    result
}

fn isolate_provisioned_credits_runtime_owner(
    app: &AppHandle,
    owner_pubkey: &str,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|error| error.to_string())?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|error| error.to_string())?;
    let stale_keys: Vec<_> = runtimes
        .iter()
        .filter_map(|(key, runtime)| {
            runtime
                .provisioned_lease
                .as_ref()
                .filter(|binding| !binding.owner_pubkey.eq_ignore_ascii_case(owner_pubkey))
                .map(|_| key.clone())
        })
        .collect();
    for key in stale_keys {
        if let Some(mut runtime) = runtimes.remove(&key) {
            let _ = terminate_process(runtime.child.id());
            let _ = runtime.child.wait();
        }
        super::remove_agent_runtime_receipt(app, &key);
    }
    Ok(())
}

fn status_for(
    app: &AppHandle,
    record: &super::ManagedAgentRecord,
    key: &ManagedAgentRuntimeKey,
    runtime: Option<&ManagedAgentPairRuntime>,
    requested_relay_url: Option<String>,
) -> ManagedAgentRuntimeStatus {
    let personas = load_personas(app).unwrap_or_default();
    let global = load_global_agent_config(app).unwrap_or_default();
    status_for_with(
        app,
        record,
        key,
        runtime,
        requested_relay_url,
        StatusInputs {
            personas: &personas,
            global: &global,
        },
    )
}

/// Preloaded per-call-site inputs for [`status_for_with`], so multi-row
/// callers (list, reconcile) hit disk once instead of once per row.
struct StatusInputs<'a> {
    personas: &'a [super::AgentDefinition],
    global: &'a super::GlobalAgentConfig,
}

fn status_for_with(
    app: &AppHandle,
    record: &super::ManagedAgentRecord,
    key: &ManagedAgentRuntimeKey,
    runtime: Option<&ManagedAgentPairRuntime>,
    requested_relay_url: Option<String>,
    inputs: StatusInputs<'_>,
) -> ManagedAgentRuntimeStatus {
    let StatusInputs { personas, global } = inputs;
    let command = record_agent_command(record, personas);
    let metadata = super::known_acp_runtime(&command);
    let effective = resolve_effective_agent_env(record, personas, metadata, global);
    let local_setup = matches!(agent_readiness(&effective), AgentReadiness::Ready);
    ManagedAgentRuntimeStatus {
        pubkey: key.pubkey.clone(),
        relay_url: key.relay_url.clone(),
        requested_relay_url,
        local_setup,
        lifecycle: runtime
            .map(|runtime| runtime.lifecycle.clone())
            .unwrap_or(ManagedAgentRuntimeLifecycle::Stopped),
        pid: runtime.map(|runtime| runtime.child.id()),
        error: runtime.and_then(|runtime| runtime.error.clone()),
        log_path: managed_agent_runtime_log_path(app, key)
            .ok()
            .map(|path| path.display().to_string()),
    }
}

fn emit_status(app: &AppHandle, status: &ManagedAgentRuntimeStatus) {
    let _ = app.emit(STATUS_EVENT, status);
}

fn observer_lifecycle_key(
    outer_pubkey: &str,
    payload: &super::ManagedAgentRuntimeLifecycleObserverPayload,
) -> Result<ManagedAgentRuntimeKey, String> {
    if !outer_pubkey.eq_ignore_ascii_case(&payload.pubkey) {
        return Err("observer signer does not match lifecycle payload pubkey".into());
    }
    if matches!(
        payload.lifecycle,
        ManagedAgentRuntimeLifecycle::Starting | ManagedAgentRuntimeLifecycle::Stopped
    ) {
        return Err("observer cannot author starting or stopped lifecycle".into());
    }
    if payload.lifecycle == ManagedAgentRuntimeLifecycle::Failed && payload.error.is_none() {
        return Err("failed lifecycle requires an error".into());
    }
    if payload.lifecycle != ManagedAgentRuntimeLifecycle::Failed && payload.error.is_some() {
        return Err("lifecycle error is only valid for failed".into());
    }
    ManagedAgentRuntimeKey::new(payload.pubkey.clone(), &payload.relay_url)
}

#[tauri::command]
pub fn put_managed_agent_runtime_lifecycle(
    outer_pubkey: String,
    payload: super::ManagedAgentRuntimeLifecycleObserverPayload,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    let key = observer_lifecycle_key(&outer_pubkey, &payload)?;
    let state = app.state::<AppState>();
    let records = load_managed_agents(&app)?;
    let record = records
        .iter()
        .find(|record| record.pubkey.eq_ignore_ascii_case(&key.pubkey))
        .ok_or_else(|| format!("agent {} not found", key.pubkey))?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    let runtime = runtimes
        .get_mut(&key)
        .ok_or_else(|| "lifecycle frame does not match a tracked runtime pair".to_string())?;
    if runtime.start_nonce != payload.start_nonce {
        return Err("lifecycle frame does not match the current harness generation".into());
    }
    if runtime
        .child
        .try_wait()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("lifecycle frame arrived after process exit".into());
    }
    runtime.lifecycle = payload.lifecycle;
    runtime.error = payload.error;
    let status = status_for(&app, record, &key, Some(runtime), None);
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn list_managed_agent_runtimes(
    app: AppHandle,
) -> Result<Vec<ManagedAgentRuntimeStatus>, String> {
    // This command is polled whenever the members sidebar opens and refetched
    // on every status event — load the per-row status inputs once, outside
    // the locks, instead of hitting disk per row while holding them.
    let personas = load_personas(&app).unwrap_or_default();
    let global = load_global_agent_config(&app).unwrap_or_default();
    let state = app.state::<AppState>();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| e.to_string())?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(&app)?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    let exited_keys: Vec<_> = runtimes
        .iter_mut()
        .filter_map(|(key, runtime)| match runtime.child.try_wait() {
            Ok(Some(_)) | Err(_) => Some(key.clone()),
            Ok(None) => None,
        })
        .collect();
    let records_changed = !exited_keys.is_empty();
    let mut statuses = Vec::new();
    for key in exited_keys {
        runtimes.remove(&key);
        super::remove_agent_runtime_receipt(&app, &key);
        state.clear_agent_session_cache(&key);
        if let Some(record) = records
            .iter_mut()
            .find(|record| record.pubkey.eq_ignore_ascii_case(&key.pubkey))
        {
            record.updated_at = crate::util::now_iso();
            record.last_stopped_at = Some(record.updated_at.clone());
            let status = status_for_with(
                &app,
                record,
                &key,
                None,
                None,
                StatusInputs {
                    personas: &personas,
                    global: &global,
                },
            );
            emit_status(&app, &status);
            statuses.push(status);
        }
    }
    statuses.extend(runtimes.iter().filter_map(|(key, runtime)| {
        let record = records
            .iter()
            .find(|record| record.pubkey.eq_ignore_ascii_case(&key.pubkey))?;
        Some(status_for_with(
            &app,
            record,
            key,
            Some(runtime),
            None,
            StatusInputs {
                personas: &personas,
                global: &global,
            },
        ))
    }));
    drop(runtimes);
    // Records are only mutated above when a runtime exited — skip the store
    // rewrite on the common nothing-changed poll.
    if records_changed {
        save_managed_agents(&app, &records)?;
    }
    Ok(statuses)
}

pub(crate) fn start_managed_agent_runtime_pair_lazy(
    pubkey: String,
    relay_url: String,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    start_pair(pubkey, relay_url, true, None, app)
}

/// Stage a replacement meter lease into live pairs on the matching relay
/// before the lease manager revokes the old token. `target_keys` is used by a
/// retry to select only pairs still on a retained old generation; a full
/// rotation passes `None`. Replacement harnesses are spawned first; if any
/// spawn fails, all staged children are terminated and the existing pairs
/// remain untouched. The returned/error key list is the exact subset that
/// still uses the old generation, so the lease manager can retain and retry
/// it without orphaning the raw token reference.
pub(crate) fn handoff_provisioned_credits_pairs(
    app: &AppHandle,
    lease: &GatewayLease,
    target_keys: Option<&[ManagedAgentRuntimeKey]>,
    source_lease: Option<&GatewayLease>,
) -> Result<ProvisionedCreditsHandoff, ProvisionedCreditsHandoffError> {
    let state = app.state::<AppState>();
    let current_owner = state
        .signing_keys()
        .map(|keys| keys.public_key().to_hex())
        .map_err(|error| {
            ProvisionedCreditsHandoffError::new(
                error,
                false,
                target_keys.map(ToOwned::to_owned).unwrap_or_default(),
            )
        })?;
    if !current_owner.eq_ignore_ascii_case(&lease.key.owner_pubkey) {
        return Err(ProvisionedCreditsHandoffError::new(
            "Colony Credits identity changed; reconnect the original identity before handoff",
            false,
            target_keys.map(ToOwned::to_owned).unwrap_or_default(),
        ));
    }
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|error| ProvisionedCreditsHandoffError::new(error.to_string(), false, vec![]))?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| ProvisionedCreditsHandoffError::new(error.to_string(), false, vec![]))?;
    let records = load_managed_agents(app)
        .map_err(|error| ProvisionedCreditsHandoffError::new(error, false, vec![]))?;
    let running_keys: Vec<ManagedAgentRuntimeKey> = {
        let runtimes = state.managed_agent_processes.lock().map_err(|error| {
            ProvisionedCreditsHandoffError::new(error.to_string(), false, vec![])
        })?;
        runtimes
            .iter()
            .filter_map(|(key, runtime)| {
                let alive = process_is_running(runtime.child.id());
                (alive
                    && normalized_relay_http_origin(&key.relay_url).ok().as_deref()
                        == Some(lease.key.relay_origin.as_str())
                    && source_lease.is_some_and(|source| {
                        runtime
                            .provisioned_lease
                            .as_ref()
                            .is_some_and(|binding| binding.matches(source))
                    })
                    && target_keys
                        .map(|targets| targets.iter().any(|target| target == key))
                        .unwrap_or(true))
                .then(|| key.clone())
            })
            .collect()
    };
    if running_keys.is_empty() {
        return Ok(ProvisionedCreditsHandoff {
            remaining_old_keys: vec![],
        });
    }
    let mut remaining_old_keys = running_keys.clone();
    // Snapshot locks are intentionally not held while spawning children. This
    // keeps the runtime transition/store order independent from the lease
    // manager and avoids the old manager↔runtime inversion.
    drop(_transition);
    drop(_store);
    let mut staged: Vec<(ManagedAgentRuntimeKey, super::ManagedAgentProcess)> =
        Vec::with_capacity(running_keys.len());
    for key in &running_keys {
        let Some(record) = records
            .iter()
            .find(|record| record.pubkey.eq_ignore_ascii_case(&key.pubkey))
        else {
            for (_, mut process) in staged {
                let _ = terminate_process(process.child.id());
                let _ = process.child.wait();
            }
            return Err(ProvisionedCreditsHandoffError::new(
                format!("managed agent {} disappeared during reconnect", key.pubkey),
                false,
                remaining_old_keys.clone(),
            ));
        };
        match super::spawn_agent_child_with_lease(
            app,
            record,
            &key.relay_url,
            true,
            Some(lease.key.owner_pubkey.as_str()),
            Some(lease),
        ) {
            Ok(process) => staged.push((key.clone(), process)),
            Err(error) => {
                for (_, mut process) in staged {
                    let _ = terminate_process(process.child.id());
                    let _ = process.child.wait();
                }
                return Err(ProvisionedCreditsHandoffError::new(
                    error,
                    false,
                    remaining_old_keys.clone(),
                ));
            }
        }
    }

    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|error| {
            ProvisionedCreditsHandoffError::new(
                error.to_string(),
                false,
                remaining_old_keys.clone(),
            )
        })?;
    let _store = state.managed_agents_store_lock.lock().map_err(|error| {
        ProvisionedCreditsHandoffError::new(error.to_string(), false, remaining_old_keys.clone())
    })?;
    let mut runtimes = state.managed_agent_processes.lock().map_err(|error| {
        ProvisionedCreditsHandoffError::new(error.to_string(), false, remaining_old_keys.clone())
    })?;
    if !super::provisioned_lease_matches_current_identity(app, lease) {
        for (_, mut process) in staged {
            let _ = terminate_process(process.child.id());
            let _ = process.child.wait();
        }
        return Err(ProvisionedCreditsHandoffError::new(
            "Colony Credits identity changed during reconnect; retry reconnect",
            false,
            remaining_old_keys,
        ));
    }
    let mut replacement_in_use = false;
    for key in &running_keys {
        let staged_index = staged.iter().position(|(staged_key, _)| staged_key == key);
        let Some(staged_index) = staged_index else {
            for (_, mut process) in staged {
                let _ = terminate_process(process.child.id());
                let _ = process.child.wait();
            }
            return Err(ProvisionedCreditsHandoffError::new(
                "managed-agent replacement disappeared during reconnect",
                replacement_in_use,
                remaining_old_keys.clone(),
            ));
        };
        let Some(mut runtime) = runtimes.remove(key) else {
            for (_, mut process) in staged {
                let _ = terminate_process(process.child.id());
                let _ = process.child.wait();
            }
            return Err(ProvisionedCreditsHandoffError::new(
                "managed-agent pair changed during reconnect",
                replacement_in_use,
                remaining_old_keys.clone(),
            ));
        };

        if process_is_running(runtime.child.id()) {
            if let Err(error) = terminate_process(runtime.child.id())
                .and_then(|()| runtime.child.wait().map_err(|wait| wait.to_string()))
            {
                // Keep the pair that failed teardown tracked and leave any
                // replacements already installed in place.  They now depend
                // on the replacement token, so the lease manager must not
                // revoke it on this partial-failure path.
                runtimes.insert(key.clone(), runtime);
                let (_, mut uninstalled) = staged.swap_remove(staged_index);
                let _ = terminate_process(uninstalled.child.id());
                let _ = uninstalled.child.wait();
                for (_, mut process) in staged {
                    let _ = terminate_process(process.child.id());
                    let _ = process.child.wait();
                }
                return Err(ProvisionedCreditsHandoffError::new(
                    error,
                    replacement_in_use,
                    remaining_old_keys.clone(),
                ));
            }
        }

        let (_, process) = staged.swap_remove(staged_index);
        let now = crate::util::now_iso();
        let receipt = ManagedAgentRuntimeReceipt {
            key: key.clone(),
            pid: process.child.id(),
            desktop_instance_id: current_instance_id(app),
            started_at: now,
        };
        let receipt_error = write_agent_runtime_receipt(app, &receipt).err();
        runtimes.insert(
            key.clone(),
            ManagedAgentPairRuntime::starting_with_lease(process, lease),
        );
        replacement_in_use = true;
        remaining_old_keys.retain(|old_key| old_key != key);
        if let Some(error) = receipt_error {
            // The replacement is already live and tracked.  Keep it running
            // and let the caller retain the new lease while reporting the
            // persistence failure for a later reconnect/recovery attempt.
            for (_, mut process) in staged {
                let _ = terminate_process(process.child.id());
                let _ = process.child.wait();
            }
            return Err(ProvisionedCreditsHandoffError::new(
                error,
                true,
                remaining_old_keys.clone(),
            ));
        }
    }
    Ok(ProvisionedCreditsHandoff { remaining_old_keys })
}

#[tauri::command]
pub fn start_managed_agent_runtime(
    pubkey: String,
    relay_url: String,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    start_managed_agent_runtime_pair_lazy(pubkey, relay_url, app)
}

fn start_pair(
    pubkey: String,
    relay_url: String,
    lazy: bool,
    expected_updated_at: Option<&str>,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    let state = app.state::<AppState>();
    let (key, spawn_record) = {
        let _transition = state
            .managed_agent_runtime_transition
            .lock()
            .map_err(|e| e.to_string())?;
        if state.shutdown_started.load(Ordering::Acquire) {
            return Err("desktop shutdown has started".into());
        }
        let _store = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let mut records = load_managed_agents(&app)?;
        let record = find_managed_agent_mut(&mut records, &pubkey)?;
        if record.backend != BackendKind::Local {
            return Err("managed runtime pairs require a local agent".into());
        }
        if expected_updated_at.is_some_and(|expected| record.updated_at != expected) {
            return Err("managed agent changed while runtime reconciliation was in flight".into());
        }
        let key = ManagedAgentRuntimeKey::new(pubkey, &relay_url)?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        let pair_running = runtimes
            .get_mut(&key)
            .is_some_and(|runtime| runtime.child.try_wait().ok().flatten().is_none());
        if pair_running {
            let status = status_for(&app, record, &key, runtimes.get(&key), None);
            return Ok(status);
        }
        runtimes.remove(&key);
        terminate_untracked_pair_runtime(&app, &key)?;
        // The lease manager may perform blocking mint I/O. Drop all runtime
        // locks before spawning so a concurrent rotation can never wait for a
        // lock held by a start that is itself waiting on the per-key gate.
        (key, record.clone())
    };

    let owner = state
        .keys
        .lock()
        .ok()
        .map(|keys| keys.public_key().to_hex());
    let mut process =
        spawn_agent_child(&app, &spawn_record, &key.relay_url, lazy, owner.as_deref())?;
    let process_log_path = process.log_path.clone();

    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| e.to_string())?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    if state.shutdown_started.load(Ordering::Acquire) {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        return Err("desktop shutdown has started".into());
    }
    if !super::provisioned_process_matches_current_identity(&app, &key.relay_url, &process) {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        return Err("Colony Credits identity changed during spawn; retry reconnect".into());
    }
    let mut records = load_managed_agents(&app)?;
    let record = find_managed_agent_mut(&mut records, &key.pubkey)?;
    if expected_updated_at.is_some_and(|expected| record.updated_at != expected) {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        return Err("managed agent changed while runtime reconciliation was in flight".into());
    }
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    let pair_running = runtimes
        .get_mut(&key)
        .is_some_and(|runtime| runtime.child.try_wait().ok().flatten().is_none());
    if pair_running {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        let status = status_for(&app, record, &key, runtimes.get(&key), None);
        return Ok(status);
    }
    let now = crate::util::now_iso();
    let receipt = ManagedAgentRuntimeReceipt {
        key: key.clone(),
        pid: process.child.id(),
        desktop_instance_id: current_instance_id(&app),
        started_at: now.clone(),
    };
    if let Err(error) = write_agent_runtime_receipt(&app, &receipt) {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        return Err(error);
    }
    record.runtime_pid = None;
    record.updated_at = now.clone();
    record.last_started_at = Some(now);
    record.last_stopped_at = None;
    record.last_error = None;
    // Snapshot reconcile inputs while the record is in scope. The pair's own
    // relay is the target: this spawn may serve a community other than the
    // active workspace, and the profile must land where the process connects.
    let reconcile_personas = load_personas(&app).unwrap_or_default();
    let reconcile_data = crate::commands::ProfileReconcileData {
        private_key_nsec: record.private_key_nsec.clone(),
        name: record.name.clone(),
        relay_url: record.relay_url.clone(),
        avatar_url: record.avatar_url.clone(),
        auth_tag: record.auth_tag.clone(),
        pubkey: record.pubkey.clone(),
        agent_command: record_agent_command(record, &reconcile_personas),
        persona_id: record.persona_id.clone(),
        role_id: record.role_id.clone(),
    };
    runtimes.insert(key.clone(), ManagedAgentPairRuntime::starting(process));
    let status = status_for(&app, record, &key, runtimes.get(&key), None);
    drop(runtimes);
    save_managed_agents(&app, &records)?;
    emit_status(&app, &status);

    // ── Profile reconciliation (fire-and-forget) ────────────────────────────
    // Pair spawns (sidebar Start, runtime reconcile, restarts) used to skip
    // this entirely, so an agent could run on a relay that had no kind:0 for
    // it — and every surface resolving names from relay profiles alone then
    // rendered the agent's raw pubkey. Same pattern as the UI start path;
    // failures are appended to the pair log so they are actually findable.
    let reconcile_app = app.clone();
    let reconcile_pubkey = key.pubkey.clone();
    let reconcile_relay = key.relay_url.clone();
    tauri::async_runtime::spawn(async move {
        let state = reconcile_app.state::<AppState>();
        if let Err(error) = crate::commands::reconcile_profile_at(
            &state,
            &reconcile_app,
            &reconcile_pubkey,
            &reconcile_data,
            &reconcile_relay,
        )
        .await
        {
            let _ = append_log_marker(
                &process_log_path,
                &format!("=== profile reconcile failed: {error} ==="),
            );
            eprintln!(
                "buzz-desktop: profile reconciliation failed for agent {reconcile_pubkey}: {error}"
            );
        }
    });
    Ok(status)
}

#[tauri::command]
pub fn stop_managed_agent_runtime(
    pubkey: String,
    relay_url: String,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    let state = app.state::<AppState>();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| e.to_string())?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(&app)?;
    let record = find_managed_agent_mut(&mut records, &pubkey)?;
    let key = ManagedAgentRuntimeKey::new(pubkey, &relay_url)?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(mut runtime) = runtimes.remove(&key) {
        let stop_result = if process_is_running(runtime.child.id()) {
            terminate_process(runtime.child.id())
        } else {
            Ok(())
        }
        .and_then(|()| runtime.child.wait().map_err(|e| e.to_string()));
        match stop_result {
            Ok(status) => {
                record.last_exit_code = status.code();
                let _ = append_log_marker(&runtime.log_path, "=== stopped pair runtime ===");
            }
            Err(error) => {
                // Keep failed teardown visible/manageable instead of
                // orphaning it: the child stays tracked and the receipt
                // stays on disk until a stop actually succeeds.
                runtimes.insert(key, runtime);
                return Err(error);
            }
        }
    } else {
        // No runtime is tracked at this key, but a valid prior-session
        // receipt may still point at a live child (e.g. the crash-recovery
        // window for a non-auto-start agent). Terminate that orphan before
        // erasing its receipt — otherwise this "stop" leaves the harness
        // running yet deletes the one artifact sweeps and
        // terminate_untracked_pair_runtime use to find it, and a follow-up
        // start would spawn a duplicate harness for the same pair. On
        // failure the receipt stays on disk (terminate_untracked_pair_runtime
        // only removes it after the child exits), mirroring the tracked
        // path's keep-until-success invariant.
        terminate_untracked_pair_runtime(&app, &key)?;
    }
    super::remove_agent_runtime_receipt(&app, &key);
    state.clear_agent_session_cache(&key);
    record.runtime_pid = None;
    record.updated_at = crate::util::now_iso();
    record.last_stopped_at = Some(record.updated_at.clone());
    let status = status_for(&app, record, &key, None, None);
    drop(runtimes);
    save_managed_agents(&app, &records)?;
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn restart_managed_agent_runtime(
    pubkey: String,
    relay_url: String,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    stop_managed_agent_runtime(pubkey.clone(), relay_url.clone(), app.clone())?;
    start_pair(pubkey, relay_url, true, None, app)
}

/// Probe whether this agent can operate on `requested_relay_url`.
///
/// Runs a bounded authenticated query with the agent's own keys (NIP-42 +
/// NIP-OA auth tag). Auth success is the spawn-eligibility signal: NIP-29
/// membership (kind 39002) cannot exist before the agent's harness first
/// connects to a relay, so gating on membership *presence* could never
/// bootstrap a pair on a newly configured community — it only rediscovered
/// pairs that had already run. A rejected or timed-out probe surfaces as a
/// Failed status row instead of a silent skip.
async fn probe_agent_relay_access(
    state: &AppState,
    record: super::ManagedAgentRecord,
    requested_relay_url: String,
) -> Result<(super::ManagedAgentRecord, ManagedAgentRuntimeKey, String), String> {
    let key = ManagedAgentRuntimeKey::new(record.pubkey.clone(), &requested_relay_url)?;
    let keys = nostr::Keys::parse(record.private_key_nsec.trim())
        .map_err(|error| format!("invalid managed-agent key: {error}"))?;
    let api_base = crate::relay::relay_http_base_url(&key.relay_url);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        crate::relay::query_relay_at_with_keys(
            state,
            &api_base,
            &[serde_json::json!({"kinds": [39002], "#p": [record.pubkey]})],
            &keys,
            record.auth_tag.as_deref(),
        ),
    )
    .await
    .map_err(|_| "relay access probe timed out".to_string())??;
    Ok((record, key, requested_relay_url))
}

/// Build the `Failed` status row for a probe failure whose requested relay URL
/// cannot even form a pair key (so there is no canonical `relay_url` to key on).
/// The raw requested URL stands in for both the identity and the requested
/// field so the batch still degrades this one community to a visible row
/// instead of aborting every other community's row.
fn unkeyable_failed_status(
    record: &super::ManagedAgentRecord,
    requested: String,
    error: String,
    personas: &[super::AgentDefinition],
    global: &super::GlobalAgentConfig,
) -> ManagedAgentRuntimeStatus {
    let command = record_agent_command(record, personas);
    let metadata = super::known_acp_runtime(&command);
    let effective = resolve_effective_agent_env(record, personas, metadata, global);
    ManagedAgentRuntimeStatus {
        pubkey: record.pubkey.clone(),
        relay_url: requested.clone(),
        requested_relay_url: Some(requested),
        local_setup: matches!(agent_readiness(&effective), AgentReadiness::Ready),
        lifecycle: ManagedAgentRuntimeLifecycle::Failed,
        pid: None,
        error: Some(error),
        log_path: None,
    }
}

/// Spawn a lazy harness pair for every eligible (agent, community) pair.
///
/// Eligibility is deliberately gated on `start_on_app_launch`: auto-start is
/// the *proactive fan-out* policy — "keep this agent warm in every community" —
/// not a correctness prerequisite. A manual-start agent still works on demand
/// everywhere: attaching it to a channel ensures its pair, an @mention wakes a
/// pair, the members sidebar and Settings controls start pairs, and restore
/// preserves running pairs across relaunch. Fanning out warm-socket pairs for
/// agents the user chose *not* to auto-start would contradict that choice, so
/// reconcile leaves them alone until something explicitly asks for them.
#[tauri::command]
pub async fn reconcile_managed_agent_runtimes(
    communities: Vec<super::ManagedAgentCommunityTarget>,
    app: AppHandle,
) -> Result<Vec<ManagedAgentRuntimeStatus>, String> {
    use futures_util::{stream, StreamExt};

    let records = load_managed_agents(&app)?;
    let mut jobs = Vec::new();
    for community in communities {
        for record in records
            .iter()
            .filter(|record| record.start_on_app_launch && record.backend == BackendKind::Local)
        // The legacy per-record relay pin is deliberately ignored here — see
        // `effective_agent_relay_url`. Every local auto-start agent fans out
        // to every configured community.
        {
            jobs.push((record.clone(), community.relay_url.clone()));
        }
    }
    let probes: Vec<_> = stream::iter(jobs)
        .map(|(record, requested)| {
            let state = app.state::<AppState>();
            async move {
                let fallback_record = record.clone();
                let fallback_requested = requested.clone();
                probe_agent_relay_access(&state, record, requested)
                    .await
                    .map_err(|error| (fallback_record, fallback_requested, error))
            }
        })
        .buffer_unordered(6)
        .collect()
        .await;

    // start_pair does blocking work (std mutexes, process spawn, receipt
    // writes, and up-to-2s exit polling in terminate_untracked_pair_runtime),
    // so run the post-probe start loop off the async workers, matching the
    // restart flows.
    tokio::task::spawn_blocking(move || {
        let personas = load_personas(&app).unwrap_or_default();
        let global = load_global_agent_config(&app).unwrap_or_default();
        let mut rows = Vec::new();
        for probe in probes {
            match probe {
                Ok((record, key, requested)) => {
                    match start_pair(
                        record.pubkey.clone(),
                        key.relay_url.clone(),
                        true,
                        Some(&record.updated_at),
                        app.clone(),
                    ) {
                        Ok(mut status) => {
                            status.requested_relay_url = Some(requested);
                            rows.push(status);
                        }
                        Err(error) => {
                            let mut status = status_for_with(
                                &app,
                                &record,
                                &key,
                                None,
                                Some(requested),
                                StatusInputs {
                                    personas: &personas,
                                    global: &global,
                                },
                            );
                            status.lifecycle = ManagedAgentRuntimeLifecycle::Failed;
                            status.error = Some(error);
                            rows.push(status);
                        }
                    }
                }
                Err((record, requested, error)) => {
                    // Per-community degradation: a relay URL that cannot even
                    // form a pair key gets a Failed row (with the raw
                    // requested URL) like any other probe failure, instead of
                    // aborting every other community's row.
                    let status =
                        match ManagedAgentRuntimeKey::new(record.pubkey.clone(), &requested) {
                            Ok(key) => {
                                let mut status = status_for_with(
                                    &app,
                                    &record,
                                    &key,
                                    None,
                                    Some(requested),
                                    StatusInputs {
                                        personas: &personas,
                                        global: &global,
                                    },
                                );
                                status.lifecycle = ManagedAgentRuntimeLifecycle::Failed;
                                status.error = Some(error);
                                status
                            }
                            Err(_) => unkeyable_failed_status(
                                &record, requested, error, &personas, &global,
                            ),
                        };
                    rows.push(status);
                }
            }
        }
        rows
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))
}

#[cfg(test)]
mod tests;
