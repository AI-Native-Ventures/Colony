//! The command that turns an approved Blueprint into a real company.
//!
//! This owns the local half of materialization and the journal. The relay half
//! (publishing the Company head and the three Initiatives) is done by the
//! frontend, which is where relay publishing lives, using the idempotency keys
//! returned here. That split is safe because those keys are derived rather
//! than generated: the relay recognises a repeat write by its key, so a retry
//! from a client that lost its journal still cannot apply anything twice.

use buzz_core_pkg::company_roster::{approval_timestamp, blueprint_hash};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{
    app_state::AppState,
    company::{
        actions::{company_action, initiative_actions, sign_action, ExistingProfileHead},
        seed::{seed_personas, seed_teams},
        transaction::{
            advance, begin, is_event_id, journal_path, load_journal, needs, planned_initiative_ids,
            transaction_lock, BlueprintCheckpoint, BlueprintJournal, TransactionError,
        },
    },
    managed_agents::{load_personas, load_teams, save_personas, save_teams},
    util::now_iso,
};

/// What the caller gets back. Deliberately narrow: IDs and keys, never a
/// prompt, a private key, an env var, or an auth tag.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyBlueprintExecutionResult {
    /// Whether this call did the work or found it already done.
    pub outcome: String,
    /// The company that now exists.
    pub company_id: String,
    /// Employees, created or reused.
    pub persona_ids: Vec<String>,
    /// Teams, created or reused.
    pub team_ids: Vec<String>,
    /// Stable IDs the three Initiatives will carry.
    pub initiative_ids: Vec<String>,
    /// Signed Company Action events, ready to publish, company head first.
    ///
    /// Built and signed here because the envelope has a canonical encoding the
    /// relay validates exactly; the caller transports these rather than
    /// constructing them.
    pub signed_actions: Vec<String>,
    /// How far the transaction got.
    pub checkpoint: String,
}

/// Materialize an approved Blueprint's employees and teams.
///
/// `blueprint` is the exact JSON the owner approved. It is parsed here rather
/// than trusted from the caller, so the trusted-catalog and closed-payload
/// rules apply to what actually executes, not to some earlier copy.
///
/// `expected_head_*` name the community profile head the caller read just
/// before calling. The relay mints one for every community at boot
/// (`run_profile_backfill`), so approval always edits that head rather than
/// creating a fresh one; this command has no relay connection of its own to
/// discover it, so the frontend reads it (`getActiveCompanyHead`) and passes
/// it through, the same shape `sign_community_profile_update` already takes
/// for the Settings edit.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_company_blueprint(
    app: AppHandle,
    blueprint: String,
    request_id: String,
    community_scope: String,
    expected_hash: String,
    relay_pubkey: String,
    channel_id: String,
    expected_head_event_id: String,
    expected_head_created_at: i64,
    expected_head_updated_at: i64,
    state: State<'_, AppState>,
) -> Result<CompanyBlueprintExecutionResult, String> {
    // Approving a company is an owner action. Reading the signing key proves
    // an owner identity is present and usable, and gives the key the journal
    // is scoped by. `signing_keys` also refuses while the identity is in
    // recovery mode, which is exactly when nothing should be created.
    let keys = state
        .signing_keys()
        .map_err(|_| TransactionError::NotOwner.to_string())?;
    let owner_pubkey = keys.public_key().to_hex();

    if !is_event_id(&relay_pubkey) {
        return Err("relay pubkey is not a valid public key".to_string());
    }
    if !is_event_id(&expected_head_event_id) {
        return Err("community profile head is not a valid event id".to_string());
    }

    let parsed = buzz_core_pkg::company_roster::parse_blueprint(&blueprint)
        .map_err(|error| error.to_string())?;

    // The request ID is part of the approval, so a blueprint whose embedded ID
    // disagrees with the action's is not the document that was approved.
    if parsed.request_id != request_id {
        return Err(TransactionError::HashMismatch.to_string());
    }

    // The hash the owner approved. It is what binds this execution to the
    // document that was actually reviewed, so it is required rather than
    // optional: an absent hash would silently mean "execute whatever I was
    // handed", which is the whole thing this check exists to prevent.
    if expected_hash != blueprint_hash(&parsed) {
        return Err(TransactionError::HashMismatch.to_string());
    }

    let dir = crate::managed_agents::storage::managed_agents_base_dir(&app)?.join("company");
    let path = journal_path(&dir, &owner_pubkey, &community_scope, &request_id);

    // Two clicks on Approve join here rather than racing.
    let lock = transaction_lock(&path);
    let _guard = lock.lock().await;

    let app_for_blocking = app.clone();
    let for_actions = parsed.clone();
    let scope_for_actions = community_scope.clone();
    let journal = tokio::task::spawn_blocking(move || -> Result<BlueprintJournal, String> {
        let state = app_for_blocking.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;

        let existing = load_journal(&path).map_err(|error| error.to_string())?;
        let mut journal = begin(
            existing,
            &owner_pubkey,
            &community_scope,
            &request_id,
            &parsed,
        )
        .map_err(|error| error.to_string())?;
        advance(&mut journal, &path, BlueprintCheckpoint::Validated)
            .map_err(|error| error.to_string())?;

        let now = now_iso();

        // Employees first, then teams: a team names its members, so writing a
        // team whose personas do not exist yet would leave a window where the
        // app can load a team pointing at nothing.
        // Seeding is idempotent on its own, so a repeat is harmless; the
        // checkpoint just saves reading and rewriting the stores.
        if needs(&journal, BlueprintCheckpoint::PersonasSeeded) {
            let personas = load_personas(&app_for_blocking)?;
            let seeded = seed_personas(&community_scope, &parsed, &personas, &now);
            if !seeded.created_personas.is_empty() {
                let mut next = personas;
                next.extend(seeded.created_personas.clone());
                save_personas(&app_for_blocking, &next)?;
            }
            journal.persona_ids = seeded.persona_ids();
            advance(&mut journal, &path, BlueprintCheckpoint::PersonasSeeded)
                .map_err(|error| error.to_string())?;
        }

        if needs(&journal, BlueprintCheckpoint::TeamsSeeded) {
            let teams = load_teams(&app_for_blocking)?;
            // The community the blueprint was approved on, so its teams are
            // not planned against, listed on, or published to the others.
            let approval_relay = crate::relay::relay_ws_url_with_override(&state);
            let seeded_teams = seed_teams(&community_scope, &parsed, &teams, &approval_relay, &now)
                .map_err(|error| error.to_string())?;
            if !seeded_teams.created_teams.is_empty() {
                let mut next = teams;
                next.extend(seeded_teams.created_teams.clone());
                save_teams(&app_for_blocking, &next)?;
            }
            journal.team_ids = seeded_teams.team_ids();
            journal.initiative_ids = planned_initiative_ids(&parsed);
            advance(&mut journal, &path, BlueprintCheckpoint::TeamsSeeded)
                .map_err(|error| error.to_string())?;
        }

        Ok(journal)
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))??;

    // Signed only after the local half, so the caller never holds publishable
    // actions for a company whose employees do not exist yet.
    //
    // The three Initiatives are still `Create`s with nothing to conflict
    // with, so their timestamp stays derived from the approval rather than
    // read from the clock: a retry has to produce the same bytes as the
    // first attempt, and `now` would make every attempt a different event.
    // The company profile action is different: it replaces a head the relay
    // already minted at boot (`run_profile_backfill`), and that replacement
    // contract requires `updatedAt` to be strictly newer than what is
    // stored, which a fixed derived timestamp cannot promise. It gets the
    // real clock instead; `company_action` floors it against the existing
    // head's own `updatedAt`, so a retry still produces a valid write even
    // if the wall clock has not visibly moved.
    let created_at = approval_timestamp(&journal.request_id);
    let now = chrono::Utc::now().timestamp();
    let existing_head = ExistingProfileHead {
        event_id: expected_head_event_id,
        created_at: expected_head_created_at,
        updated_at: expected_head_updated_at,
    };
    let mut signed_actions = Vec::with_capacity(1 + for_actions.proposed_initiatives.len());
    signed_actions.push(sign_action(
        &company_action(&for_actions, &relay_pubkey, now, &existing_head)?,
        &keys,
    )?);
    for action in initiative_actions(
        &for_actions,
        &scope_for_actions,
        &relay_pubkey,
        &channel_id,
        created_at,
    )? {
        signed_actions.push(sign_action(&action, &keys)?);
    }

    Ok(CompanyBlueprintExecutionResult {
        // `Validated` means a previous call already got past seeding, so this
        // one found the work done.
        outcome: if journal.checkpoint > BlueprintCheckpoint::TeamsSeeded {
            "recovered".to_string()
        } else {
            "created".to_string()
        },
        company_id: journal.company_id.clone(),
        persona_ids: journal.persona_ids.clone(),
        team_ids: journal.team_ids.clone(),
        initiative_ids: journal.initiative_ids.clone(),
        signed_actions,
        checkpoint: serde_json::to_value(journal.checkpoint)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default(),
    })
}

/// Record that the relay accepted the Company head and the Initiatives.
///
/// Called by the frontend once it holds receipts. Only then is the transaction
/// complete: a journal that claimed completion before the relay confirmed
/// would let a resumed run skip a write that never landed.
#[tauri::command]
pub async fn complete_company_blueprint(
    app: AppHandle,
    request_id: String,
    community_scope: String,
    company_event_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let owner_pubkey = state
        .signing_keys()
        .map_err(|_| TransactionError::NotOwner.to_string())?
        .public_key()
        .to_hex();

    // This process cannot check that the relay accepted anything, but it can
    // refuse to record something that is not an event ID at all. A journal
    // marked complete is believed by every later run, so what it points at had
    // better be plausible.
    if !is_event_id(&company_event_id) {
        return Err("company event id is not a valid event id".to_string());
    }

    let dir = crate::managed_agents::storage::managed_agents_base_dir(&app)?.join("company");
    let path = journal_path(&dir, &owner_pubkey, &community_scope, &request_id);
    let lock = transaction_lock(&path);
    let _guard = lock.lock().await;

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut journal = load_journal(&path)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "no materialization is in progress for this approval".to_string())?;
        if journal.owner_pubkey != owner_pubkey {
            return Err(TransactionError::NotOwner.to_string());
        }
        // Completing a transaction whose local half never ran would record a
        // company with no employees as finished, and no later run would fix
        // it, because every step checks the checkpoint before doing work.
        if needs(&journal, BlueprintCheckpoint::TeamsSeeded) {
            return Err("this approval has not finished creating its employees".to_string());
        }
        // The relay writes are only known to have happened once the frontend
        // reports their receipts, so this is where that gets recorded. It is
        // deliberately two steps: a journal that claimed completion before the
        // relay confirmed would let a resumed run skip a write that never
        // landed.
        journal.company_event_id = Some(company_event_id);
        advance(&mut journal, &path, BlueprintCheckpoint::RelayPublished)
            .map_err(|error| error.to_string())?;
        advance(&mut journal, &path, BlueprintCheckpoint::Completed)
            .map_err(|error| error.to_string())?;
        Ok(journal.company_id)
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))?
}
