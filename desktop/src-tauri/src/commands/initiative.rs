//! Starting an initiative: the owner-signed half.
//!
//! The frontend holds the relay-authored heads it read and the connection to
//! publish on; this holds the owner's signing key and the rule for what may be
//! published. It deliberately does not take the initiative *record* from the
//! caller. It takes the relay-signed event and re-derives the record from it,
//! so an action can only ever carry a body the tenant relay itself wrote. A
//! caller that passed a hand-edited initiative would otherwise get the owner's
//! signature on it.

use buzz_sdk_pkg::{
    company::parse_company_event,
    company_blueprint::sign_action,
    implicit_task::plan_implicit_task,
    initiative_activation::{next_step, InitiativeIntent, InitiativeStep},
};
use nostr::JsonUtil;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
    app_state::AppState,
    company::transaction::is_event_id,
    managed_agents::{
        is_valid_coordination_team, load_personas, load_teams, save_personas, save_teams,
        storage::{load_managed_agents, save_managed_agents},
        AgentDefinition, ManagedAgentRecord, TeamRecord,
    },
};

/// What the caller has to publish next, and what it will do.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitiativeStepResult {
    /// The initiative this describes.
    pub initiative_id: String,
    /// The status its current head carries.
    pub status: String,
    /// What publishing `signed_action` will make it, when it is a transition.
    pub next_status: Option<String>,
    /// The Task this creates, when the initiative is already active.
    pub task_id: Option<String>,
    /// The team accountable for that Task.
    pub owning_team_id: Option<String>,
    /// The signed Company Action to publish, or none when nothing is left.
    pub signed_action: Option<String>,
    /// Whether the initiative has reached a state with nothing left to publish.
    pub settled: bool,
}

/// Project stored team records into what the company contract validates.
///
/// Pulled out of `company_team_refs` so the pure mapping is testable without
/// an `AppHandle` — a fresh install's default set (`load_teams_readonly` on a
/// path that does not exist) is exactly the input the empty-teams regression
/// test below needs.
fn teams_to_company_refs(
    teams: Vec<crate::managed_agents::TeamRecord>,
) -> Vec<buzz_core_pkg::company::CompanyTeamRef> {
    teams
        .into_iter()
        .filter_map(|team| {
            let lead = team.lead_persona_id?;
            Some(buzz_core_pkg::company::CompanyTeamRef {
                id: team.id,
                lead_persona_id: lead,
                persona_ids: team.persona_ids,
            })
        })
        .filter(|team| buzz_core_pkg::company::validate_team_ref(team).is_ok())
        .collect()
}

/// This device's teams, projected into what the company contract validates.
///
/// These are the same records published as the Team projection the relay
/// checks against. If they have drifted, the relay refuses the Task and says
/// so in its receipt rather than this process guessing.
fn company_team_refs(
    app: &AppHandle,
) -> Result<Vec<buzz_core_pkg::company::CompanyTeamRef>, String> {
    Ok(teams_to_company_refs(load_teams(app)?))
}

/// Read a relay-signed head, refusing anything the tenant relay did not write.
pub(crate) fn relay_head(
    json: &str,
    relay_pubkey: &str,
    what: &str,
) -> Result<nostr::Event, String> {
    let event =
        nostr::Event::from_json(json).map_err(|_| format!("the {what} head is not an event"))?;
    // Signature first: everything downstream reads this event's content as
    // authoritative, and an unverified event is just JSON the caller wrote.
    event
        .verify()
        .map_err(|_| format!("the {what} head is not correctly signed"))?;
    if event.pubkey.to_hex() != relay_pubkey {
        return Err(format!(
            "the {what} head was not authored by this community's relay"
        ));
    }
    Ok(event)
}

/// Decide and sign the next publish for one initiative.
///
/// Called repeatedly: the frontend publishes what comes back, waits for the
/// relay's receipt, re-reads the head, and calls again until `settled`. Each
/// call is pinned by compare-and-set to the exact head it was given, and every
/// key it derives comes from the initiative, so a repeat after a lost receipt
/// is a replay the relay recognises rather than a second write.
#[tauri::command]
pub async fn advance_initiative(
    app: AppHandle,
    company_head: String,
    initiative_head: String,
    relay_pubkey: String,
    intent: String,
    state: State<'_, AppState>,
) -> Result<InitiativeStepResult, String> {
    // Named rather than boolean: "start" and "decline" reach the same relay
    // coordinate, and a silent default would let a caller that mistyped the
    // field start work the owner asked to stop.
    let intent = match intent.as_str() {
        "start" => InitiativeIntent::Start,
        "decline" => InitiativeIntent::Decline,
        _ => return Err("an initiative can be started or declined".to_string()),
    };

    // Starting work is an owner action. Reading the signing key proves an owner
    // identity is present and usable, and refuses while the identity is in
    // recovery mode, which is exactly when nothing should start spending.
    let keys = state
        .signing_keys()
        .map_err(|_| "starting an initiative requires the community owner".to_string())?;

    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }

    let company_event = relay_head(&company_head, &relay_pubkey, "company")?;
    let initiative_event = relay_head(&initiative_head, &relay_pubkey, "initiative")?;

    // Parsed for validation only; `next_step` no longer takes the profile.
    parse_company_event(&company_event)
        .map_err(|error| format!("the community profile head is unreadable: {error}"))?;
    let initiative = buzz_sdk_pkg::company::parse_initiative_event(&initiative_event)
        .map_err(|error| format!("the initiative head is unreadable: {error}"))?;

    let teams = company_team_refs(&app)?;

    let status = serde_json::to_value(initiative.status)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();

    let step = next_step(
        &initiative,
        &initiative_event.id.to_hex(),
        &teams,
        &relay_pubkey,
        intent,
    )?;

    let result = match step {
        InitiativeStep::Settled { .. } => InitiativeStepResult {
            initiative_id: initiative.id.clone(),
            status,
            next_status: None,
            task_id: None,
            owning_team_id: None,
            signed_action: None,
            settled: true,
        },
        InitiativeStep::Transition { to, action } => InitiativeStepResult {
            initiative_id: initiative.id.clone(),
            status,
            next_status: serde_json::to_value(to)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned)),
            task_id: None,
            owning_team_id: None,
            signed_action: Some(sign_action(&action, &keys)?),
            settled: false,
        },
        InitiativeStep::Kickoff {
            task_id,
            owning_team_id,
            action,
        } => InitiativeStepResult {
            initiative_id: initiative.id.clone(),
            status,
            next_status: None,
            task_id: Some(task_id),
            owning_team_id: Some(owning_team_id),
            signed_action: Some(sign_action(&action, &keys)?),
            // The kickoff Task is the last publish activation makes; once the
            // relay has it, the initiative is running.
            settled: true,
        },
    };

    Ok(result)
}

/// What changed while resolving a chat message's Task-attributable persona.
#[derive(Debug)]
struct PersonaBackfillOutcome {
    /// The persona `plan_implicit_task` should charge the work to.
    persona_id: String,
    /// Whether `agents` needs to be written back.
    agents_changed: bool,
    /// Whether `personas` needs to be written back.
    personas_changed: bool,
    /// Whether `teams` needs to be written back.
    teams_changed: bool,
}

/// Resolve the persona a chat Task should be attributed to for the managed
/// agent at `pubkey_normalized`, permanently repairing the record if it has
/// no persona linked yet.
///
/// Pulled out of `ensure_chat_task` so the repair logic is testable without an
/// `AppHandle` — mirrors `teams_to_company_refs` above. Mutates `agents`,
/// `personas`, and `teams` in place; the caller only needs to persist whatever
/// the returned outcome flags as changed.
///
/// An agent with an existing `persona_id` is untouched (cheap read). One with
/// none gets a persona minted from its own identity — never a shared builtin
/// like `builtin:fizz`, which would misattribute its work to a different
/// employee — linked onto the record, and enrolled as a member of the
/// coordination team. Membership matters, not just a coordination team
/// existing: `owning_team_for_chat`'s ambiguous-work fallback would resolve
/// even without it (see `fresh_install_has_a_coordination_team_for_ambiguous_chat_work`
/// below), but only a real member gets `assignee_persona_ids` populated on
/// the Task it creates.
///
/// Only remaining failure: `pubkey_normalized` matches no agent record at
/// all. That case is genuinely un-repairable, so it keeps the exact error
/// string callers have always seen for an unknown agent.
fn resolve_chat_agent_persona(
    agents: &mut [ManagedAgentRecord],
    personas: &mut Vec<AgentDefinition>,
    teams: &mut [TeamRecord],
    pubkey_normalized: &str,
    now: &str,
) -> Result<PersonaBackfillOutcome, String> {
    let Some(agent) = agents
        .iter_mut()
        .find(|agent| agent.pubkey.trim().to_lowercase() == pubkey_normalized)
    else {
        return Err("that agent is not a company employee".to_string());
    };

    if let Some(existing) = agent.persona_id.clone() {
        return Ok(PersonaBackfillOutcome {
            persona_id: existing,
            agents_changed: false,
            personas_changed: false,
            teams_changed: false,
        });
    }

    // Deterministic from the agent's own pubkey (already a valid company
    // identifier: lowercase hex), so a retry after a lost receipt — or a
    // second `ensure_chat_task` call before this backfill's save lands — mints
    // the same identity rather than a new one each time.
    let persona_id = format!("legacy-employee:{}", agent.pubkey.trim().to_lowercase());

    let personas_changed = if personas.iter().any(|persona| persona.id == persona_id) {
        false
    } else {
        personas.push(AgentDefinition {
            id: persona_id.clone(),
            role_id: agent.role_id.clone(),
            role_title: agent.role_title.clone(),
            display_name: agent
                .display_name
                .clone()
                .unwrap_or_else(|| agent.name.clone()),
            avatar_url: agent.avatar_url.clone(),
            system_prompt: agent.system_prompt.clone().unwrap_or_default(),
            runtime: agent.runtime.clone(),
            model: agent.model.clone(),
            provider: agent.provider.clone(),
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            env_vars: Default::default(),
            respond_to: None,
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            created_at: now.to_string(),
            updated_at: now.to_string(),
        });
        true
    };

    agent.persona_id = Some(persona_id.clone());
    agent.updated_at = now.to_string();

    let teams_changed = match teams
        .iter_mut()
        .find(|team| is_valid_coordination_team(team))
    {
        Some(team) if !team.persona_ids.iter().any(|member| member == &persona_id) => {
            team.persona_ids.push(persona_id.clone());
            team.updated_at = now.to_string();
            true
        }
        // Already a member, or (should not happen once `load_teams` has run
        // at least once) no valid coordination team at all: best-effort, not
        // an error — mirrors `ensure_persona_in_coordination_team`.
        _ => false,
    };

    Ok(PersonaBackfillOutcome {
        persona_id,
        agents_changed: true,
        personas_changed,
        teams_changed,
    })
}

/// The Task an agent-directed message will be charged to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTaskResult {
    /// The stable Task identifier this send is charged to.
    pub task_id: String,
    /// The single team accountable for it.
    pub owning_team_id: String,
    /// The signed Company Action that creates it.
    pub signed_action: String,
}

/// Build the Task for one agent-directed message.
///
/// Every paid agent turn is charged to a Task. Most instructions in chat do not
/// name one, so Colony creates one rather than letting the turn run
/// unattributed: an unattributed turn is money spent that no cost centre, team,
/// or commercial purpose can be traced to, and the classification cannot be
/// recovered afterwards.
///
/// `send_id` is the caller's stable identity for this send. Retrying the same
/// send asks for the same Task, because the identifier is derived from it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ensure_chat_task(
    app: AppHandle,
    company_head: String,
    channel_id: String,
    send_id: String,
    agent_pubkey: String,
    title: String,
    client_organization_id: Option<String>,
    relay_pubkey: String,
    state: State<'_, AppState>,
) -> Result<ChatTaskResult, String> {
    let keys = state
        .signing_keys()
        .map_err(|_| "recording company work requires the community owner".to_string())?;

    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }

    let company_event = relay_head(&company_head, &relay_pubkey, "company")?;
    let company = parse_company_event(&company_event)
        .map_err(|error| format!("the company head is unreadable: {error}"))?;

    // The mention flow knows agents by public key; the company contract knows
    // them by persona. Live hire paths link one at creation time, but nothing
    // ever backfills a persona for a record that predates that (or was created
    // without one) — `backfill_persona_snapshots` explicitly skips
    // `persona_id: None` records — so such an agent could never send a chat
    // message again. `resolve_chat_agent_persona` repairs the record in place
    // the first time this runs for it; a repeat call is a cheap read.
    let normalized = agent_pubkey.trim().to_lowercase();
    let agent_persona_id = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;

        let mut agents = load_managed_agents(&app)?;
        let mut personas = load_personas(&app)?;
        let mut teams = load_teams(&app)?;
        let now = crate::util::now_iso();

        let outcome =
            resolve_chat_agent_persona(&mut agents, &mut personas, &mut teams, &normalized, &now)?;

        if outcome.agents_changed {
            save_managed_agents(&app, &agents)?;
        }
        if outcome.personas_changed {
            save_personas(&app, &personas)?;
        }
        if outcome.teams_changed {
            save_teams(&app, &teams)?;
        }

        outcome.persona_id
    };

    let teams = company_team_refs(&app)?;

    // Derived from the send rather than read from the clock, so a retry
    // produces the same bytes and the relay recognises the replay.
    let now = buzz_core_pkg::company_roster::approval_timestamp(&format!("{channel_id}:{send_id}"));

    let plan = plan_implicit_task(
        &company,
        &teams,
        &agent_persona_id,
        &channel_id,
        &send_id,
        &title,
        client_organization_id.as_deref(),
        &relay_pubkey,
        now,
    )?;

    Ok(ChatTaskResult {
        task_id: plan.task_id,
        owning_team_id: plan.owning_team_id,
        signed_action: sign_action(&plan.action, &keys)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{resolve_chat_agent_persona, teams_to_company_refs};
    use crate::managed_agents::{
        AgentDefinition, BackendKind, ManagedAgentRecord, RespondTo, TeamRecord,
    };
    use buzz_sdk_pkg::implicit_task::owning_team_for_chat;

    fn agent_with_no_persona(pubkey: &str) -> ManagedAgentRecord {
        ManagedAgentRecord {
            pubkey: pubkey.to_string(),
            name: "Legacy Bot".to_string(),
            role_id: None,
            role_title: None,
            persona_id: None,
            creation_request_id: None,
            private_key_nsec: String::new(),
            auth_tag: None,
            relay_url: String::new(),
            avatar_url: None,
            acp_command: String::new(),
            agent_command: String::new(),
            agent_command_override: None,
            agent_args: vec![],
            mcp_command: String::new(),
            turn_timeout_seconds: 0,
            idle_timeout_seconds: None,
            max_turn_duration_seconds: None,
            parallelism: 1,
            system_prompt: None,
            model: None,
            provider: None,
            persona_source_version: None,
            start_on_app_launch: false,
            auto_restart_on_config_change: true,
            runtime_pid: None,
            backend: BackendKind::default(),
            backend_agent_id: None,
            provider_binary_path: None,
            team_id: None,
            persona_team_dir: None,
            persona_name_in_team: None,
            created_at: String::new(),
            updated_at: String::new(),
            last_started_at: None,
            last_stopped_at: None,
            last_exit_code: None,
            last_error: None,
            last_error_code: None,
            respond_to: RespondTo::default(),
            respond_to_allowlist: vec![],
            env_vars: Default::default(),
            display_name: None,
            slug: None,
            runtime: None,
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            definition_respond_to: None,
            definition_respond_to_allowlist: Vec::new(),
            definition_parallelism: None,
            relay_mesh: None,
        }
    }

    fn coordination_team() -> TeamRecord {
        TeamRecord {
            id: "builtin-team:company-coordination".to_string(),
            name: "Company Coordination".to_string(),
            description: None,
            instructions: None,
            persona_ids: vec!["builtin:fizz".to_string()],
            lead_persona_id: Some("builtin:fizz".to_string()),
            is_builtin: true,
            source_dir: None,
            is_symlink: false,
            symlink_target: None,
            version: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    /// Reproduces the send-blocking bug directly: `ensure_chat_task` used to
    /// refuse a managed agent record with `persona_id: None` with "that agent
    /// is not a company employee", permanently, because nothing ever backfills
    /// one for it (`backfill_persona_snapshots` explicitly skips such
    /// records). This asserts the fixed behavior: `resolve_chat_agent_persona`
    /// repairs the record in place and hands back a persona that is a real
    /// member of a valid coordination team — not just the ambiguous-work
    /// fallback — so the Task `plan_implicit_task` builds from it can actually
    /// assign the work.
    ///
    /// Against the pre-fix code (the original `.ok_or_else("that agent is not
    /// a company employee")` chain inlined instead of calling this function)
    /// this fails: the send stays blocked forever. See the PR description for
    /// the exact before/after `cargo test` output.
    #[test]
    fn chat_agent_with_no_persona_is_repaired_onto_the_coordination_team() {
        let pubkey = "abc123def456";
        let mut agents = vec![agent_with_no_persona(pubkey)];
        let mut personas: Vec<AgentDefinition> = Vec::new();
        let mut teams = vec![coordination_team()];

        let outcome = resolve_chat_agent_persona(
            &mut agents,
            &mut personas,
            &mut teams,
            pubkey,
            "2026-08-30T00:00:00Z",
        )
        .expect("a persona-less agent must now be repairable, not refused");

        assert!(outcome.agents_changed);
        assert!(outcome.personas_changed);
        assert!(outcome.teams_changed);

        // The record is permanently repaired, not just resolved for this call.
        assert_eq!(
            agents[0].persona_id.as_deref(),
            Some(outcome.persona_id.as_str())
        );

        // A real persona was minted for this agent specifically — not a
        // shared builtin identity that would misattribute its work.
        assert!(personas.iter().any(|p| p.id == outcome.persona_id));

        // It is an actual member of the coordination team, not just covered by
        // the ambiguous-work fallback.
        let team = &teams[0];
        assert!(team.persona_ids.contains(&outcome.persona_id));

        // And `owning_team_for_chat` resolves it as a member, so the Task this
        // becomes will carry a real assignee.
        let refs = teams_to_company_refs(teams);
        let owner = owning_team_for_chat(&refs, &outcome.persona_id)
            .expect("a member of the coordination team must resolve an owning team");
        assert!(owner.persona_ids.iter().any(|id| id == &outcome.persona_id));
    }

    /// The one case that must stay un-repairable: no agent record at all.
    /// Preserves the exact error string every other caller of `ensure_chat_task`
    /// has always seen for an unknown agent.
    #[test]
    fn unknown_agent_still_fails_loudly() {
        let mut agents: Vec<ManagedAgentRecord> = Vec::new();
        let mut personas: Vec<AgentDefinition> = Vec::new();
        let mut teams = vec![coordination_team()];

        let error = resolve_chat_agent_persona(
            &mut agents,
            &mut personas,
            &mut teams,
            "nonexistent",
            "2026-08-30T00:00:00Z",
        )
        .unwrap_err();

        assert_eq!(error, "that agent is not a company employee");
    }

    /// Reproduces the send-blocking bug directly: a fresh install (teams.json
    /// does not exist yet) that has never approved a company blueprint must
    /// still resolve *some* owning team for an agent whose persona is a
    /// member of nothing, or every `@mention` send in `ensure_chat_task`
    /// fails with "this company has no coordination team to own ambiguous
    /// work" and is silently swallowed by `useMentionSendFlow`.
    ///
    /// Before the fix: only the Welcome Team is seeded (id
    /// `builtin-team:welcome`, no lead), which neither matches the
    /// coordination suffix nor validates as a `CompanyTeamRef` at all, so
    /// `teams_to_company_refs` returns an empty list and this fails.
    #[test]
    fn fresh_install_has_a_coordination_team_for_ambiguous_chat_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("teams.json");
        assert!(
            !path.exists(),
            "this test needs a store that has never been written"
        );

        let teams = crate::managed_agents::load_teams_readonly(&path).unwrap();
        let refs = teams_to_company_refs(teams);

        let owner = owning_team_for_chat(&refs, "some-hired-agent-persona");

        assert!(
            owner.is_ok(),
            "a fresh install with no approved blueprint must still have a coordination team: {:?}",
            owner.err()
        );
        let owner = owner.unwrap();
        assert!(
            owner.id.ends_with("company-coordination"),
            "fallback team must be the coordination team, got {}",
            owner.id
        );
    }
}
