//! Agent kind:0 profile reconciliation — split from `agents.rs` (file-size
//! guard). Owns the reconcile data carrier, the legacy-avatar backfill, and
//! the needs-sync predicate.

use tauri::AppHandle;

use crate::app_state::AppState;
use crate::managed_agents::managed_agent_avatar_url;

use super::*;

pub(crate) struct ProfileReconcileData {
    pub(crate) private_key_nsec: String,
    pub(crate) name: String,
    pub(crate) relay_url: String,
    /// Expected avatar URL for the published profile. `None` for legacy records
    /// that predate the `avatar_url` field — these will be backfilled from the
    /// relay's existing kind:0 profile on first reconciliation.
    pub(crate) avatar_url: Option<String>,
    pub(crate) auth_tag: Option<String>,
    /// The agent's pubkey (hex). Needed to update the persisted record during
    /// avatar backfill migration.
    pub(crate) pubkey: String,
    /// The agent's command (e.g. "goose"). Used as fallback when no profile
    /// exists on the relay during avatar backfill.
    pub(crate) agent_command: String,
    /// Persona ID if this agent was created from a persona. Used during avatar
    /// backfill to recover the correct avatar from the persona record when the
    /// relay profile has been corrupted.
    pub(crate) persona_id: Option<String>,
    /// Workspace role this instance fills, published so other members' clients
    /// can recognise their own instance of the same role.
    pub(crate) role_id: Option<String>,
}

impl ProfileReconcileData {
    /// Build the carrier for `record`, resolving the harness through the one
    /// inheritance chain (override pin → record runtime → definition runtime
    /// → global preferred runtime, via
    /// `effective_config::resolve_effective_harness_command`) so avatar
    /// fallbacks reflect what a spawn would actually run.
    pub(crate) fn build(
        app: &AppHandle,
        record: &crate::managed_agents::ManagedAgentRecord,
        personas: &[crate::managed_agents::AgentDefinition],
    ) -> Self {
        let global = crate::managed_agents::load_global_agent_config(app).unwrap_or_default();
        let agent_command =
            crate::managed_agents::effective_config::resolve_effective_harness_command(
                record, personas, &global,
            )
            .unwrap_or_else(|_| crate::managed_agents::record_agent_command(record, personas));
        Self {
            private_key_nsec: record.private_key_nsec.clone(),
            name: record.name.clone(),
            relay_url: record.relay_url.clone(),
            avatar_url: record.avatar_url.clone(),
            auth_tag: record.auth_tag.clone(),
            pubkey: record.pubkey.clone(),
            agent_command,
            persona_id: record.persona_id.clone(),
            role_id: record.role_id.clone(),
        }
    }
}

/// Resolve the avatar to backfill for a legacy agent record (pre-PR-921, no
/// stored `avatar_url`).
///
/// Priority: the persona's avatar wins, because the old reconciliation code
/// could have overwritten the relay's kind:0 `picture` with the command default
/// — making the relay an unreliable source for persona-backed agents. Only fall
/// back to the relay's `picture`, then the command icon, for agents with no
/// persona avatar to recover from.
pub(super) fn resolve_legacy_avatar(
    persona_avatar: Option<String>,
    relay_picture: Option<String>,
    agent_command: &str,
) -> String {
    persona_avatar
        .or(relay_picture)
        .or_else(|| managed_agent_avatar_url(agent_command))
        .unwrap_or_default()
}

/// Reconcile an agent's kind:0 profile on the relay.
///
/// Queries the relay for the agent's existing profile and re-publishes if missing
/// or stale (display_name or picture mismatch). This is fire-and-forget — errors
/// are returned to the caller for logging but never block agent startup.
///
/// For legacy records (pre-PR-921) where `avatar_url` is `None`, this function
/// backfills via `resolve_legacy_avatar` — preferring the persona record's avatar
/// over the relay's `picture`, since the old code may have corrupted the relay
/// profile — and persists the updated record. After backfill, normal
/// reconciliation proceeds.
///
/// Query and publish target the relay returned by `effective_agent_relay_url`
/// — always the active workspace relay; the stored per-record pin is ignored
/// (agents-everywhere, #2122). Callers acting on a specific runtime pair
/// should use [`reconcile_profile_at`] with the pair's relay instead,
/// so the profile lands on the relay that process actually connects to.
pub(crate) async fn reconcile_agent_profile(
    state: &AppState,
    app: &AppHandle,
    agent_pubkey: &str,
    data: &ProfileReconcileData,
) -> Result<(), String> {
    let relay_url = crate::relay::effective_agent_relay_url(
        &data.relay_url,
        &relay_ws_url_with_override(state),
    );
    reconcile_profile_at(state, app, agent_pubkey, data, &relay_url).await
}

/// [`reconcile_agent_profile`] against an explicit relay. Runtime-pair starts
/// pass the pair's own relay, which may not be the active workspace relay.
pub(crate) async fn reconcile_profile_at(
    state: &AppState,
    app: &AppHandle,
    agent_pubkey: &str,
    data: &ProfileReconcileData,
    relay_url: &str,
) -> Result<(), String> {
    use crate::relay::{query_agent_profile, sync_managed_agent_profile};

    if !state
        .managed_agent_profile_reconcile_enabled
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }

    // Query the relay for the agent's existing kind:0 profile.
    let existing = query_agent_profile(state, relay_url, agent_pubkey).await?;

    // Resolve the expected avatar — backfilling for legacy records that have no
    // stored avatar_url yet.
    let expected_avatar = match data.avatar_url.as_deref() {
        Some(url) => url.to_string(),
        None => {
            // Legacy record: the relay profile may have been corrupted by the
            // old reconciliation code (it overwrote the persona avatar with the
            // command default), so the persona record is the authoritative source.
            let persona_avatar = data.persona_id.as_ref().and_then(|pid| {
                load_personas(app)
                    .ok()?
                    .into_iter()
                    .find(|p| p.id == *pid)?
                    .avatar_url
            });

            let backfilled = resolve_legacy_avatar(
                persona_avatar,
                existing.as_ref().and_then(|info| info.picture.clone()),
                &data.agent_command,
            );

            // Persist the backfilled avatar so this migration only runs once.
            if !backfilled.is_empty() {
                let _store_guard = state
                    .managed_agents_store_lock
                    .lock()
                    .map_err(|e| e.to_string())?;
                let mut records = load_managed_agents(app)?;
                if let Some(record) = records.iter_mut().find(|r| r.pubkey == data.pubkey) {
                    record.avatar_url = Some(backfilled.clone());
                    save_managed_agents(app, &records)?;
                }
            }

            backfilled
        }
    };

    let expected_avatar = if expected_avatar.is_empty() {
        None
    } else {
        Some(expected_avatar)
    };

    if !profile_needs_sync(
        existing.as_ref(),
        &data.name,
        expected_avatar.as_deref(),
        data.role_id.as_deref(),
    ) {
        return Ok(());
    }

    let agent_keys = Keys::parse(&data.private_key_nsec)
        .map_err(|e| format!("failed to parse agent keys: {e}"))?;

    if !state
        .managed_agent_profile_reconcile_enabled
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }

    sync_managed_agent_profile(
        state,
        relay_url,
        &agent_keys,
        &data.name,
        expected_avatar.as_deref(),
        data.auth_tag.as_deref(),
        data.role_id.as_deref(),
    )
    .await
}

/// Decide whether a published profile is missing or stale relative to the
/// expected name and avatar. A missing profile always needs sync; a present
/// one is stale when either the display name or picture diverges.
pub(super) fn profile_needs_sync(
    existing: Option<&crate::relay::AgentProfileInfo>,
    expected_name: &str,
    expected_avatar: Option<&str>,
    expected_role: Option<&str>,
) -> bool {
    match existing {
        None => true,
        Some(info) => {
            let name_matches = info.display_name.as_deref() == Some(expected_name);
            let picture_matches = info.picture.as_deref() == expected_avatar;
            // A profile published before roles existed carries no role, so
            // this is also the migration trigger: every agent republishes once
            // to advertise the role its members' clients group it by.
            let role_matches = info.role.as_deref() == expected_role;
            !name_matches || !picture_matches || !role_matches
        }
    }
}

// Async so the blocking body (disk reads/writes + process termination) runs off
// the main UI thread via spawn_blocking. State is re-derived from the owned
// AppHandle inside the closure (`State<'_, _>` is borrowed, MutexGuard is !Send).
