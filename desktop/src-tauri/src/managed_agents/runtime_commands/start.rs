use super::start_scope::{check_spawned, current_owner, StartOwnerGuard};
use super::*;
use crate::managed_agents::config_start::ConfigStartFence;
use crate::managed_agents::owner_scope::effective_owner_pubkey;

/// Start a captured relay pair, retaining an optional expected owner through spawn.
pub(super) fn start_pair(
    pubkey: String,
    relay_url: String,
    lazy: bool,
    expected_updated_at: Option<&str>,
    expected_owner_pubkey: Option<String>,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    start_pair_with_config(
        pubkey,
        relay_url,
        lazy,
        expected_updated_at,
        expected_owner_pubkey,
        None,
        app,
    )
}

pub(super) fn start_pair_with_config(
    pubkey: String,
    relay_url: String,
    lazy: bool,
    expected_updated_at: Option<&str>,
    expected_owner_pubkey: Option<String>,
    config_fence: Option<ConfigStartFence>,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    let state = app.state::<AppState>();
    let owner_guard = StartOwnerGuard::capture(expected_owner_pubkey, || current_owner(&state))?;
    let (key, spawn_record) = {
        let _context = config_fence
            .as_ref()
            .map(|fence| fence.lock_context(&state))
            .transpose()?;
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
        owner_guard.check_current(|| current_owner(&state))?;
        owner_guard.check_record(effective_owner_pubkey(record).as_deref())?;
        if record.backend != BackendKind::Local {
            return Err("managed runtime pairs require a local agent".into());
        }
        // The boundary is enforced here as well as in reconcile, because a
        // start can also arrive straight from the UI with whatever community
        // is open. An agent pinned elsewhere must not spawn against this
        // relay, publish a profile on it, or read its channels.
        if !crate::relay::agent_belongs_to_workspace(&record.relay_url, &relay_url) {
            return Err(format!(
                "{} belongs to another community ({}) and cannot run on {relay_url}",
                record.name, record.relay_url
            ));
        }
        if expected_updated_at.is_some_and(|expected| record.updated_at != expected) {
            return Err("managed agent changed while runtime reconciliation was in flight".into());
        }
        let key = ManagedAgentRuntimeKey::new(pubkey, &relay_url)?;
        let _publication = config_fence
            .as_ref()
            .map(|fence| fence.lock_config(&app))
            .transpose()?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        let pair_running = runtimes
            .get_mut(&key)
            .is_some_and(|runtime| runtime.child.try_wait().ok().flatten().is_none());
        if pair_running {
            if let (Some(fence), Some(runtime)) = (&config_fence, runtimes.get(&key)) {
                fence.check_process(
                    &app,
                    record,
                    &runtime.spawn_config,
                    runtime.provisioned_lease.is_some(),
                    runtime.setup_mode,
                )?;
            }
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

    owner_guard.check_current(|| current_owner(&state))?;
    let owner = owner_guard.owner().map(str::to_owned).or_else(|| {
        state
            .keys
            .lock()
            .ok()
            .map(|keys| keys.public_key().to_hex())
    });
    let mut process = super::super::runtime::spawn_agent_child_with_config(
        &app,
        &spawn_record,
        &key.relay_url,
        lazy,
        owner.as_deref(),
        config_fence.as_ref(),
    )?;
    let process_log_path = process.log_path.clone();

    let _context = check_spawned(
        config_fence
            .as_ref()
            .map(|fence| fence.lock_context(&state))
            .transpose(),
        &mut process.child,
    )?;
    let _transition = check_spawned(
        state
            .managed_agent_runtime_transition
            .lock()
            .map_err(|e| e.to_string()),
        &mut process.child,
    )?;
    let _store = check_spawned(
        state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string()),
        &mut process.child,
    )?;
    check_spawned(
        owner_guard.check_current(|| current_owner(&state)),
        &mut process.child,
    )?;
    if state.shutdown_started.load(Ordering::Acquire) {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        return Err("desktop shutdown has started".into());
    }
    if !super::super::provisioned_process_matches_current_identity(&app, &key.relay_url, &process) {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        return Err("Colony Credits identity changed during spawn; retry reconnect".into());
    }
    let mut records = check_spawned(load_managed_agents(&app), &mut process.child)?;
    let record = check_spawned(
        find_managed_agent_mut(&mut records, &key.pubkey),
        &mut process.child,
    )?;
    check_spawned(
        owner_guard.check_record(effective_owner_pubkey(record).as_deref()),
        &mut process.child,
    )?;
    if owner_guard.owner().is_some()
        && !crate::relay::agent_belongs_to_workspace(&record.relay_url, &key.relay_url)
    {
        return check_spawned(
            Err("The teammate changed communities while starting.".into()),
            &mut process.child,
        );
    }
    if expected_updated_at.is_some_and(|expected| record.updated_at != expected) {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        return Err("managed agent changed while runtime reconciliation was in flight".into());
    }
    let _publication = check_spawned(
        config_fence
            .as_ref()
            .map(|fence| fence.lock_config(&app))
            .transpose(),
        &mut process.child,
    )?;
    if let Some(fence) = &config_fence {
        let current = fence.check_process(
            &app,
            record,
            &process.spawn_config,
            process.provisioned_lease.is_some(),
            process.setup_mode,
        );
        check_spawned(current, &mut process.child)?;
    }
    let mut runtimes = check_spawned(
        state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string()),
        &mut process.child,
    )?;
    let pair_running = runtimes
        .get_mut(&key)
        .is_some_and(|runtime| runtime.child.try_wait().ok().flatten().is_none());
    if pair_running {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        if let (Some(fence), Some(runtime)) = (&config_fence, runtimes.get(&key)) {
            fence.check_process(
                &app,
                record,
                &runtime.spawn_config,
                runtime.provisioned_lease.is_some(),
                runtime.setup_mode,
            )?;
        }
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
    check_spawned(
        owner_guard.check_current(|| current_owner(&state)),
        &mut process.child,
    )?;
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
    let reconcile_data =
        crate::commands::ProfileReconcileData::build(&app, record, &reconcile_personas);
    check_spawned(
        owner_guard.check_current(|| current_owner(&state)),
        &mut process.child,
    )?;
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
