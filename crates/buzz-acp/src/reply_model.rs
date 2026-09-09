//! Strict per-message model application. Never writes an agent default.

use buzz_core::agent_reply::{parse_agent_reply, AgentReplyModel};
use nostr::PublicKey;

use crate::acp::{resolve_model_switch_method, AcpClient, AcpError, ModelSwitchMethod};
use crate::queue::FlushBatch;

/// Preserves the ordinary conversation while a one-reply session is borrowed.
pub(crate) struct ScopedReplySession {
    pub key: crate::pool::ConversationKey,
    original_id: Option<String>,
    original_turns: Option<u32>,
    original_delivery: Option<crate::pool::ChannelDeliveryState>,
    pub close_id: Option<String>,
    pub supports_close: bool,
    pub preserve_original: bool,
}

const MAX_UNCLOSED_REPLY_SESSIONS: usize = 8;

pub(crate) fn begin(
    state: &mut crate::pool::SessionState,
    key: crate::pool::ConversationKey,
) -> Result<(), String> {
    if state.unclosed_reply_sessions >= MAX_UNCLOSED_REPLY_SESSIONS {
        return Err("This teammate cannot release temporary reply sessions. Use teammate defaults, or restart the teammate after its current work finishes before choosing another reply setting.".into());
    }
    state.scoped_reply_session = Some(ScopedReplySession {
        original_id: state.sessions.remove(&key),
        original_turns: state.turn_counts.remove(&key),
        original_delivery: state.deliveries.remove(&key),
        key,
        close_id: None,
        supports_close: false,
        preserve_original: true,
    });
    Ok(())
}

pub(crate) async fn finish(agent: &mut crate::pool::OwnedAgent, process_exited: bool) {
    let Some(saved) = agent.state.scoped_reply_session.take() else {
        return;
    };
    if !process_exited && saved.close_id.is_some() {
        agent.state.unclosed_reply_sessions += 1;
    }
    if !process_exited && saved.supports_close {
        if let Some(id) = saved.close_id.as_deref() {
            let closed = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                agent.acp.session_close(id),
            )
            .await;
            if matches!(closed, Ok(Ok(ref result)) if result["closed"] == true && result["sessionId"].as_str() == Some(id))
            {
                agent.state.unclosed_reply_sessions =
                    agent.state.unclosed_reply_sessions.saturating_sub(1);
            } else {
                tracing::warn!("one-reply session cleanup was not confirmed");
            }
        }
    }
    restore(&mut agent.state, saved, process_exited);
}

fn restore(state: &mut crate::pool::SessionState, saved: ScopedReplySession, process_exited: bool) {
    state.invalidate_session(&saved.key.0, saved.key.1.as_deref());
    if !process_exited && saved.preserve_original {
        if let Some(id) = saved.original_id {
            state.sessions.insert(saved.key.clone(), id);
        }
        if let Some(turns) = saved.original_turns {
            state.turn_counts.insert(saved.key.clone(), turns);
        }
        if let Some(delivery) = saved.original_delivery {
            state.deliveries.insert(saved.key, delivery);
        }
    }
}

pub(crate) fn requested_model(
    batch: Option<&FlushBatch>,
    agent: PublicKey,
    owner: Option<PublicKey>,
) -> Result<Option<AgentReplyModel>, String> {
    let Some(batch) = batch else { return Ok(None) };
    let mut request = None;
    for entry in &batch.events {
        let Some(parsed) = parse_agent_reply(&entry.event)? else {
            continue;
        };
        if parsed.target != agent {
            continue;
        }
        if owner != Some(entry.event.pubkey) {
            return Err("Only this teammate's owner can select its reply model.".into());
        }
        if batch.events.len() != 1 || !batch.cancelled_events.is_empty() || request.is_some() {
            return Err("A reply model request must run as its own message.".into());
        }
        request = Some(parsed);
    }
    Ok(request)
}

pub(crate) async fn apply(
    acp: &mut AcpClient,
    session_id: &str,
    raw: &serde_json::Value,
    provider: Option<&str>,
    request: &AgentReplyModel,
) -> Result<(), AcpError> {
    let applied = &request.model_id;
    let method = requested_method(raw, provider, applied)?;
    let deadline = std::time::Duration::from_secs(5);
    tokio::time::timeout(deadline, async {
        match method {
            ModelSwitchMethod::ConfigOption {
                config_id,
                option_value,
            } => {
                acp.session_set_config_option(session_id, &config_id, &option_value)
                    .await?;
            }
            ModelSwitchMethod::SetModel { model_id } => {
                acp.session_set_model(session_id, &model_id).await?;
            }
        }
        Ok::<(), AcpError>(())
    })
    .await
    .map_err(|_| AcpError::Timeout(deadline))??;
    acp.observe(
        "reply_model_applied",
        serde_json::json!({
            "modelId": applied,
            "scope": "one_reply",
            "sessionId": session_id,
        }),
    );
    Ok(())
}

fn requested_method(
    raw: &serde_json::Value,
    provider: Option<&str>,
    model_id: &str,
) -> Result<ModelSwitchMethod, AcpError> {
    // Signed reply requests contain canonical IDs. Unlike saved agent defaults,
    // they must never gain a provider prefix or resolve through an alias.
    let method =
        resolve_model_switch_method(raw, model_id).ok_or_else(|| AcpError::AgentError {
            code: -32602,
            message:
                "The requested model and reasoning setting are not available for this teammate."
                    .into(),
        })?;
    let fixed_route = raw["_meta"]["colony"]["modelSelectionScope"] == "configuredProvider";
    if !buzz_core::agent_reply::model_stays_on_provider(model_id, provider, fixed_route) {
        return Err(AcpError::AgentError { code: -32602, message: "This model would change the teammate's provider. Choose a model on its existing connection.".into() });
    }
    Ok(method)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::BatchEvent;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn batch(owner: &Keys, target: &Keys) -> FlushBatch {
        let event = EventBuilder::new(Kind::Custom(9), "prepare a post")
            .tags([
                Tag::parse(["p", &target.public_key().to_hex()]).unwrap(),
                Tag::parse([
                    "agent-reply",
                    "1",
                    &target.public_key().to_hex(),
                    "model[high]",
                ])
                .unwrap(),
            ])
            .sign_with_keys(owner)
            .unwrap();
        FlushBatch {
            channel_id: uuid::Uuid::new_v4(),
            events: vec![BatchEvent {
                event,
                prompt_tag: "mention".into(),
                received_at: std::time::Instant::now(),
            }],
            cancelled_events: vec![],
            cancel_reason: None,
        }
    }

    #[test]
    fn binds_owner_agent_and_one_message() {
        let owner = Keys::generate();
        let target = Keys::generate();
        let mut input = batch(&owner, &target);
        assert!(
            requested_model(Some(&input), target.public_key(), Some(owner.public_key()))
                .unwrap()
                .is_some()
        );
        assert!(requested_model(Some(&input), target.public_key(), None).is_err());
        assert!(
            requested_model(Some(&input), owner.public_key(), Some(owner.public_key()))
                .unwrap()
                .is_none()
        );
        input.events.push(input.events[0].clone());
        assert!(
            requested_model(Some(&input), target.public_key(), Some(owner.public_key())).is_err()
        );
    }

    #[test]
    fn request_must_be_an_exact_catalog_id_on_the_existing_provider() {
        let raw = serde_json::json!({"models": {"availableModels": [
            {"modelId": "openai/model[high]"}, {"modelId": "anthropic/model"}
        ]}});
        assert!(requested_method(&raw, Some("openai"), "model[high]").is_err());
        assert!(requested_method(&raw, Some("openai"), "openai/model[high]").is_ok());
        assert!(requested_method(&raw, Some("openai"), "anthropic/model").is_err());
        let mut gateway = raw;
        gateway["_meta"] =
            serde_json::json!({"colony": {"modelSelectionScope": "configuredProvider"}});
        assert!(requested_method(&gateway, Some("openai"), "anthropic/model").is_ok());
    }
    #[test]
    fn ordinary_session_delivery_and_counters_survive_scoped_reply() {
        let key = (uuid::Uuid::new_v4(), Some("thread".into()));
        let mut state = crate::pool::SessionState::default();
        state
            .sessions
            .insert(key.clone(), "ordinary-session".into());
        state.turn_counts.insert(key.clone(), 7);
        state.deliveries.insert(
            key.clone(),
            crate::pool::ChannelDeliveryState {
                standing_context_sent: true,
                delivered_event_ids: ["prior-event".into()].into_iter().collect(),
            },
        );
        begin(&mut state, key.clone()).unwrap();
        assert!(!state.sessions.contains_key(&key));
        state.sessions.insert(key.clone(), "temporary".into());
        state.turn_counts.insert(key.clone(), 1);
        let saved = state.scoped_reply_session.take().unwrap();
        restore(&mut state, saved, false);
        assert_eq!(
            state.sessions.get(&key).map(String::as_str),
            Some("ordinary-session")
        );
        assert_eq!(state.turn_counts.get(&key), Some(&7));
        assert!(state.deliveries[&key].standing_context_sent);
        assert!(state.deliveries[&key]
            .delivered_event_ids
            .contains("prior-event"));
    }

    #[test]
    fn adapters_without_close_have_a_bounded_temporary_session_budget() {
        let key = (uuid::Uuid::new_v4(), None);
        let mut state = crate::pool::SessionState::default();
        state
            .sessions
            .insert(key.clone(), "ordinary-session".into());
        state.unclosed_reply_sessions = MAX_UNCLOSED_REPLY_SESSIONS;
        assert!(begin(&mut state, key.clone()).is_err());
        assert_eq!(
            state.sessions.get(&key).map(String::as_str),
            Some("ordinary-session")
        );
        assert!(state.scoped_reply_session.is_none());
    }
    #[test]
    fn channel_invalidation_during_scoped_reply_does_not_restore_stale_context() {
        let key = (uuid::Uuid::new_v4(), Some("thread".into()));
        let mut state = crate::pool::SessionState::default();
        state
            .sessions
            .insert(key.clone(), "stale-ordinary-session".into());
        begin(&mut state, key.clone()).unwrap();
        state.invalidate_channel(&key.0);
        let saved = state.scoped_reply_session.take().unwrap();
        restore(&mut state, saved, false);
        assert!(!state.sessions.contains_key(&key));
    }
}
