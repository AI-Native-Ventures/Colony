//! Managed-agent creation, shared by normal hires and approved first-job preparation.

use super::*;

/// Create an agent with the proposal executor's optional durable retry identity.
pub(crate) async fn create_managed_agent_with_creation_request(
    input: CreateManagedAgentRequest,
    app: AppHandle,
    state: &AppState,
    creation_request_id: Option<String>,
) -> Result<CreateManagedAgentResponse, String> {
    create_managed_agent_with_preparation(input, app, state, creation_request_id, None).await
}

/// Mint the explicitly approved first-job worker without starting a runtime.
/// Generic callers retain normal create behavior when preparation is absent.
pub(crate) async fn create_managed_agent_with_preparation(
    input: CreateManagedAgentRequest,
    app: AppHandle,
    state: &AppState,
    creation_request_id: Option<String>,
    preparation: Option<&crate::commands::agent_proposals::preparation::AgentProposalPreparation>,
) -> Result<CreateManagedAgentResponse, String> {
    if let Some(preparation) = preparation {
        preparation.check_create_input(&input)?;
    }
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("agent name is required".to_string());
    }
    let requested_persona_id = input
        .persona_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(parallelism) = input.parallelism {
        if !(1..=32).contains(&parallelism) {
            return Err("parallelism must be between 1 and 32".to_string());
        }
    }
    crate::managed_agents::validate_user_env_keys(&input.env_vars)?;

    // Validate & normalize the respond-to allowlist BEFORE any side effects.
    // The harness has its own validator (buzz-acp/src/config.rs) but we want
    // to catch malformed input at the boundary so the agent never tries to
    // start with a list that will crash it on launch. The mode/allowlist
    // pairing (and the definition-default fallback) is resolved later at the
    // mint site via `resolve_mint_behavioral_defaults`, where the linked
    // definition is in hand.
    let respond_to_allowlist =
        crate::managed_agents::validate_respond_to_allowlist(&input.respond_to_allowlist)?;
    if input.respond_to == Some(crate::managed_agents::RespondTo::Allowlist)
        && respond_to_allowlist.is_empty()
    {
        return Err(
            "respond-to mode 'allowlist' requires at least one pubkey in the allowlist".to_string(),
        );
    }

    // Snapshot the workspace owner pubkey for the legacy-record auth_tag
    // fallback. Computed outside the records lock to keep lock ordering simple.
    let owner_hex = {
        let _identity = preparation.map(|p| p.lock(state)).transpose()?;
        workspace_owner_hex(state)?
    };
    let (agent_keys, private_key_nsec, pubkey, resolved_relay_url, input) = {
        let _identity = preparation.map(|p| p.lock(state)).transpose()?;
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut records = load_managed_agents(&app)?;
        if let Some(preparation) = preparation {
            preparation.check_leader(&records)?;
        }
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;

        ensure_unique_creation_request(&records, creation_request_id.as_deref())?;

        let (sync_changed, exited_pubkeys) =
            sync_managed_agent_processes(&mut records, &mut runtimes, &current_instance_id(&app));
        if sync_changed {
            save_managed_agents(&app, &records)?;
        }
        for pubkey in &exited_pubkeys {
            state.clear_agent_session_caches(pubkey);
        }
        if let Some(persona_id) = requested_persona_id.as_deref() {
            let personas = load_personas(&app)?;
            ensure_persona_is_active(&personas, persona_id)?;
        }
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        if records.iter().any(|record| record.pubkey == pubkey) {
            return Err(format!("agent {pubkey} already exists"));
        }
        let private_key_nsec = keys
            .secret_key()
            .to_bech32()
            .map_err(|error| format!("failed to encode private key: {error}"))?;

        // Born pinned to its community: see `creation_relay_pin`.
        let resolved_relay_url = creation_relay_pin(
            input.relay_url.as_deref(),
            &relay_ws_url_with_override(state),
        );

        (keys, private_key_nsec, pubkey, resolved_relay_url, input)
    };

    if let BackendKind::Provider { ref config, ref id } = input.backend {
        validate_provider_config(config)?;
        // Validate via discovered candidates — not raw resolve_command.
        resolve_provider_binary(id)?;
    }

    let relay_mesh = normalize_relay_mesh(input.relay_mesh.as_ref(), &input.backend)?;

    // Agents authenticate via the auth tag in their kind:0 profile event.
    // No tokens are minted. Fail closed: bad auth tag → don't create agent.
    let auth_tag = {
        let _identity = preparation.map(|p| p.lock(state)).transpose()?;
        let owner_keys = state.signing_keys()?;
        // Bridge nostr 0.37 → 0.36 (buzz-sdk) via hex round-trip.
        let compat_owner = nostr::Keys::parse(&owner_keys.secret_key().to_secret_hex())
            .map_err(|e| format!("failed to bridge owner keys: {e}"))?;
        let compat_agent = nostr::PublicKey::from_hex(&agent_keys.public_key().to_hex())
            .map_err(|e| format!("failed to bridge agent pubkey: {e}"))?;
        let tag = buzz_sdk_pkg::nip_oa::compute_auth_tag(&compat_owner, &compat_agent, "")
            .map_err(|e| format!("failed to compute NIP-OA auth tag: {e}"))?;
        Some(tag)
    };

    let (agent, resolved_avatar_url, resolved_role_id) = {
        let _identity = preparation.map(|p| p.lock(state)).transpose()?;
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut records = load_managed_agents(&app)?;
        if let Some(preparation) = preparation {
            preparation.check_leader(&records)?;
        }
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

        // Repeat under the final durable-write lock to close concurrent replay.
        ensure_unique_creation_request(&records, creation_request_id.as_deref())?;

        // Guard against a duplicate pubkey appearing between phase 1 and phase 3
        // (extremely unlikely but safe to check).
        if records.iter().any(|record| record.pubkey == pubkey) {
            return Err(format!("agent {pubkey} already exists"));
        }
        // Provider config was already validated in Pre-Phase 2; cache the discovered binary path for deploy_to_provider.
        let provider_binary_path = if let BackendKind::Provider { ref id, .. } = input.backend {
            // Use resolve_provider_binary (discovered candidates only).
            resolve_provider_binary(id)
                .ok()
                .map(|p| p.display().to_string())
        } else {
            None
        };

        // Load personas once for harness/pack/avatar resolution below.
        let personas = load_personas(&app).unwrap_or_default();
        if let Some(preparation) = preparation {
            let definition = personas
                .iter()
                .find(|definition| Some(definition.id.as_str()) == requested_persona_id.as_deref())
                .ok_or_else(|| {
                    "The approved worker definition is no longer available.".to_string()
                })?;
            preparation.check_definition(definition)?;
        }

        // Harness resolution: the persona's runtime is authoritative. A
        // persona-backed create stores an `agent_command_override` ONLY when the
        // user deliberately picked a divergent runtime (`harness_override`) —
        // e.g. AddChannelBotDialog's runtime selector. A divergence WITHOUT that
        // flag is a missing-runtime fallback from `resolvePersonaRuntime`, not a
        // pin, and must inherit so it doesn't freeze on the fallback harness once
        // the persona's runtime is installed. A persona-less create always
        // preserves the picked command as a real pin.
        let agent_command_override = crate::managed_agents::create_time_agent_command_override(
            requested_persona_id.as_deref(),
            &personas,
            input.agent_command.as_deref(),
            input.harness_override,
        );
        // The create-time snapshot used for arg/mcp/avatar derivations and
        // legacy reconcile. Authoritative spawn resolution re-derives this via
        // `effective_agent_command` at use-time.
        let agent_command = crate::managed_agents::effective_agent_command(
            requested_persona_id.as_deref(),
            &personas,
            agent_command_override.as_deref(),
        );
        let agent_args = normalize_agent_args(
            &agent_command,
            input
                .agent_args
                .iter()
                .map(|arg| arg.trim().to_string())
                .filter(|arg| !arg.is_empty())
                .collect::<Vec<_>>(),
        );

        // Derive MCP command exclusively from the runtime catalog — the
        // per-record field is never read at spawn time so user-supplied input
        // is silently discarded. Always sourcing from the catalog ensures
        // new agents pick up the correct value without any stored override.
        let mcp_command = match crate::managed_agents::known_acp_runtime(&agent_command) {
            Some(p) => p.mcp_command.unwrap_or("").to_string(),
            None => String::new(),
        };

        let team_id = input
            .team_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(team_id) = &team_id {
            if !load_teams(&app)?.iter().any(|team| &team.id == team_id) {
                return Err(format!("team {team_id} not found"));
            }
        }

        // Resolve the avatar URL once at creation and persist it on the record.
        // Explicit input wins, then the persona's own avatar, then the runtime
        // fallback. Storing it lets reconciliation compare against what was
        // actually published instead of re-deriving it.
        let persona_avatar_url = requested_persona_id.as_ref().and_then(|persona_id| {
            personas
                .iter()
                .find(|persona| persona.id == *persona_id)?
                .avatar_url
                .clone()
        });
        let resolved_avatar_url = resolve_created_avatar_url(
            input.avatar_url.as_deref(),
            persona_avatar_url,
            &agent_command,
        );

        // Pin the persona config onto the record at create. After this, spawn
        // and deploy read these snapshotted fields, never the live persona, so
        // the agent stays on the config it was created with across restarts;
        // delete+respawn re-runs create and rewrites the snapshot. env_vars are
        // NOT pinned: `record.env_vars` holds agent-level overrides only
        // (input.env_vars), and the live persona env is merged underneath at
        // read time (spawn / readiness / deploy) so persona credential edits
        // refresh on the next spawn like prompt/model/provider already do.
        let linked_persona = requested_persona_id.as_deref().and_then(|pid| {
            load_personas(&app)
                .ok()?
                .into_iter()
                .find(|persona| persona.id == pid)
        });
        let persona_snapshot = linked_persona
            .as_ref()
            .map(crate::managed_agents::persona_events::persona_snapshot);
        let snapshot_prompt = persona_snapshot
            .as_ref()
            .and_then(|s| s.system_prompt.clone());
        let snapshot_model = persona_snapshot.as_ref().and_then(|s| s.model.clone());
        let snapshot_provider = persona_snapshot.as_ref().and_then(|s| s.provider.clone());
        let snapshot_source_version = persona_snapshot.as_ref().map(|s| s.source_version.clone());
        let effective_provider = snapshot_provider
            .or_else(|| input.provider.as_deref().and_then(trim_to_optional_string));
        let mut effective_model =
            snapshot_model.or_else(|| input.model.as_deref().and_then(trim_to_optional_string));
        if effective_provider.as_deref() == Some(crate::managed_agents::RELAY_MESH_PROVIDER_ID)
            && effective_model.is_none()
        {
            effective_model = Some(crate::managed_agents::RELAY_MESH_AUTO_MODEL_ID.to_string());
        }

        // Mint-time behavior: explicit input, linked definition, then defaults.
        // Parse only here, failing rather than minting an undescribed agent.
        let minted = crate::managed_agents::resolve_mint_behavioral_defaults(
            input.respond_to,
            respond_to_allowlist.clone(),
            input.parallelism,
            linked_persona.as_ref(),
        )?;

        // The role two members' instances share, inherited from the linked
        // definition (docs/design/role-agents.html).
        let mut record = crate::managed_agents::ManagedAgentRecord {
            working_dir: None,
            pubkey: pubkey.clone(),
            name: name.clone(),
            role_id: linked_persona
                .as_ref()
                .and_then(|persona| persona.role_id.clone()),
            role_title: linked_persona
                .as_ref()
                .and_then(|persona| persona.role_title.clone()),
            persona_id: requested_persona_id.clone(),
            creation_request_id: creation_request_id.clone(),
            team_id,
            private_key_nsec: private_key_nsec.clone(),
            auth_tag: auth_tag.clone(),
            relay_url: resolved_relay_url.clone(),
            owner_pubkey: Some(owner_hex.clone()), // identity axis; see managed_agents::owner_scope
            avatar_url: resolved_avatar_url.clone(),
            acp_command: input
                .acp_command
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(DEFAULT_ACP_COMMAND)
                .to_string(),
            agent_command,
            agent_command_override,
            agent_args,
            mcp_command,
            // BUZZ_ACP_TURN_TIMEOUT is deprecated and ignored by the harness;
            // store the schema default only. Use idle_timeout_seconds or
            // max_turn_duration_seconds for actual turn-length control.
            turn_timeout_seconds: DEFAULT_AGENT_TURN_TIMEOUT_SECONDS,
            // 0 or None → harness uses its own default (320s idle, 3600s max), and the CLI also clamps 0 → minimum.
            idle_timeout_seconds: input.idle_timeout_seconds.filter(|s| *s > 0),
            max_turn_duration_seconds: input.max_turn_duration_seconds.filter(|s| *s > 0),
            parallelism: minted.parallelism.unwrap_or(DEFAULT_AGENT_PARALLELISM),
            system_prompt: snapshot_prompt.or_else(|| {
                input
                    .system_prompt
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            }),
            model: effective_model.clone(),
            provider: effective_provider.clone(),
            persona_source_version: snapshot_source_version,
            // Provider agents are managed externally — force false.
            start_on_app_launch: if input.backend != BackendKind::Local {
                false
            } else {
                input.start_on_app_launch
            },
            auto_restart_on_config_change: true,
            runtime_pid: None,
            backend: input.backend.clone(),
            backend_agent_id: None,
            provider_binary_path,
            persona_team_dir: None,
            persona_name_in_team: None,
            env_vars: input.env_vars.clone(),
            created_at: now_iso(),
            updated_at: now_iso(),
            last_started_at: None,
            last_stopped_at: None,
            last_exit_code: None,
            last_error: None,
            last_error_code: None,
            respond_to: minted.respond_to,
            respond_to_allowlist: minted.respond_to_allowlist.clone(),
            display_name: None,
            slug: None,
            runtime: None,
            tier: preparation.map(|_| "worker".to_string()),
            manager: preparation.map(|p| p.leader_pubkey.clone()),
            name_pool: Vec::new(),
            is_builtin: false,
            provisioned_by: None,
            provisioned_version: None,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            definition_respond_to: None,
            definition_respond_to_allowlist: Vec::new(),
            definition_parallelism: None,
            relay_mesh: if effective_provider.as_deref()
                == Some(crate::managed_agents::RELAY_MESH_PROVIDER_ID)
            {
                effective_model
                    .clone()
                    .map(|model_ref| RelayMeshConfig { model_ref })
            } else {
                relay_mesh.clone()
            },
        };

        // Mirrors COLONY_WORKTREE into `env_vars` so the tile chip and the
        // spawned child name the same directory.
        record.set_working_dir(input.working_dir.clone());

        records.push(record);

        save_managed_agents(&app, &records)?;

        // Best-effort hire hook, which must never block agent creation: put
        // the persona on the coordination team of the community hired into.
        if let Some(persona_id) = requested_persona_id.as_deref() {
            enrol_persona_in_coordination_team_after_hire(&app, persona_id, &resolved_relay_url);
        }

        let record = records
            .iter()
            .find(|record| record.pubkey == pubkey)
            .ok_or_else(|| "created agent disappeared unexpectedly".to_string())?;
        // Publish the agent to the relay. Inside the Phase-3 lock, after save,
        // before any .await — owner-authored, every agent (Will's ruling: no
        // is_builtin/persona-membership gate).
        retain_managed_agent_pending(&app, state, record);
        let personas = load_personas(&app).unwrap_or_default();
        (
            build_managed_agent_summary(
                &app,
                record,
                &runtimes,
                &personas,
                &crate::managed_agents::load_global_agent_config(&app).unwrap_or_default(),
            )?,
            resolved_avatar_url,
            record.role_id.clone(),
        )
    };

    let mut spawn_error = None;
    let agent = if input.spawn_after_create && input.backend == BackendKind::Local {
        match start_local_agent_with_preflight(&app, state, &pubkey, &owner_hex, true).await {
            Ok(agent) => agent,
            Err(error) => {
                let _store_guard = state
                    .managed_agents_store_lock
                    .lock()
                    .map_err(|e| e.to_string())?;
                let mut records = load_managed_agents(&app)?;
                let runtimes = state
                    .managed_agent_processes
                    .lock()
                    .map_err(|e| e.to_string())?;
                let record = find_managed_agent_mut(&mut records, &pubkey)?;
                record.updated_at = now_iso();
                record.last_error = Some(error.clone());
                save_managed_agents(&app, &records)?;
                spawn_error = Some(error);
                let record = records
                    .iter()
                    .find(|record| record.pubkey == pubkey)
                    .ok_or_else(|| "created agent disappeared unexpectedly".to_string())?;
                let personas = load_personas(&app).unwrap_or_default();
                build_managed_agent_summary(
                    &app,
                    record,
                    &runtimes,
                    &personas,
                    &crate::managed_agents::load_global_agent_config(&app).unwrap_or_default(),
                )?
            }
        }
    } else {
        agent
    };

    try_regenerate_nest(&app);

    // Use the avatar persisted on the record so the published profile and any
    // later reconciliation agree on the same value.
    let profile_relay_url = crate::relay::effective_agent_relay_url(
        &resolved_relay_url,
        &relay_ws_url_with_override(state),
    );
    let profile_sync_error = (sync_managed_agent_profile(
        state,
        &profile_relay_url,
        &agent_keys,
        &name,
        resolved_avatar_url.as_deref(),
        auth_tag.as_deref(),
        resolved_role_id.as_deref(),
    )
    .await)
        .err();

    let spawn_error = if input.spawn_after_create && input.backend != BackendKind::Local {
        if let BackendKind::Provider { ref id, ref config } = input.backend {
            // Read the saved record to build the deploy payload (record has the
            // canonical field values after Phase 3 normalization).
            let agent_json = {
                let _g = state
                    .managed_agents_store_lock
                    .lock()
                    .map_err(|e| e.to_string())?;
                let records = load_managed_agents(&app)?;
                let rec = records
                    .iter()
                    .find(|r| r.pubkey == pubkey)
                    .ok_or_else(|| "agent disappeared".to_string())?;
                build_deploy_payload(&app, state, rec)?
            };
            match deploy_to_provider(&app, state, &pubkey, id, config, agent_json, None).await {
                Ok(()) => spawn_error,
                Err(e) => Some(e),
            }
        } else {
            spawn_error
        }
    } else {
        spawn_error
    };

    // Rebuild summary if provider deploy may have updated backend_agent_id.
    let final_agent = if input.backend != BackendKind::Local && spawn_error.is_none() {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let records = load_managed_agents(&app)?;
        let runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        let record = records
            .iter()
            .find(|r| r.pubkey == pubkey)
            .ok_or_else(|| "agent disappeared".to_string())?;
        let personas = load_personas(&app).unwrap_or_default();
        build_managed_agent_summary(
            &app,
            record,
            &runtimes,
            &personas,
            &crate::managed_agents::load_global_agent_config(&app).unwrap_or_default(),
        )?
    } else {
        agent
    };

    Ok(CreateManagedAgentResponse {
        agent: final_agent,
        private_key_nsec,
        profile_sync_error,
        spawn_error,
    })
}
