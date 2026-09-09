//! Owner-requested model selection for one teammate reply, carried by kind 9.

use nostr::{Event, PublicKey};

/// Signed tag name. The final value is the adapter's canonical model ID.
pub const AGENT_REPLY_TAG: &str = "agent-reply";

/// A model request belongs to one message and one existing teammate identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentReplyModel {
    /// Existing agent recipient; this never creates or changes an identity.
    pub target: PublicKey,
    /// Adapter-advertised model ID, including an effort suffix when applicable.
    pub model_id: String,
}

/// Validate shape and signed recipient binding, without inventing model capabilities.
pub fn parse_agent_reply_tags(
    kind: u32,
    tags: &[Vec<String>],
) -> Result<Option<AgentReplyModel>, String> {
    let mut requests = tags
        .iter()
        .filter(|tag| tag.first().is_some_and(|v| v == AGENT_REPLY_TAG));
    let Some(tag) = requests.next() else {
        return Ok(None);
    };
    if requests.next().is_some() || kind != crate::kind::KIND_STREAM_MESSAGE {
        return Err("agent-reply requires exactly one tag on a stream message".into());
    }
    if tag.len() != 4 || tag[1] != "1" {
        return Err("agent-reply must contain version, teammate pubkey and model ID".into());
    }
    let target = PublicKey::from_hex(&tag[2]).map_err(|_| "agent-reply target is invalid")?;
    if tag[2] != target.to_hex() {
        return Err("agent-reply target must be a lowercase hex pubkey".into());
    }
    if !tags
        .iter()
        .any(|t| t.first().is_some_and(|v| v == "p") && t.get(1) == Some(&tag[2]))
    {
        return Err("agent-reply target must be a mentioned recipient".into());
    }
    let model_id = &tag[3];
    if model_id.is_empty()
        || model_id.len() > 256
        || !model_id.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(
            "agent-reply model ID must be 1-256 printable characters without spaces".into(),
        );
    }
    Ok(Some(AgentReplyModel {
        target,
        model_id: model_id.clone(),
    }))
}

/// Read a signed event's request. Ownership and live capability checks belong to execution.
pub fn parse_agent_reply(event: &Event) -> Result<Option<AgentReplyModel>, String> {
    let tags = event
        .tags
        .iter()
        .map(|t| t.as_slice().to_vec())
        .collect::<Vec<_>>();
    parse_agent_reply_tags(event.kind.as_u16() as u32, &tags)
}

/// Whether an event must remain separate from normal batched/steered input.
pub fn has_agent_reply(event: &Event) -> bool {
    event
        .tags
        .iter()
        .any(|tag| tag.as_slice().first().is_some_and(|v| v == AGENT_REPLY_TAG))
}

/// Qualified adapter IDs may select a provider as well as a model. Only a
/// runtime that declares a fixed configured route may use arbitrary prefixes
/// (for example, an OpenRouter model name behind the same gateway).
pub fn model_stays_on_provider(model_id: &str, provider: Option<&str>, fixed_route: bool) -> bool {
    if fixed_route {
        return true;
    }
    match model_id.split_once('/') {
        None => true,
        Some((prefix, _)) => provider.is_some_and(|provider| prefix == provider),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tags() -> Vec<Vec<String>> {
        let target = nostr::Keys::generate().public_key().to_hex();
        vec![
            vec!["p".into(), target.clone()],
            vec![
                AGENT_REPLY_TAG.into(),
                "1".into(),
                target,
                "model[high]".into(),
            ],
        ]
    }
    #[test]
    fn request_round_trips_an_exact_model_effort_pair() {
        let parsed = parse_agent_reply_tags(9, &tags()).unwrap().unwrap();
        assert_eq!(parsed.model_id, "model[high]");
    }
    #[test]
    fn rejects_wrong_kind_duplicate_unmentioned_and_malformed_requests() {
        let original = tags();
        assert!(parse_agent_reply_tags(40003, &original).is_err());
        let mut duplicate = original.clone();
        duplicate.push(original[1].clone());
        assert!(parse_agent_reply_tags(9, &duplicate).is_err());
        assert!(parse_agent_reply_tags(9, &original[1..]).is_err());
        for invalid in ["", "model high", "model\nsecret"] {
            let mut changed = original.clone();
            changed[1][3] = invalid.into();
            assert!(parse_agent_reply_tags(9, &changed).is_err());
        }
    }
    #[test]
    fn qualified_model_ids_cannot_change_the_configured_provider() {
        assert!(model_stays_on_provider(
            "openai/model[high]",
            Some("openai"),
            false
        ));
        assert!(!model_stays_on_provider(
            "anthropic/model",
            Some("openai"),
            false
        ));
        assert!(!model_stays_on_provider("anthropic/model", None, false));
        assert!(model_stays_on_provider(
            "anthropic/model",
            Some("openrouter"),
            true
        ));
        assert!(model_stays_on_provider("unqualified-model", None, false));
    }
}
