//! Builds one agent's `ManagedAgentSummary`: live status, effective configuration,
//! and the restart diff the badge reads.

use super::*;

pub fn build_managed_agent_summary(
    app: &AppHandle,
    record: &ManagedAgentRecord,
    runtimes: &HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
    personas: &[crate::managed_agents::types::AgentDefinition],
    global_config: &crate::managed_agents::GlobalAgentConfig,
) -> Result<ManagedAgentSummary, String> {
    use crate::managed_agents::BackendKind;

    // Community-scoped truth: this summary describes the pair for the active
    // workspace relay. An agent running only in another community must read
    // as stopped here — matching by pubkey alone would show every community a
    // green light as long as any pair anywhere is alive.
    let pair_key = workspace_pair_key(app, record);
    let pair_runtime = pair_key.as_ref().and_then(|key| runtimes.get(key));

    let (status, pid, log_path) = if record.backend != BackendKind::Local {
        // Two-axis status model for remote agents:
        //
        //   Control-plane (this field): "deployed" = provider has been invoked and
        //   returned a backend_agent_id. "not_deployed" = no deploy call yet (or it
        //   failed). This axis tracks whether infrastructure *exists*, not whether
        //   the process is currently running.
        //
        //   Live axis (relay presence, polled by frontend): online/away/offline.
        //   Shown as a PresenceDot next to the agent name. This is the real-time
        //   signal for whether the harness is connected.
        //
        // After !shutdown the agent goes offline (presence) but stays "deployed"
        // (infrastructure still exists). This is intentional — the provider may
        // have allocated a VM/container that persists across process restarts.
        // A future provider `undeploy` operation (v2) will handle teardown.
        let status = if record.backend_agent_id.is_some() {
            "deployed".to_string()
        } else {
            "not_deployed".to_string()
        };
        (status, None, String::new())
    } else {
        let persisted_pid = record.runtime_pid.filter(|pid| process_is_running(*pid));
        if let Some(runtime) = pair_runtime {
            (
                "running".to_string(),
                Some(runtime.child.id()),
                runtime.log_path.display().to_string(),
            )
        } else if let Some(pid) = persisted_pid {
            (
                "running".to_string(),
                Some(pid),
                managed_agent_log_path(app, &record.pubkey)?
                    .display()
                    .to_string(),
            )
        } else {
            (
                "stopped".to_string(),
                None,
                managed_agent_log_path(app, &record.pubkey)?
                    .display()
                    .to_string(),
            )
        }
    };

    let (persona_out_of_date, persona_orphaned) = persona_drift_state(record, personas);

    let global_for_summary =
        crate::managed_agents::load_global_agent_config(app).unwrap_or_default();
    let effective_cfg = crate::managed_agents::effective_config::resolve_effective_config(
        record,
        personas,
        &global_for_summary,
    );
    let (effective_model, effective_provider, effective_prompt, model_source) = match effective_cfg
    {
        crate::managed_agents::effective_config::EffectiveConfigResult::Resolved(cfg) => {
            let source = cfg.model.source.clone();
            (
                cfg.model.value,
                cfg.provider.value,
                cfg.system_prompt.value,
                Some(source),
            )
        }
        crate::managed_agents::effective_config::EffectiveConfigResult::OrphanedInstance {
            record_pubkey,
            missing_persona_id,
        } => {
            eprintln!(
                "orphaned agent instance: pubkey={record_pubkey}, missing_persona_id={missing_persona_id}"
            );
            (None, None, None, None)
        }
    };

    // Restart badge: the running process stamped the effective spawn config
    // it was launched with; recompute a prospective one from current disk
    // state and report every differing field. Only the tracked live pair for
    // THIS workspace can drift — stopped agents spawn fresh, adopted
    // (runtime_pid-only) processes have no stamp to compare, and pairs running
    // for other communities are judged in their own community (comparing them
    // against this workspace's relay would flag a spurious restart on every
    // community switch).
    //
    // Adapter-availability drift (codex only) contributes its own synthetic
    // entry, so an out-of-band adapter change (manual npm install/downgrade)
    // that Phase-1 auto-restart doesn't cover still shows the user what moved.
    // The cache is read-only here — no subprocess is spawned.
    //
    // Global config drives both the prospective snapshot and the descriptor
    // env layering below — the caller loads it once and passes it in, so
    // list-style callers pay one disk read per call rather than one per record.

    // The prospective side is computed only for a tracked pair: it costs a
    // teams-store read, and an unstamped agent has nothing to compare against.
    let tracked_spawn = pair_key.as_ref().zip(pair_runtime).map(|(key, runtime)| {
        let teams = crate::managed_agents::load_teams(app).unwrap_or_default();
        let current = crate::managed_agents::spawn_snapshot::prospective_spawn_config_snapshot(
            record,
            personas,
            &teams,
            &key.relay_url,
            global_config,
        );
        (runtime, current)
    });
    let restart_diff = crate::managed_agents::spawn_snapshot::eligible_restart_diff(
        persona_orphaned,
        tracked_spawn.as_ref().map(|(runtime, current)| {
            crate::managed_agents::spawn_snapshot::TrackedSpawnState {
                stamped: &runtime.spawn_config,
                current,
                stamped_availability: runtime.adapter_availability.as_ref(),
                current_availability: crate::managed_agents::adapter_availability_cached(),
            }
        }),
    );
    // One vector is the whole truth: badge on ⟺ there is a diff to show.
    let needs_restart = !restart_diff.is_empty();

    // Resolve the effective harness via the single typed descriptor — same resolver
    // as spawn, so the UI reflects the persona's current harness (or explicit pin).
    let descriptor = crate::managed_agents::resolve_effective_harness_descriptor(
        record,
        personas,
        global_config,
    )
    .unwrap_or_else(|e| {
        // Dangling harness — surface the missing id so the UI tells the same
        // story as spawn (which refuses with a sentence), rather than silently
        // showing the default-command fallback as if the agent were healthy.
        let cmd = match crate::managed_agents::dangling_harness_id(&e) {
            Some(id) => crate::managed_agents::dangling_harness_display(id),
            None => crate::managed_agents::record_agent_command(record, personas),
        };
        let args = normalize_agent_args(&cmd, record.agent_args.clone());
        crate::managed_agents::readiness::EffectiveHarnessDescriptor {
            command: cmd,
            args,
            env: Default::default(),
        }
    });
    let effective_mcp_command = known_acp_runtime(&descriptor.command)
        .and_then(|r| r.mcp_command)
        .unwrap_or("")
        .to_string();

    Ok(ManagedAgentSummary {
        working_dir: record.working_dir.clone(),
        pubkey: record.pubkey.clone(),
        owner_identified: crate::managed_agents::owner_scope::effective_owner_pubkey(record)
            .is_some(),
        provisioned: record.provisioned.clone(),
        isolated: pair_runtime.is_some_and(|runtime| runtime.isolation_network.is_some()),
        browser_generation: pair_runtime
            .filter(|runtime| runtime.isolation_network.is_some())
            .map(|runtime| runtime.start_nonce.clone()),
        name: record.name.clone(),
        persona_id: record.persona_id.clone(),
        runtime: record.runtime.clone(),
        team_id: record.team_id.clone(),
        relay_url: record.relay_url.clone(),
        acp_command: record.acp_command.clone(),
        agent_command: descriptor.command,
        agent_command_override: record.agent_command_override.clone(),
        agent_args: descriptor.args,
        mcp_command: effective_mcp_command,
        turn_timeout_seconds: record.turn_timeout_seconds,
        idle_timeout_seconds: record.idle_timeout_seconds,
        max_turn_duration_seconds: record.max_turn_duration_seconds,
        parallelism: record.parallelism,
        system_prompt: effective_prompt,
        avatar_url: record.avatar_url.clone(),
        model: effective_model,
        model_source,
        provider: effective_provider,
        persona_out_of_date,
        persona_orphaned,
        needs_restart,
        restart_diff,
        env_vars: record.env_vars.clone(),
        backend: record.backend.clone(),
        backend_agent_id: record.backend_agent_id.clone(),
        status,
        pid,
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
        last_started_at: record.last_started_at.clone(),
        last_stopped_at: record.last_stopped_at.clone(),
        last_exit_code: record.last_exit_code,
        last_error: record.last_error.clone(),
        last_error_code: record.last_error_code,
        start_on_app_launch: record.start_on_app_launch,
        auto_restart_on_config_change: record.auto_restart_on_config_change,
        log_path,
        respond_to: record.respond_to,
        respond_to_allowlist: record.respond_to_allowlist.clone(),
    })
}
