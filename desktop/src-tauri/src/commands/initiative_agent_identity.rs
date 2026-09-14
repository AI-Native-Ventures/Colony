//! Publish a legacy agent's repaired persona before assigning its first direct job.

use buzz_core_pkg::kind::KIND_MANAGED_AGENT;
use nostr::{Event, EventBuilder, Keys, Timestamp};

use crate::{
    app_state::AppState,
    managed_agents::{
        agent_events::build_agent_event, owner_scope::agent_belongs_to_owner, ManagedAgentRecord,
    },
    relay::{
        agent_belongs_to_workspace, query_relay_at_with_keys, relay_http_base_url,
        submit_event_at_with_keys,
    },
};

pub(super) fn check_record(
    record: &ManagedAgentRecord,
    keys: &Keys,
    relay: &str,
) -> Result<(), String> {
    if !agent_belongs_to_owner(record, &keys.public_key().to_hex())
        || !agent_belongs_to_workspace(&record.relay_url, relay)
    {
        return Err("That agent belongs to another account or business.".into());
    }
    Ok(())
}

pub(super) async fn publish_repair(
    record: &ManagedAgentRecord,
    state: &AppState,
    keys: &Keys,
    relay: &str,
) -> Result<(), String> {
    check_record(record, keys, relay)?;
    let url = relay_http_base_url(relay);
    let heads = query_relay_at_with_keys(
        state,
        &url,
        &[serde_json::json!({
            "kinds": [KIND_MANAGED_AGENT], "authors": [keys.public_key().to_hex()],
            "#d": [&record.pubkey], "limit": 1
        })],
        keys,
        None,
    )
    .await?;
    if let Some(builder) = repair_builder(record, keys, heads.first())? {
        // Captured keys and URL keep an account switch from retargeting this repair.
        // A lost receipt is safe: the next attempt reads the matching head first.
        submit_event_at_with_keys(builder, state, &url, keys).await?;
    }
    Ok(())
}

fn repair_builder(
    record: &ManagedAgentRecord,
    keys: &Keys,
    head: Option<&Event>,
) -> Result<Option<EventBuilder>, String> {
    let persona = record
        .persona_id
        .as_deref()
        .ok_or("The agent has no persona.")?;
    let Some(head) = head else {
        // Use the existing public projection; never serialize the local record's secrets.
        return build_agent_event(record).map(Some);
    };
    if head.verify().is_err()
        || head.pubkey != keys.public_key()
        || head.kind.as_u16() as u32 != KIND_MANAGED_AGENT
        || head.tags.identifier() != Some(record.pubkey.as_str())
    {
        return Err("The agent identity returned by the business is invalid.".into());
    }
    let mut content: serde_json::Value =
        serde_json::from_str(&head.content).map_err(|error| error.to_string())?;
    let content_object = content
        .as_object_mut()
        .ok_or("The agent identity is unreadable.")?;
    if content_object
        .get("is_active")
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        return Err("This agent is inactive.".into());
    }
    if let Some(existing) = content_object
        .get("persona_id")
        .and_then(serde_json::Value::as_str)
    {
        return if existing == persona {
            Ok(None)
        } else {
            Err("The agent identity changed. Refresh your agents and try again.".into())
        };
    }
    content_object.insert(
        "persona_id".into(),
        serde_json::Value::String(persona.into()),
    );
    // Preserve the authoritative head's rank, manager, prompt, and other settings.
    Ok(Some(
        EventBuilder::new(head.kind, content.to_string())
            .tags(head.tags.iter().cloned())
            .custom_created_at(Timestamp::from(
                Timestamp::now()
                    .as_secs()
                    .max(head.created_at.as_secs().saturating_add(1)),
            )),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{Kind, Tag};

    #[test]
    fn repairing_an_identity_preserves_rank_and_is_retry_safe() {
        let keys = Keys::generate();
        let record = ManagedAgentRecord {
            pubkey: Keys::generate().public_key().to_hex(),
            persona_id: Some("legacy-employee:agent".into()),
            ..Default::default()
        };
        let head = EventBuilder::new(
            Kind::Custom(KIND_MANAGED_AGENT as u16),
            r#"{"name":"Christine","tier":"worker","system_prompt":"Keep the original prompt"}"#,
        )
        .tags([
            Tag::identifier(&record.pubkey),
            Tag::parse(["manager", "boss"]).expect("tag"),
        ])
        .sign_with_keys(&keys)
        .expect("head");
        let repaired = repair_builder(&record, &keys, Some(&head))
            .expect("repair")
            .expect("builder")
            .sign_with_keys(&keys)
            .expect("sign");
        let content: serde_json::Value = serde_json::from_str(&repaired.content).expect("content");
        assert_eq!(content["tier"], "worker");
        assert_eq!(content["system_prompt"], "Keep the original prompt");
        assert_eq!(repaired.tags, head.tags);
        assert!(repaired.created_at > head.created_at);
        assert!(repair_builder(&record, &keys, Some(&repaired))
            .expect("retry")
            .is_none());
        let other = Keys::generate();
        assert!(repair_builder(&record, &other, Some(&head)).is_err());
    }
}
