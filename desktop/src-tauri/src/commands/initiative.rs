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
    managed_agents::{load_teams, storage::load_managed_agents},
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

/// This device's teams, projected into what the company contract validates.
///
/// These are the same records published as the Team projection the relay
/// checks against. If they have drifted, the relay refuses the Task and says
/// so in its receipt rather than this process guessing.
fn company_team_refs(
    app: &AppHandle,
) -> Result<Vec<buzz_core_pkg::company::CompanyTeamRef>, String> {
    Ok(load_teams(app)?
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
        .collect())
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

    let company = parse_company_event(&company_event)
        .map_err(|error| format!("the company head is unreadable: {error}"))?;
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
        &company,
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
    // them by persona. An agent with no persona has no place in any team, so it
    // has nothing that could be held accountable for the work.
    let normalized = agent_pubkey.trim().to_lowercase();
    let agent_persona_id = load_managed_agents(&app)?
        .into_iter()
        .find(|agent| agent.pubkey.trim().to_lowercase() == normalized)
        .and_then(|agent| agent.persona_id)
        .ok_or_else(|| "that agent is not a company employee".to_string())?;

    let teams = company_team_refs(&app)?;

    // Derived from the send rather than read from the clock, so a retry
    // produces the same bytes and the relay recognises the replay.
    let now = buzz_core_pkg::company_roster::approval_timestamp(&format!(
        "{}:{channel_id}:{send_id}",
        company.id
    ));

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
