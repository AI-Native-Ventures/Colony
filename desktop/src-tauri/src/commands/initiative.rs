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
    company::{parse_company_event, parse_initiative_event},
    company_blueprint::sign_action,
    implicit_task::{plan_implicit_task, plan_user_task, UserTaskRequest},
    initiative_activation::{next_step, InitiativeIntent, InitiativeStep},
    user_initiative::{plan_user_initiative, UserInitiativePlan, UserInitiativeRequest},
};
use nostr::JsonUtil;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
    app_state::AppState,
    company::transaction::is_event_id,
    managed_agents::{
        enrol_persona_for_relay, load_personas, load_teams, save_personas, save_teams,
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
/// coordination team for `relay_url`, the community this send arrived in.
/// Membership matters, not just a coordination team
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
    teams: &mut Vec<TeamRecord>,
    pubkey_normalized: &str,
    relay_url: &str,
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

    // One `teams.json` serves every community this device has joined, so
    // "the" coordination team is not a device-wide thing to look up. The
    // repaired persona joins the team of the community this send arrived in,
    // and seeds it when that community has none: enrolling onto whichever
    // coordination team happened to sort first is how the pre-migration
    // record accumulated members no community could actually see.
    let teams_changed = enrol_persona_for_relay(teams, &persona_id, relay_url, now);

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

/// Normalize and validate the thread root a chat send names.
///
/// `None`, and an all-whitespace string from a caller that passed a field
/// rather than omitting it, both mean the send is at channel root. Anything
/// else must be a real event id: the value ends up in the signed action's
/// content, so a malformed one is refused here rather than recorded.
fn validated_thread_root(thread_root: Option<String>) -> Result<Option<String>, String> {
    let Some(root) = thread_root else {
        return Ok(None);
    };
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !is_event_id(trimmed) {
        return Err("thread root is not a valid event id".to_string());
    }
    Ok(Some(trimmed.to_owned()))
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
    thread_root: Option<String>,
    relay_pubkey: String,
    state: State<'_, AppState>,
) -> Result<ChatTaskResult, String> {
    let keys = state
        .signing_keys()
        .map_err(|_| "recording company work requires the community owner".to_string())?;

    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }
    let thread_root = validated_thread_root(thread_root)?;

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
    let relay_url = crate::relay::relay_ws_url_with_override(&state);
    let agent_persona_id = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;

        let mut agents = load_managed_agents(&app)?;
        let mut personas = load_personas(&app)?;
        let mut teams = load_teams(&app)?;
        let now = crate::util::now_iso();

        let outcome = resolve_chat_agent_persona(
            &mut agents,
            &mut personas,
            &mut teams,
            &normalized,
            &relay_url,
            &now,
        )?;

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
        thread_root.as_deref(),
        &relay_pubkey,
        now,
    )?;

    Ok(ChatTaskResult {
        task_id: plan.task_id,
        owning_team_id: plan.owning_team_id,
        signed_action: sign_action(&plan.action, &keys)?,
    })
}

/// The Task a human created directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTaskResult {
    /// The stable Task identifier.
    pub task_id: String,
    /// The single team accountable for it.
    pub owning_team_id: String,
    /// The signed Company Action that creates it.
    pub signed_action: String,
}

/// Build the Task for one human-initiated "create a Task" request.
///
/// `request_id` is the caller's stable identity for this create attempt, not
/// for the Task's content: retrying the same attempt (a lost receipt) asks
/// for the same Task, but two attempts sharing every visible field, including
/// title, are still two Tasks a human meant to create separately - see
/// [`buzz_sdk_pkg::implicit_task::user_task_id`].
///
/// `owning_team_id` and `cost_centre_id` default to the company's
/// coordination team and internal cost centre when omitted, so a caller never
/// has to resolve either before a human can create a Task.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_user_task(
    app: AppHandle,
    company_head: String,
    request_id: String,
    channel_id: String,
    title: String,
    owning_team_id: Option<String>,
    cost_centre_id: Option<String>,
    initiative_head: Option<String>,
    assignee_persona_ids: Vec<String>,
    client_organization_id: Option<String>,
    relay_pubkey: String,
    state: State<'_, AppState>,
) -> Result<UserTaskResult, String> {
    let keys = state
        .signing_keys()
        .map_err(|_| "creating a task requires the community owner".to_string())?;

    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }

    let company_event = relay_head(&company_head, &relay_pubkey, "company")?;
    let company = parse_company_event(&company_event)
        .map_err(|error| format!("the company head is unreadable: {error}"))?;

    // Re-derived from the relay-signed head the caller read, exactly like
    // `advance_initiative` does with `initiative_head` - never trusted from a
    // hand-built object, so an initiative reference can only ever name a
    // record the tenant relay itself wrote.
    let initiative = match initiative_head.as_deref() {
        Some(head_json) => {
            let event = relay_head(head_json, &relay_pubkey, "initiative")?;
            Some(
                parse_initiative_event(&event)
                    .map_err(|error| format!("the initiative head is unreadable: {error}"))?,
            )
        }
        None => None,
    };

    let teams = company_team_refs(&app)?;

    // Derived from the request id rather than read from the clock, so a
    // retry produces the same bytes and the relay recognises the replay.
    let now = buzz_core_pkg::company_roster::approval_timestamp(&request_id);

    let plan = plan_user_task(
        &company,
        &teams,
        UserTaskRequest {
            request_id: &request_id,
            channel_id: &channel_id,
            title: &title,
            owning_team_id: owning_team_id.as_deref(),
            cost_centre_id: cost_centre_id.as_deref(),
            initiative: initiative.as_ref(),
            assignee_persona_ids: &assignee_persona_ids,
            client_organization_id: client_organization_id.as_deref(),
            relay_pubkey: &relay_pubkey,
            now,
        },
    )?;

    Ok(UserTaskResult {
        task_id: plan.task_id,
        owning_team_id: plan.owning_team_id,
        signed_action: sign_action(&plan.action, &keys)?,
    })
}

/// The Initiative a human created directly, e.g. from a "New initiative"
/// affordance.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInitiativeResult {
    /// The stable Initiative identifier.
    pub initiative_id: String,
    /// The persona the initiative is accountable to.
    pub owner_persona_id: String,
    /// The signed Company Action that creates it.
    pub signed_action: String,
}

/// What a caller typed into a "New initiative" form, before any of it has
/// been checked against a company.
#[derive(Debug, Clone, Copy)]
struct InitiativeDraft<'a> {
    request_id: &'a str,
    channel_id: &'a str,
    title: &'a str,
    /// Absent and empty mean the same thing here: no summary was written.
    summary: Option<&'a str>,
    cost_centre_id: Option<&'a str>,
    client_organization_id: Option<&'a str>,
}

/// The half of `create_initiative` that needs no running Tauri app: verify
/// the head the caller read, then plan against it.
///
/// Split out so the two refusals that matter most - a head this community's
/// relay did not write, and a draft the company contract rejects - are
/// testable without an `AppHandle`, which no unit test can build.
fn plan_initiative_from_head(
    company_head: &str,
    relay_pubkey: &str,
    teams: &[buzz_core_pkg::company::CompanyTeamRef],
    draft: InitiativeDraft<'_>,
) -> Result<UserInitiativePlan, String> {
    let company_event = relay_head(company_head, relay_pubkey, "company")?;
    let company = parse_company_event(&company_event)
        .map_err(|error| format!("the company head is unreadable: {error}"))?;

    plan_user_initiative(
        &company,
        teams,
        UserInitiativeRequest {
            request_id: draft.request_id,
            channel_id: draft.channel_id,
            title: draft.title,
            summary: draft.summary.unwrap_or_default(),
            cost_centre_id: draft.cost_centre_id,
            client_organization_id: draft.client_organization_id,
            relay_pubkey,
            // Derived from the request id rather than read from the clock, so
            // a retry produces the same bytes and the relay recognises the
            // replay.
            now: buzz_core_pkg::company_roster::approval_timestamp(draft.request_id),
        },
    )
}

/// Build and sign the Initiative for one human-initiated "create an
/// initiative" request.
///
/// `request_id` is the caller's stable identity for this create attempt, not
/// for the initiative's content: retrying the same attempt (a lost receipt)
/// asks for the same initiative, but two attempts sharing every visible
/// field, including title, are still two bodies of work a human meant to
/// create separately - see
/// [`buzz_sdk_pkg::user_initiative::user_initiative_id`].
///
/// `cost_centre_id` defaults to the company's internal cost centre when
/// omitted, so a human never has to resolve one before describing work. The
/// result is `Proposed`: this describes an initiative, it does not start it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_initiative(
    app: AppHandle,
    company_head: String,
    request_id: String,
    channel_id: String,
    title: String,
    summary: Option<String>,
    cost_centre_id: Option<String>,
    client_organization_id: Option<String>,
    relay_pubkey: String,
    state: State<'_, AppState>,
) -> Result<UserInitiativeResult, String> {
    let keys = state
        .signing_keys()
        .map_err(|_| "creating an initiative requires the community owner".to_string())?;

    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }

    let plan = plan_initiative_from_head(
        &company_head,
        &relay_pubkey,
        &company_team_refs(&app)?,
        InitiativeDraft {
            request_id: &request_id,
            channel_id: &channel_id,
            title: &title,
            summary: summary.as_deref(),
            cost_centre_id: cost_centre_id.as_deref(),
            client_organization_id: client_organization_id.as_deref(),
        },
    )?;

    Ok(UserInitiativeResult {
        initiative_id: plan.initiative_id,
        owner_persona_id: plan.owner_persona_id,
        signed_action: sign_action(&plan.action, &keys)?,
    })
}

#[cfg(test)]
#[path = "initiative_tests.rs"]
mod tests;
