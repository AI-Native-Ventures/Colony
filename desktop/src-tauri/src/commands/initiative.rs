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
    initiative_activation::{next_activation_step, InitiativeStep},
};
use nostr::JsonUtil;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{app_state::AppState, company::transaction::is_event_id, managed_agents::load_teams};

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

/// Read a relay-signed head, refusing anything the tenant relay did not write.
fn relay_head(json: &str, relay_pubkey: &str, what: &str) -> Result<nostr::Event, String> {
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
    state: State<'_, AppState>,
) -> Result<InitiativeStepResult, String> {
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

    // Teams come from this device's own records, which are the same ones
    // published as the Team projection the relay validates against. If they
    // have drifted, the relay refuses the Task and says so in its receipt.
    let teams = load_teams(&app)?
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
        .collect::<Vec<_>>();

    let status = serde_json::to_value(initiative.status)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();

    let step = next_activation_step(
        &initiative,
        &initiative_event.id.to_hex(),
        &company,
        &teams,
        &relay_pubkey,
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
