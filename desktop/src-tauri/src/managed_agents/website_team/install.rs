//! Install orchestration for the bundled Website Manager recipe.
//!
//! Deterministic identity, record reconciliation, captured-scope retention,
//! and a bounded journal. See the module docs on [`super`].

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use buzz_core_pkg::kind::{KIND_MANAGED_AGENT, KIND_PERSONA, KIND_TEAM};
use nostr::JsonUtil;
use rusqlite::Connection;
use tauri::AppHandle;

use crate::app_state::AppState;
use crate::managed_agents::retention::{
    active_retention_scope, delete_retained_event, get_retained_event, open_retention_db,
    retain_event, scoped_retention_db_path, RetainedEvent, RetentionScope,
};
use crate::managed_agents::{
    load_managed_agents, load_personas, load_teams, persona_events, save_managed_agents,
    save_personas, save_teams, AgentDefinition, CreateManagedAgentRequest, ManagedAgentRecord,
    TeamRecord,
};
use crate::relay::agent_boundary::canonical;
use crate::util::now_iso;

use super::journal::{self, scope_key, WebsiteTeamJournalEntry};
use super::provisioning::{
    apply_recipe_to_agent, apply_recipe_to_definition, apply_recipe_to_team, UpgradeSummary,
};
use super::recipe::{
    persona_system_prompt, RecipePersona, AVERY_PERSONA_ID, PERSONAS, RECIPE_ID, RECIPE_VERSION,
    TEAM_DESCRIPTION, TEAM_INSTRUCTIONS, TEAM_NAME,
};
use super::skills::{install_recipe_skills, InstalledWebsiteSkill};
use super::{
    agent_request_id, InstallWebsiteTeamRequest, InstallWebsiteTeamResult, InstalledWebsitePersona,
    PublicationEntry, WebsiteTeamPublication, PUBLICATION_MISSING, PUBLICATION_PUBLISHED,
    PUBLICATION_QUEUED,
};

static INSTALL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Immutable scope captured before any async work. Every write goes through
/// this, so a community switch mid-install cannot retarget a mutation.
struct InstallContext<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
    scope: &'a RetentionScope,
    owner: String,
    relay_url: String,
    canonical_relay: String,
    team_id: String,
}

/// The durable install journal entry for the active community, if the
/// installer has ever completed a run there. Safe fields only.
pub fn install_status(
    app: &AppHandle,
    state: &AppState,
) -> Result<Option<WebsiteTeamJournalEntry>, String> {
    journal::status_for_active_scope(app, state)
}

pub async fn install_website_team(
    app: &AppHandle,
    state: &AppState,
    request: InstallWebsiteTeamRequest,
) -> Result<InstallWebsiteTeamResult, String> {
    if INSTALL_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(
            "A Website Manager installation is already running. Wait for it to finish, then retry."
                .to_string(),
        );
    }
    let outcome = install_inner(app, state, request).await;
    INSTALL_IN_FLIGHT.store(false, Ordering::SeqCst);
    outcome
}

async fn install_inner(
    app: &AppHandle,
    state: &AppState,
    request: InstallWebsiteTeamRequest,
) -> Result<InstallWebsiteTeamResult, String> {
    let scope = active_retention_scope(app, state)?;
    if scope.relay_url.trim().is_empty() {
        return Err("Select a community before installing the Website Manager team.".to_string());
    }
    let owner = scope.owner_keys.public_key().to_hex();
    let canonical_relay = canonical(&scope.relay_url);
    let team_id = super::team_id_for_relay(&scope.relay_url)
        .ok_or_else(|| "Could not derive a community team id for this relay.".to_string())?;
    let ctx = InstallContext {
        app,
        state,
        scope: &scope,
        owner,
        relay_url: scope.relay_url.clone(),
        canonical_relay: canonical_relay.clone(),
        team_id: team_id.clone(),
    };

    let mut notes: Vec<String> = Vec::new();

    // Phase A: seed definitions and the community team, retaining their heads
    // into the captured scope. Existing provisioned records are upgraded when
    // their recorded version is behind this recipe.
    let seeded = seed_records(&ctx, &mut notes)?;
    let mut upgrade = seeded.upgrade.clone();

    // Phase A2: write the skills into the agent workspace.
    let skills = install_skills(&mut notes);

    // Phase B: one managed agent per persona, in order, so Avery's pubkey is
    // known before the workers get their manager.
    let mut agents: Vec<ManagedAgentRecord> = Vec::with_capacity(PERSONAS.len());
    let mut installed_personas: Vec<InstalledWebsitePersona> = Vec::with_capacity(PERSONAS.len());
    let mut avery_pubkey: Option<String> = None;
    let mut created_agents = 0u32;

    for persona in PERSONAS {
        if !scope_matches(state, &ctx.relay_url, &ctx.owner) {
            return Err(
                "The active community or identity changed during installation. Records already created are complete and the rest were not started; retry in the community you want."
                    .to_string(),
            );
        }
        let request_id = agent_request_id(&ctx.owner, &ctx.relay_url, persona.persona_id);
        let manager_pubkey = if persona.persona_id == AVERY_PERSONA_ID {
            None
        } else {
            avery_pubkey.as_deref()
        };
        let (record, created, agent_upgrade) =
            ensure_agent(&ctx, persona, &request_id, manager_pubkey, &mut notes).await?;
        if created {
            created_agents += 1;
        } else {
            upgrade.merge(agent_upgrade);
        }
        if persona.persona_id == AVERY_PERSONA_ID {
            avery_pubkey = Some(record.pubkey.clone());
        }
        installed_personas.push(InstalledWebsitePersona {
            persona_id: persona.persona_id.to_string(),
            slug: persona.slug.to_string(),
            display_name: persona.display_name.to_string(),
            role_id: persona.role_id.to_string(),
            role_title: persona.role_title.to_string(),
            tier: persona.tier.to_string(),
            color_index: persona.color_index,
            agent_pubkey: record.pubkey.clone(),
            agent_name: record.name.clone(),
            manager_pubkey: record.manager.clone(),
            created,
            assigned_skills: persona
                .skill_names
                .iter()
                .map(|name| name.to_string())
                .collect(),
        });
        agents.push(record);
    }

    // Compensate for a community switch inside the create path: its internal
    // retain resolves the *active* scope, so a switched community may hold a
    // stray managed-agent head. The captured-scope rows were written above.
    scrub_other_scope_agent_rows(&ctx, &agents, &mut notes);

    // Phase C: publish now and read back the real per-coordinate status.
    let same_scope = scope_matches(state, &ctx.relay_url, &ctx.owner);
    let publication_detail = if same_scope {
        match crate::managed_agents::persona_events::flush_active_pending_events(app, state).await
        {
            Ok(_) => None,
            Err(error) => Some(format!(
                "The relay could not be reached to publish yet, so the heads are queued and retry automatically: {error}"
            )),
        }
    } else {
        Some(
            "The active community changed during installation. Heads stay queued for their own community and publish on its next sync."
                .to_string(),
        )
    };
    let mut publication = read_publication(&ctx, &seeded.definitions, &agents)?;
    publication.detail = publication_detail;

    // Phase D: durable, bounded journal entry for this scope.
    let request_ids: Vec<String> = PERSONAS
        .iter()
        .map(|persona| agent_request_id(&ctx.owner, &ctx.relay_url, persona.persona_id))
        .collect();
    let entry = WebsiteTeamJournalEntry {
        scope_key: scope_key(&ctx.owner, &ctx.canonical_relay),
        owner_pubkey: ctx.owner.clone(),
        relay_url: ctx.relay_url.clone(),
        team_id: ctx.team_id.clone(),
        persona_ids: PERSONAS.iter().map(|p| p.persona_id.to_string()).collect(),
        agent_pubkeys: agents.iter().map(|record| record.pubkey.clone()).collect(),
        request_ids,
        recipe_version: RECIPE_VERSION.to_string(),
        channel_id: request.channel_id.clone(),
        upgraded_from: if upgrade.upgraded {
            upgrade.from.clone()
        } else {
            None
        },
        upgraded_to: if upgrade.upgraded {
            Some(RECIPE_VERSION.to_string())
        } else {
            None
        },
        updated_at: now_iso(),
    };
    match journal::journal_path(app) {
        Ok(path) => {
            if let Err(error) = journal::record_entry(&path, entry) {
                notes.push(format!("Install journal could not be updated: {error}"));
            }
        }
        Err(error) => notes.push(format!("Install journal unavailable: {error}")),
    }

    let reconciled = seeded.team_existed && created_agents == 0;
    Ok(InstallWebsiteTeamResult {
        recipe_id: RECIPE_ID.to_string(),
        recipe_version: RECIPE_VERSION.to_string(),
        relay_url: ctx.relay_url.clone(),
        community_key: ctx.canonical_relay.clone(),
        owner_pubkey: ctx.owner.clone(),
        team_id: ctx.team_id.clone(),
        team_name: seeded.team.name.clone(),
        team_existed: seeded.team_existed,
        channel_id: request.channel_id,
        seed_url: request.seed_url,
        starter_prompt: request.starter_prompt,
        personas: installed_personas,
        skills,
        publication,
        created_agents,
        reconciled,
        upgraded: upgrade.upgraded,
        upgraded_from: upgrade.from.clone(),
        upgraded_to: if upgrade.upgraded {
            Some(RECIPE_VERSION.to_string())
        } else {
            None
        },
        notes,
    })
}

struct SeededRecords {
    team: TeamRecord,
    team_existed: bool,
    definitions: Vec<AgentDefinition>,
    upgrade: UpgradeSummary,
}

/// Seed the persona definitions, the community team, and their retained heads.
///
/// New records are written at the current recipe version. An existing record
/// with this recipe's deterministic identity is provisioned content: when its
/// recorded version is behind, only the content the recipe owns is refreshed
/// (see [`super::provisioning`]). User-owned settings and user-created records
/// are untouched. Membership only gains a missing recipe persona and repairs
/// an absent or invalid lead.
fn seed_records(
    ctx: &InstallContext<'_>,
    notes: &mut Vec<String>,
) -> Result<SeededRecords, String> {
    let now = now_iso();
    let _guard = ctx
        .state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;

    // 1. Persona definitions.
    let mut personas = load_personas(ctx.app)?;
    let mut personas_changed = false;
    let mut upgrade = UpgradeSummary::default();
    for recipe_persona in PERSONAS {
        if let Some(existing) = personas
            .iter_mut()
            .find(|definition| definition.id == recipe_persona.persona_id)
        {
            let (changed, persona_upgrade) =
                apply_recipe_to_definition(existing, recipe_persona, &now);
            personas_changed |= changed;
            upgrade.merge(persona_upgrade);
            continue;
        }
        personas.push(AgentDefinition {
            id: recipe_persona.persona_id.to_string(),
            role_id: Some(recipe_persona.role_id.to_string()),
            role_title: Some(recipe_persona.role_title.to_string()),
            display_name: recipe_persona.display_name.to_string(),
            avatar_url: None,
            system_prompt: persona_system_prompt(recipe_persona),
            runtime: None,
            model: None,
            provider: None,
            name_pool: Vec::new(),
            is_builtin: true,
            provisioned_by: Some(RECIPE_ID.to_string()),
            provisioned_version: Some(RECIPE_VERSION.to_string()),
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            env_vars: BTreeMap::new(),
            respond_to: None,
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        });
        personas_changed = true;
    }
    if personas_changed {
        save_personas(ctx.app, &personas)?;
    }
    let definitions: Vec<AgentDefinition> = PERSONAS
        .iter()
        .filter_map(|recipe_persona| {
            personas
                .iter()
                .find(|definition| definition.id == recipe_persona.persona_id)
                .cloned()
        })
        .collect();
    if definitions.len() != PERSONAS.len() {
        return Err("The Website Manager personas are incomplete in this store.".to_string());
    }

    // 2. The community team.
    let mut teams = load_teams(ctx.app)?;
    let existing_index = teams.iter().position(|team| team.id == ctx.team_id);
    let team_existed = existing_index.is_some();
    let team = match existing_index {
        Some(index) => {
            let (updated, changed, team_upgrade) = {
                let team = &mut teams[index];
                let (changed, team_upgrade) = apply_recipe_to_team(team, &now);
                (team.clone(), changed, team_upgrade)
            };
            if changed {
                save_teams(ctx.app, &teams)?;
            }
            upgrade.merge(team_upgrade);
            updated
        }
        None => {
            let team = TeamRecord {
                id: ctx.team_id.clone(),
                name: TEAM_NAME.to_string(),
                description: Some(TEAM_DESCRIPTION.to_string()),
                instructions: Some(TEAM_INSTRUCTIONS.to_string()),
                persona_ids: PERSONAS
                    .iter()
                    .map(|persona| persona.persona_id.to_string())
                    .collect(),
                lead_persona_id: Some(AVERY_PERSONA_ID.to_string()),
                is_builtin: true,
                provisioned_by: Some(RECIPE_ID.to_string()),
                provisioned_version: Some(RECIPE_VERSION.to_string()),
                source_dir: None,
                is_symlink: false,
                symlink_target: None,
                version: Some(RECIPE_VERSION.to_string()),
                relay_url: Some(ctx.canonical_relay.clone()),
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            teams.push(team.clone());
            save_teams(ctx.app, &teams)?;
            team
        }
    };

    // 3. Retain the heads into the captured scope. Best-effort per row: a
    // retention failure must not roll back the disk-authoritative records, but
    // it is surfaced as a note so the UI never claims a publication that did
    // not queue.
    for definition in &definitions {
        if let Err(error) = retain_persona_at(ctx.scope, definition) {
            notes.push(format!(
                "Could not queue the {} persona for publication: {error}",
                definition.display_name
            ));
        }
    }
    if let Err(error) = retain_team_at(ctx.scope, &team) {
        notes.push(format!(
            "Could not queue the {TEAM_NAME} team for publication: {error}"
        ));
    }

    Ok(SeededRecords {
        team,
        team_existed,
        definitions,
        upgrade,
    })
}

/// Add missing recipe members to an existing team and repair an absent or
/// invalid lead, without disturbing any other user edit.
///
/// Returns whether the record changed. The relay's `load_team_refs` requires a
/// lead that is also a member before it will authorize any task against the
/// team, so an invalid lead is repaired; a valid custom lead is preserved.
pub(super) fn ensure_team_members(team: &mut TeamRecord, now: &str) -> bool {
    let mut changed = false;
    for recipe_persona in PERSONAS {
        if !team
            .persona_ids
            .iter()
            .any(|member| member == recipe_persona.persona_id)
        {
            team.persona_ids.push(recipe_persona.persona_id.to_string());
            changed = true;
        }
    }
    let lead_is_valid = team
        .lead_persona_id
        .as_deref()
        .is_some_and(|lead| team.persona_ids.iter().any(|member| member == lead));
    if !lead_is_valid {
        team.lead_persona_id = Some(AVERY_PERSONA_ID.to_string());
        changed = true;
    }
    if changed {
        team.updated_at = now.to_string();
    }
    changed
}

fn install_skills(notes: &mut Vec<String>) -> Vec<InstalledWebsiteSkill> {
    let Some(root) = crate::managed_agents::nest_dir() else {
        notes.push(
            "The agent workspace could not be resolved, so the recipe skills were not written."
                .to_string(),
        );
        return super::SKILLS
            .iter()
            .map(|skill| InstalledWebsiteSkill {
                name: skill.name.to_string(),
                path: String::new(),
                status: "failed".to_string(),
                detail: Some("agent workspace unavailable".to_string()),
            })
            .collect();
    };
    let outcomes = install_recipe_skills(&root);
    for outcome in &outcomes {
        if outcome.status == "failed" {
            notes.push(format!(
                "Skill {} could not be written: {}",
                outcome.name,
                outcome.detail.as_deref().unwrap_or("unknown error")
            ));
        }
    }
    outcomes
}

/// Create or reconcile one persona's managed agent.
///
/// The deterministic request id is the identity. An existing record is reused
/// only when persona, team, owner, and community all match; anything else is a
/// real inconsistency the user must resolve rather than something to paper
/// over with a duplicate.
async fn ensure_agent(
    ctx: &InstallContext<'_>,
    persona: &RecipePersona,
    request_id: &str,
    manager_pubkey: Option<&str>,
    notes: &mut Vec<String>,
) -> Result<(ManagedAgentRecord, bool, UpgradeSummary), String> {
    let existing = find_request_record(ctx.app, request_id)?;
    match existing {
        Some(record) => {
            reconcile_expected(&record, persona, ctx)?;
            let (record, upgrade) =
                patch_placement(ctx, &record.pubkey, persona, manager_pubkey, notes)?;
            Ok((record, false, upgrade))
        }
        None => {
            let input = CreateManagedAgentRequest {
                name: persona.display_name.to_string(),
                persona_id: Some(persona.persona_id.to_string()),
                team_id: Some(ctx.team_id.clone()),
                relay_url: Some(ctx.relay_url.clone()),
                acp_command: None,
                // Managed agents run in their nest; no per-agent override here.
                working_dir: None,
                // Inherit the persona's harness and the saved global defaults:
                // the recipe must not pin a model, provider, or credential.
                agent_command: None,
                harness_override: false,
                agent_args: Vec::new(),
                mcp_command: None,
                turn_timeout_seconds: None,
                idle_timeout_seconds: None,
                max_turn_duration_seconds: None,
                parallelism: None,
                system_prompt: None,
                avatar_url: None,
                model: None,
                provider: None,
                env_vars: BTreeMap::new(),
                spawn_after_create: false,
                start_on_app_launch: true,
                backend: Default::default(),
                respond_to: None,
                respond_to_allowlist: Vec::new(),
                relay_mesh: None,
            };
            match crate::commands::website_team::create_agent_for_install(
                input,
                ctx.app.clone(),
                ctx.state,
                request_id.to_string(),
            )
            .await
            {
                Ok(response) => {
                    let crate::managed_agents::CreateManagedAgentResponse {
                        agent,
                        private_key_nsec,
                        profile_sync_error,
                        ..
                    } = response;
                    // Never store, return, or log the minted identity key.
                    drop(private_key_nsec);
                    if let Some(error) = profile_sync_error {
                        notes.push(format!(
                            "{}: the agent profile could not be synced yet: {error}",
                            persona.display_name
                        ));
                    }
                    let record = load_record(ctx.app, &agent.pubkey)?;
                    let (record, _upgrade) =
                        patch_placement(ctx, &record.pubkey, persona, manager_pubkey, notes)?;
                    Ok((record, true, UpgradeSummary::default()))
                }
                Err(error) => {
                    // The retry race: another run applied this exact request id
                    // between the read and the create. Reconcile it.
                    if let Some(record) = find_request_record(ctx.app, request_id)? {
                        reconcile_expected(&record, persona, ctx)?;
                        let (record, upgrade) =
                            patch_placement(ctx, &record.pubkey, persona, manager_pubkey, notes)?;
                        Ok((record, false, upgrade))
                    } else {
                        Err(error)
                    }
                }
            }
        }
    }
}

fn find_request_record(
    app: &AppHandle,
    request_id: &str,
) -> Result<Option<ManagedAgentRecord>, String> {
    let records = load_managed_agents(app)?;
    Ok(records
        .into_iter()
        .find(|record| record.creation_request_id.as_deref() == Some(request_id)))
}

fn load_record(app: &AppHandle, pubkey: &str) -> Result<ManagedAgentRecord, String> {
    load_managed_agents(app)?
        .into_iter()
        .find(|record| record.pubkey == pubkey)
        .ok_or_else(|| format!("created agent {pubkey} disappeared unexpectedly"))
}

/// Reject a record that has this install's request id but is not the agent it
/// claims to be. Never silently adopt a record that belongs somewhere else.
fn reconcile_expected(
    record: &ManagedAgentRecord,
    persona: &RecipePersona,
    ctx: &InstallContext<'_>,
) -> Result<(), String> {
    record_matches_install(
        record,
        persona,
        &ctx.team_id,
        &ctx.owner,
        &ctx.canonical_relay,
    )
}

/// Pure identity check for the reconcile path: the record must carry the exact
/// expected persona, team, owner, and community before a retry may treat it as
/// this install's canonical row.
pub(super) fn record_matches_install(
    record: &ManagedAgentRecord,
    persona: &RecipePersona,
    team_id: &str,
    owner: &str,
    canonical_relay: &str,
) -> Result<(), String> {
    let mismatch = |field: &str| {
        format!(
            "An existing agent ({} / {}) has this installation's identity but does not match the expected {field}. Review it in Agents, then retry the Website Manager install.",
            record.name, record.pubkey
        )
    };
    if record.persona_id.as_deref() != Some(persona.persona_id) {
        return Err(mismatch("persona"));
    }
    if record.team_id.as_deref() != Some(team_id) {
        return Err(mismatch("team"));
    }
    let owner_matches = record
        .owner_pubkey
        .as_deref()
        .is_some_and(|record_owner| record_owner.eq_ignore_ascii_case(owner));
    if !owner_matches {
        return Err(mismatch("owner"));
    }
    if canonical(&record.relay_url) != canonical_relay {
        return Err(mismatch("community"));
    }
    Ok(())
}

/// Stamp one managed agent with this recipe's provenance, refresh the owned
/// hierarchy fields, then retain the (possibly updated) head into the captured
/// scope.
///
/// `apply_recipe_to_agent` owns the field policy: provenance and `is_builtin`
/// are always stamped, `tier` is seeded when absent and refreshed on a recipe
/// version change, and the manager line is seeded only when absent. A user
/// rename, harness pin, model/provider, channel membership, and working
/// directory are never touched. This mirrors
/// `commands::org_placement::record_org_placement`'s write for the manager
/// line, so the local record and the published head agree.
fn patch_placement(
    ctx: &InstallContext<'_>,
    pubkey: &str,
    persona: &RecipePersona,
    manager_pubkey: Option<&str>,
    notes: &mut Vec<String>,
) -> Result<(ManagedAgentRecord, UpgradeSummary), String> {
    let (record, upgrade) = {
        let _guard = ctx
            .state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut records = load_managed_agents(ctx.app)?;
        let record = records
            .iter_mut()
            .find(|record| record.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} is missing from this store"))?;
        let (changed, upgrade) =
            apply_recipe_to_agent(record, persona, manager_pubkey, &now_iso());
        if changed {
            save_managed_agents(ctx.app, &records)?;
        }
        let record = records
            .into_iter()
            .find(|record| record.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} disappeared unexpectedly"))?;
        (record, upgrade)
    };

    // Reuse the boot reconcile engine so the published projection and the
    // content-diff short-circuit stay identical to every other republish.
    match open_retention_db(&ctx.scope.db_path) {
        Ok(conn) => {
            if let Err(error) = crate::managed_agents::reconcile::retain_agent_record(
                &conn,
                &ctx.scope.owner_keys,
                &record,
            ) {
                notes.push(format!(
                    "Could not queue the {} agent head for publication: {error}",
                    record.name
                ));
            }
        }
        Err(error) => notes.push(format!(
            "Could not queue the {} agent head for publication: {error}",
            record.name
        )),
    }
    Ok((record, upgrade))
}

fn scope_matches(state: &AppState, relay_url: &str, owner: &str) -> bool {
    let active_relay = crate::relay::relay_ws_url_with_override(state);
    if canonical(&active_relay) != canonical(relay_url) {
        return false;
    }
    state
        .signing_keys()
        .map(|keys| keys.public_key().to_hex().eq_ignore_ascii_case(owner))
        .unwrap_or(false)
}

/// Best-effort removal of managed-agent heads that a mid-install community
/// switch could have leaked into the newly active scope.
fn scrub_other_scope_agent_rows(
    ctx: &InstallContext<'_>,
    agents: &[ManagedAgentRecord],
    notes: &mut Vec<String>,
) {
    let active_relay = crate::relay::relay_ws_url_with_override(ctx.state);
    let Ok(active_keys) = ctx.state.signing_keys() else {
        return;
    };
    let active_owner = active_keys.public_key().to_hex();
    if canonical(&active_relay) == ctx.canonical_relay
        && active_owner.eq_ignore_ascii_case(&ctx.owner)
    {
        return;
    }
    let Ok(base_dir) = crate::managed_agents::managed_agents_base_dir(ctx.app) else {
        return;
    };
    let other_db = scoped_retention_db_path(&base_dir, &active_relay, &active_owner);
    if !other_db.exists() {
        return;
    }
    let Ok(conn) = open_retention_db(&other_db) else {
        return;
    };
    let mut removed = 0usize;
    for record in agents {
        let present = get_retained_event(&conn, KIND_MANAGED_AGENT, &active_owner, &record.pubkey)
            .ok()
            .flatten()
            .is_some();
        if present
            && delete_retained_event(&conn, KIND_MANAGED_AGENT, &active_owner, &record.pubkey)
                .is_ok()
        {
            removed += 1;
        }
    }
    if removed > 0 {
        notes.push(
            "The community changed during installation; stray agent heads were removed from the other community and stay published only in the install community."
                .to_string(),
        );
    }
}

fn read_publication(
    ctx: &InstallContext<'_>,
    definitions: &[AgentDefinition],
    agents: &[ManagedAgentRecord],
) -> Result<WebsiteTeamPublication, String> {
    let conn = open_retention_db(&ctx.scope.db_path)?;
    let owner = ctx.scope.owner_keys.public_key().to_hex();
    let team = publication_status(&conn, KIND_TEAM, &owner, &ctx.team_id);
    let personas = definitions
        .iter()
        .map(|definition| PublicationEntry {
            id: definition.id.clone(),
            status: publication_status(
                &conn,
                KIND_PERSONA,
                &owner,
                &persona_events::persona_d_tag(definition),
            ),
        })
        .collect();
    let agents = agents
        .iter()
        .map(|record| PublicationEntry {
            id: record.pubkey.clone(),
            status: publication_status(&conn, KIND_MANAGED_AGENT, &owner, &record.pubkey),
        })
        .collect();
    Ok(WebsiteTeamPublication {
        team,
        personas,
        agents,
        detail: None,
    })
}

fn publication_status(conn: &Connection, kind: u32, owner: &str, d_tag: &str) -> String {
    match get_retained_event(conn, kind, owner, d_tag) {
        Ok(Some(row)) if !row.pending_sync => PUBLICATION_PUBLISHED.to_string(),
        Ok(Some(_)) => PUBLICATION_QUEUED.to_string(),
        Ok(None) | Err(_) => PUBLICATION_MISSING.to_string(),
    }
}

fn retain_persona_at(scope: &RetentionScope, definition: &AgentDefinition) -> Result<(), String> {
    let owner = scope.owner_keys.public_key().to_hex();
    let d_tag = persona_events::persona_d_tag(definition);
    let conn = open_retention_db(&scope.db_path)?;
    let prior = get_retained_event(&conn, KIND_PERSONA, &owner, &d_tag)?.map(|row| row.created_at);
    let event = persona_events::build_persona_event(definition)?
        .custom_created_at(persona_events::monotonic_created_at(prior))
        .sign_with_keys(&scope.owner_keys)
        .map_err(|error| format!("failed to sign persona event: {error}"))?;
    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_PERSONA,
            pubkey: owner,
            d_tag,
            content: event.content.to_string(),
            created_at: event.created_at.as_secs() as i64,
            raw_event: event.as_json(),
            pending_sync: true,
        },
    )
}

fn retain_team_at(scope: &RetentionScope, team: &TeamRecord) -> Result<(), String> {
    let owner = scope.owner_keys.public_key().to_hex();
    let conn = open_retention_db(&scope.db_path)?;
    let prior = get_retained_event(&conn, KIND_TEAM, &owner, &team.id)?.map(|row| row.created_at);
    let event = crate::managed_agents::team_events::build_team_event(team)?
        .custom_created_at(persona_events::monotonic_created_at(prior))
        .sign_with_keys(&scope.owner_keys)
        .map_err(|error| format!("failed to sign team event: {error}"))?;
    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_TEAM,
            pubkey: owner,
            d_tag: team.id.clone(),
            content: event.content.to_string(),
            created_at: event.created_at.as_secs() as i64,
            raw_event: event.as_json(),
            pending_sync: true,
        },
    )
}
