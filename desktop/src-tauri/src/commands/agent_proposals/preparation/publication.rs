//! Confirm the prepared identity and membership before the existing Start path takes over.

use buzz_core_pkg::kind::{KIND_MANAGED_AGENT, KIND_PERSONA};
use nostr::{Event, JsonUtil, Keys};
use tauri::AppHandle;

use super::{AgentProposalPreparation, AgentProposalSafeAction};
use crate::{
    app_state::AppState,
    managed_agents::{
        agent_events::build_agent_event,
        load_managed_agents, load_personas,
        persona_events::build_persona_event,
        retention::{active_retention_scope, get_retained_event, open_retention_db},
        ManagedAgentRecord,
    },
};

struct Publication {
    owner: Keys,
    agent: Keys,
    record: ManagedAgentRecord,
    heads: Vec<Event>,
}

fn validate_retained_head(event: &Event, expected: &Event) -> Result<(), String> {
    if event.pubkey != expected.pubkey
        || event.kind != expected.kind
        || event.tags.identifier() != expected.tags.identifier()
        || event.content != expected.content
        || !event
            .tags
            .iter()
            .map(|tag| tag.as_slice())
            .eq(expected.tags.iter().map(|tag| tag.as_slice()))
        || event.verify().is_err()
    {
        return Err("The worker is saved but its retained profile does not match the approved team. Retry setup.".into());
    }
    Ok(())
}

fn capture(
    action: &AgentProposalSafeAction,
    preparation: &AgentProposalPreparation,
    app: &AppHandle,
    state: &AppState,
    pubkey: &str,
) -> Result<Publication, String> {
    let _identity = preparation.lock(state)?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let records = load_managed_agents(app)?;
    preparation.check_leader(&records)?;
    let record = records
        .into_iter()
        .find(|record| record.pubkey == pubkey)
        .ok_or_else(|| "The prepared worker could not be found.".to_string())?;
    let definition = load_personas(app)?
        .into_iter()
        .find(|definition| definition.id == action.request_id)
        .ok_or_else(|| "The prepared worker definition could not be found.".to_string())?;
    if !super::super::definition_matches_action(&definition, &action.definition, &action.request_id)
    {
        return Err("The approved worker changed. Review your team before retrying.".into());
    }
    preparation.check_saved(&definition, &record, action)?;
    let scope = active_retention_scope(app, state)?;
    crate::commands::personas::retain_persona_pending(app, state, &definition);
    crate::managed_agents::reconcile::retain_managed_agent_pending(app, state, &record);
    let conn = open_retention_db(&scope.db_path)?;
    let mut heads = Vec::new();
    for (kind, id, builder) in [
        (
            KIND_PERSONA,
            action.request_id.as_str(),
            build_persona_event(&definition)?,
        ),
        (KIND_MANAGED_AGENT, pubkey, build_agent_event(&record)?),
    ] {
        let retained =
            get_retained_event(&conn, kind, &preparation.owner_pubkey, id)?.ok_or_else(|| {
                "The worker is saved but its profile could not be prepared. Retry setup."
                    .to_string()
            })?;
        let event = Event::from_json(&retained.raw_event)
            .map_err(|_| "The prepared worker profile could not be read.".to_string())?;
        // Retaining is best effort. An older valid signature cannot stand in for
        // the current approved projection if that refresh failed. Timestamps and
        // signature bytes may differ; public kind, coordinate, content and tags may not.
        let expected = builder
            .sign_with_keys(&scope.owner_keys)
            .map_err(|_| "The approved worker profile could not be built.".to_string())?;
        validate_retained_head(&event, &expected)?;
        heads.push(event);
    }
    let agent = Keys::parse(&record.private_key_nsec)
        .map_err(|_| "The prepared worker identity could not be opened.".to_string())?;
    Ok(Publication {
        owner: scope.owner_keys,
        agent,
        record,
        heads,
    })
}

pub(super) async fn attach(
    action: &AgentProposalSafeAction,
    preparation: &AgentProposalPreparation,
    app: &AppHandle,
    state: &AppState,
    pubkey: &str,
) -> Result<(), String> {
    let publication = capture(action, preparation, app, state, pubkey)?;
    for head in &publication.heads {
        preparation.check(state)?;
        crate::relay::submit_signed_event_with_keys(head, state, &publication.owner, None)
            .await
            .map_err(|_| {
                "The worker is saved but its profile has not reached this business. Retry setup."
                    .to_string()
            })?;
    }
    preparation.check(state)?;
    let profile = crate::relay::build_profile_event(
        &publication.agent,
        &publication.record.name,
        publication.record.avatar_url.as_deref(),
        publication.record.auth_tag.as_deref(),
        publication.record.role_id.as_deref(),
    )?;
    crate::relay::submit_signed_event_with_keys(
        &profile,
        state,
        &publication.agent,
        publication.record.auth_tag.as_deref(),
    )
    .await
    .map_err(|_| {
        "The worker is saved but its sign-in profile has not reached this business. Retry setup."
            .to_string()
    })?;
    super::membership::attach_if_absent(preparation, state, &publication.owner, pubkey).await?;
    // Re-read after network I/O: do not report a modified or cross-account worker ready.
    super::super::load_creation_recovery(app, state, action)?;
    Ok(())
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;
