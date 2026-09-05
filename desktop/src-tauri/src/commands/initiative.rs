//! Starting an initiative: the owner-signed half.
//!
//! The frontend holds the relay-authored heads it read and the connection to
//! publish on; this holds the owner's signing key and the rule for what may be
//! published. It deliberately does not take the initiative *record* from the
//! caller. It takes the relay-signed event and re-derives the record from it,
//! so an action can only ever carry a body the tenant relay itself wrote. A
//! caller that passed a hand-edited initiative would otherwise get the owner's
//! signature on it.

use buzz_core_pkg::company::ThreadAttachMode;
use buzz_sdk_pkg::{
    company::{parse_company_event, parse_initiative_event},
    company_blueprint::sign_action,
    implicit_task::{plan_user_task, UserTaskRequest},
    initiative_activation::{next_step, InitiativeIntent, InitiativeStep},
    thread_task::{plan_thread_attach, ThreadAttachRequest},
    user_initiative::{plan_user_initiative, UserInitiativePlan, UserInitiativeRequest},
};
use nostr::JsonUtil;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
    app_state::AppState,
    company::transaction::is_event_id,
    managed_agents::{
        enrol_persona_for_relay, ensure_coordination_team_for_relay, is_coordination_team_id,
        load_personas, load_teams, save_personas, save_teams, sort_teams,
        storage::{load_managed_agents, save_managed_agents},
        team_applies_to_relay, AgentDefinition, ManagedAgentRecord, TeamRecord,
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

/// Keep only the teams the community reachable at `relay_url` may plan work
/// against.
///
/// One `teams.json` serves every community this device has joined, so the
/// stored list is not a company: it is every company the device knows.
/// Handing all of it to the thread-task planner let a send in one community be
/// charged to a team whose members live only in another.
///
/// Two rules, the second deliberately stricter. A team pinned to another
/// relay is out, while an unpinned one stays, exactly as every team behaved
/// before the pin existed. A coordination team this client seeds must
/// additionally BE pinned here: `owning_team_for_chat` falls back to the
/// first team whose id ends in the coordination slug, so an unpinned one
/// would own ambiguous work for every community at once. That is the
/// pre-migration device-wide record, which survives a `load_teams` whenever
/// `split_legacy_coordination_team` found no relay pin to split it by.
///
/// A blueprint's own `company-team:...:company-coordination` is not one of
/// ours, so [`is_coordination_team_id`] leaves it under the first rule alone:
/// dropping an unpinned one would take away the real coordination team whose
/// id this community's existing Tasks already name.
///
/// Pure, so the rule is provable without an `AppHandle`.
fn teams_for_relay(teams: Vec<TeamRecord>, relay_url: &str) -> Vec<TeamRecord> {
    teams
        .into_iter()
        .filter(|team| {
            // `team_applies_to_relay` has already accepted an unpinned team,
            // so `is_some` here is only the "and it names this relay" half.
            team_applies_to_relay(team, relay_url)
                && (!is_coordination_team_id(&team.id) || team.relay_url.is_some())
        })
        .collect()
}

/// One community's teams, projected into what the company contract validates.
///
/// These are the same records published as the Team projection the relay
/// checks against. If they have drifted, the relay refuses the Task and says
/// so in its receipt rather than this process guessing.
///
/// Seeds this community's coordination team when it has none, and persists
/// that. A device that hired agents through the ordinary UI but never
/// approved a blueprint here has no team for it, and without one every
/// ambiguous send fails with "this company has no coordination team to own
/// ambiguous work". `resolve_chat_agent_persona` already seeds on the chat
/// path, but `create_user_task` and `advance_initiative` never call it. The
/// seed is idempotent, so the two are not competing writers.
///
/// Sorted before projecting, because `owning_team_for_chat` resolves
/// ambiguous work by taking the FIRST team whose id ends in the coordination
/// slug, which makes the order of this list a behaviour rather than a
/// presentation detail.
///
/// `ensure_coordination_team_for_relay` appends, while every other route to a
/// team list arrives through `load_teams`, which returns `sort_teams` order.
/// So without this the call that happens to seed answers a chat send with one
/// team and the very next call, reading the same store back, answers it with
/// another. `sort_teams` puts built-ins first, so the community's own default
/// wins the fallback either way. That is the right winner: the alternative it
/// beats is an UNPINNED blueprint coordination team, which belongs to no
/// community in particular, and this one is pinned to the community actually
/// being planned against.
///
/// Sorted unconditionally rather than only after a seed, so the order this
/// returns is a property of the function instead of a property of whether
/// this particular call happened to write.
///
/// Returns whether `teams` gained a record, so the caller knows to write the
/// store back. Split from [`company_team_refs`] so the planner path itself,
/// and not a hand-assembled imitation of it, is what the tests below run.
fn plan_team_refs(
    teams: &mut Vec<TeamRecord>,
    relay_url: &str,
    now: &str,
) -> (bool, Vec<buzz_core_pkg::company::CompanyTeamRef>) {
    let seeded = ensure_coordination_team_for_relay(teams, relay_url, now);
    sort_teams(teams);
    let refs = teams_to_company_refs(teams_for_relay(teams.clone(), relay_url));
    (seeded, refs)
}

/// [`plan_team_refs`] against the stored team list, persisting a seed.
///
/// Holds `managed_agents_store_lock` across the whole load, seed, and save.
/// This is a read-modify-write of one shared `teams.json`, and all three
/// callers reach it without a guard: `advance_initiative` and
/// `create_user_task` never take one, and `attach_thread_task` has already
/// dropped the guard it held for the persona repair by the time it gets here.
/// Two of them running concurrently would each load the same store, each seed
/// into their own copy, and the later save would drop whatever the earlier one
/// wrote, which for a device whose community has no coordination team yet is
/// the record that decides whether chat work can be assigned at all.
///
/// Taking the lock here is safe precisely because no caller holds it at this
/// point; `managed_agents_store_lock` is a plain mutex and re-entering it from
/// a caller that already held it would deadlock rather than fail.
fn company_team_refs(
    app: &AppHandle,
    state: &AppState,
    relay_url: &str,
) -> Result<Vec<buzz_core_pkg::company::CompanyTeamRef>, String> {
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;

    let mut teams = load_teams(app)?;
    let (seeded, refs) = plan_team_refs(&mut teams, relay_url, &crate::util::now_iso());
    if seeded {
        save_teams(app, &teams)?;
    }
    Ok(refs)
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

    // Scoped to the community this window is looking at, the same way
    // `list_teams` scopes what the owner can see.
    let teams = company_team_refs(
        &app,
        &state,
        &crate::relay::relay_ws_url_with_override(&state),
    )?;

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
    /// The persona the relay should charge the work to.
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
/// Pulled out of `attach_thread_task` so the repair logic is testable without an
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
    // second `attach_thread_task` call before this backfill's save lands — mints
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

/// The request one agent-directed send makes of the relay before it publishes.
///
/// No task id: which task the send is charged to is the relay's decision, and
/// a client that named one would be claiming an answer rather than asking the
/// question. The caller publishes this action and reads the task out of the
/// receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadAttachResult {
    /// The signed Company Action asking which task this send belongs to.
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

/// Which of the three things a send can ask its thread for.
fn thread_attach_mode(mode: &str) -> Result<ThreadAttachMode, String> {
    match mode {
        "open" => Ok(ThreadAttachMode::Open),
        "attach" => Ok(ThreadAttachMode::Attach),
        "new" => Ok(ThreadAttachMode::New),
        _ => Err("a send asks its thread to open, attach, or start a new task".to_string()),
    }
}

/// Ask the relay which Task one agent-directed send is charged to.
///
/// Every paid agent turn is charged to a Task, and this is how a send finds
/// out which one: an unattributed turn is money spent that no cost centre,
/// team, or commercial purpose can be traced to, and the classification cannot
/// be recovered afterwards.
///
/// The desktop used to mint the Task itself, so one piece of work discussed
/// over five messages produced five Tasks. It no longer decides: a thread
/// holds at most one open Task, and only the relay's database can arbitrate
/// that between a desktop and a phone preparing the same send. This signs the
/// question; the answer arrives as the relay's receipt.
///
/// `send_id` is the caller's stable identity for this send. Retrying the same
/// send asks the same question, because every key here is derived from it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn attach_thread_task(
    app: AppHandle,
    channel_id: String,
    send_id: String,
    agent_pubkey: Option<String>,
    title: String,
    mode: String,
    thread_root: Option<String>,
    conversation_scope: bool,
    client_organization_id: Option<String>,
    parent_task_id: Option<String>,
    relay_pubkey: String,
    state: State<'_, AppState>,
) -> Result<ThreadAttachResult, String> {
    let keys = state
        .signing_keys()
        .map_err(|_| "recording company work requires the community owner".to_string())?;

    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }
    let mode = thread_attach_mode(mode.trim())?;
    let thread_root = validated_thread_root(thread_root)?;

    // The mention flow knows agents by public key; the company contract knows
    // them by persona. Live hire paths link one at creation time, but nothing
    // ever backfills a persona for a record that predates that (or was created
    // without one). `backfill_persona_snapshots` explicitly skips
    // `persona_id: None` records, so such an agent could never send a chat
    // message again. `resolve_chat_agent_persona` repairs the record in place
    // the first time this runs for it; a repeat call is a cheap read.
    //
    // A send that names no agent resolves no persona: the relay charges it to
    // the thread's task all the same, and the team follows from whoever
    // answers rather than from a mention this message never made.
    let normalized = agent_pubkey
        .map(|pubkey| pubkey.trim().to_lowercase())
        .filter(|pubkey| !pubkey.is_empty());
    let relay_url = crate::relay::relay_ws_url_with_override(&state);
    let agent_persona_id = match normalized.as_deref() {
        None => None,
        Some(pubkey) => {
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
                pubkey,
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

            Some(outcome.persona_id)
        }
    };

    // Seeds this community's coordination team when it has none, so the relay
    // has a team to charge the turn to before the question is even asked.
    company_team_refs(&app, &state, &relay_url)?;

    // Derived from the send rather than read from the clock, so a retry
    // produces the same bytes and the relay recognises the replay.
    let now = buzz_core_pkg::company_roster::approval_timestamp(&format!("{channel_id}:{send_id}"));

    let action = plan_thread_attach(ThreadAttachRequest {
        channel_id: &channel_id,
        thread_root: thread_root.as_deref(),
        conversation_scope,
        send_id: &send_id,
        mode,
        title: &title,
        agent_persona_id: agent_persona_id.as_deref(),
        client_organization_id: client_organization_id.as_deref(),
        parent_task_id: parent_task_id.as_deref(),
        owner_pubkey: &keys.public_key().to_hex(),
        relay_pubkey: &relay_pubkey,
        now,
    })?;

    Ok(ThreadAttachResult {
        signed_action: sign_action(&action, &keys)?,
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

    // This command never goes through `resolve_chat_agent_persona`, so the
    // active community is read here rather than inherited from a repair.
    let teams = company_team_refs(
        &app,
        &state,
        &crate::relay::relay_ws_url_with_override(&state),
    )?;

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
        &company_team_refs(
            &app,
            &state,
            &crate::relay::relay_ws_url_with_override(&state),
        )?,
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
