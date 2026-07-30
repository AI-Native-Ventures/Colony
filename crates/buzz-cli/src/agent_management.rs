//! Persistent owner-reviewed agent proposals published as ordinary Block messages.

use buzz_core::block::BlockManifest;
use buzz_sdk::blocks::{
    build_block_instance, BlockAttention, BlockInstanceData, BlockInstanceInput, BlockThreadRef,
};
use nostr::{EventBuilder, EventId, PublicKey};
use serde::Serialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::error::CliError;

const MAX_NAME_CHARS: usize = 120;
const MAX_PROMPT_CHARS: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentDraft {
    pub channel_id: String,
    pub display_name: String,
    pub system_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentDraft {
    pub channel_id: String,
    pub agent_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub respond_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

#[derive(Debug)]
pub struct BuiltDraftRequest {
    pub builder: EventBuilder,
    pub request_id: Uuid,
    pub instance_id: Uuid,
    pub action: &'static str,
    pub data: Value,
}

struct BuildDraftRequest<'a> {
    owner: &'a PublicKey,
    manifest_id: EventId,
    manifest: &'a BlockManifest,
    channel_id: Uuid,
    action: &'static str,
    request_id: Uuid,
    data: Value,
    fallback: String,
    thread: Option<BlockThreadRef>,
}

fn required(value: String, label: &str, max: usize) -> Result<String, CliError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CliError::Usage(format!("{label} is required")));
    }
    if value.chars().count() > max {
        return Err(CliError::Usage(format!(
            "{label} is too long (max {max} characters)"
        )));
    }
    Ok(value.to_owned())
}

fn optional(value: Option<String>, label: &str) -> Result<Option<String>, CliError> {
    value.map(|value| required(value, label, 300)).transpose()
}

fn build(input: BuildDraftRequest<'_>) -> Result<BuiltDraftRequest, CliError> {
    if input.manifest.handle != "agent-proposal" {
        return Err(CliError::Other(format!(
            "resolved Core manifest has unexpected handle {}",
            input.manifest.handle
        )));
    }
    let instance_id = input.request_id;
    let builder = build_block_instance(&BlockInstanceInput {
        channel_id: input.channel_id,
        manifest_id: input.manifest_id,
        instance_id,
        manifest: input.manifest,
        fallback: input.fallback,
        data: BlockInstanceData::Inline(input.data.clone()),
        processor: Some(*input.owner),
        thread: input.thread,
        attention: BlockAttention::Required {
            decision_maker: *input.owner,
        },
    })
    .map_err(|error| CliError::Usage(error.to_string()))?;
    Ok(BuiltDraftRequest {
        builder,
        request_id: input.request_id,
        instance_id,
        action: input.action,
        data: input.data,
    })
}

fn parse_reply_to(reply_to: Option<String>) -> Result<Option<BlockThreadRef>, CliError> {
    reply_to
        .map(|value| {
            EventId::parse(value.trim())
                .map(|event_id| BlockThreadRef {
                    root_event_id: event_id,
                    parent_event_id: event_id,
                })
                .map_err(|error| CliError::Usage(format!("invalid reply event ID: {error}")))
        })
        .transpose()
}

pub fn build_create(
    owner: &PublicKey,
    manifest_id: EventId,
    manifest: &BlockManifest,
    draft: CreateAgentDraft,
) -> Result<BuiltDraftRequest, CliError> {
    let channel_id = Uuid::parse_str(&required(draft.channel_id, "channel", 128)?)
        .map_err(|error| CliError::Usage(format!("invalid channel UUID: {error}")))?;
    let display_name = required(draft.display_name, "display name", MAX_NAME_CHARS)?;
    let system_prompt = required(draft.system_prompt, "system prompt", MAX_PROMPT_CHARS)?;
    let thread = parse_reply_to(draft.reply_to)?;
    let request_id = Uuid::new_v4();
    let data = json!({
        "mode": "create",
        "requestId": request_id,
        "channelId": channel_id,
        "displayName": display_name,
        "systemPrompt": system_prompt
    });
    build(BuildDraftRequest {
        owner,
        manifest_id,
        manifest,
        channel_id,
        action: "create",
        request_id,
        data,
        fallback: format!(
            "An agent proposed hiring {display_name}. Review the Agent Proposal in AI Native Office."
        ),
        thread,
    })
}

pub fn build_update(
    owner: &PublicKey,
    manifest_id: EventId,
    manifest: &BlockManifest,
    draft: UpdateAgentDraft,
) -> Result<BuiltDraftRequest, CliError> {
    let channel_id = Uuid::parse_str(&required(draft.channel_id, "channel", 128)?)
        .map_err(|error| CliError::Usage(format!("invalid channel UUID: {error}")))?;
    let agent_name = required(draft.agent_name, "agent name", MAX_NAME_CHARS)?;
    let display_name = optional(draft.display_name, "display name")?;
    let system_prompt = draft
        .system_prompt
        .map(|value| required(value, "system prompt", MAX_PROMPT_CHARS))
        .transpose()?;
    let runtime = optional(draft.runtime, "runtime")?;
    let provider = optional(draft.provider, "provider")?;
    let model = optional(draft.model, "model")?;
    let respond_to = optional(draft.respond_to, "respond-to")?;
    let thread = parse_reply_to(draft.reply_to)?;
    if respond_to
        .as_deref()
        .is_some_and(|value| value != "owner-only" && value != "anyone")
    {
        return Err(CliError::Usage(
            "respond-to must be owner-only or anyone".to_owned(),
        ));
    }
    if display_name.is_none()
        && system_prompt.is_none()
        && runtime.is_none()
        && provider.is_none()
        && model.is_none()
        && respond_to.is_none()
    {
        return Err(CliError::Usage(
            "include at least one field to update".to_owned(),
        ));
    }

    let request_id = Uuid::new_v4();
    let mut data = Map::from_iter([
        ("mode".to_owned(), json!("update")),
        ("requestId".to_owned(), json!(request_id)),
        ("channelId".to_owned(), json!(channel_id)),
        ("agentName".to_owned(), json!(agent_name)),
    ]);
    insert_optional(&mut data, "displayName", display_name);
    insert_optional(&mut data, "systemPrompt", system_prompt);
    insert_optional(&mut data, "runtime", runtime);
    insert_optional(&mut data, "provider", provider);
    insert_optional(&mut data, "model", model);
    insert_optional(&mut data, "respondTo", respond_to);
    build(BuildDraftRequest {
        owner,
        manifest_id,
        manifest,
        channel_id,
        action: "update",
        request_id,
        data: Value::Object(data),
        fallback: format!(
            "An agent proposed updating {agent_name}. Review the Agent Proposal in AI Native Office."
        ),
        thread,
    })
}

fn insert_optional(target: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        target.insert(key.to_owned(), Value::String(value));
    }
}

#[cfg(test)]
mod tests {
    use buzz_core::block::{parse_manifest, validate_instance};
    use nostr::Keys;

    use super::*;

    const CHANNEL: &str = "7c07e659-3610-42f4-9a5e-1e9973c09da9";
    const MANIFEST_ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const REPLY_ID: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn manifest() -> BlockManifest {
        parse_manifest(include_str!(
            "../../buzz-relay/src/core_blocks/composites/agent-proposal.json"
        ))
        .expect("bundled Agent Proposal manifest")
    }

    #[test]
    fn create_is_persisted_owner_addressed_and_schema_valid() {
        let owner = Keys::generate();
        let manifest = manifest();
        let built = build_create(
            &owner.public_key(),
            EventId::parse(MANIFEST_ID).expect("manifest ID"),
            &manifest,
            CreateAgentDraft {
                channel_id: CHANNEL.to_owned(),
                display_name: "Research helper".to_owned(),
                system_prompt: "Find sources.".to_owned(),
                reply_to: Some(REPLY_ID.to_owned()),
            },
        )
        .expect("create proposal");
        let event = built
            .builder
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert_eq!(event.kind.as_u16(), 9);
        let tags: Vec<Vec<String>> = event
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect();
        assert!(tags.iter().any(|tag| tag == &["h", CHANNEL]));
        assert!(tags
            .iter()
            .any(|tag| tag == &["p", &owner.public_key().to_hex()]));
        assert!(tags
            .iter()
            .any(|tag| { tag == &["e", MANIFEST_ID, "", "block",] }));
        assert!(tags
            .iter()
            .any(|tag| { tag == &["e", REPLY_ID, "", "reply",] }));
        assert!(tags
            .iter()
            .any(|tag| { tag == &["block-attention", "1", "required"] }));
        assert_eq!(built.request_id, built.instance_id);
        assert_eq!(
            built.data,
            json!({
                "mode": "create",
                "requestId": built.instance_id,
                "channelId": CHANNEL,
                "displayName": "Research helper",
                "systemPrompt": "Find sources."
            })
        );
        validate_instance(&manifest.input_schema, &built.data).expect("schema-valid proposal");
        let serialized = built.data.to_string().to_ascii_lowercase();
        for forbidden in [
            "privatekey",
            "private_key",
            "envvars",
            "credentials",
            "backend_config",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn update_requires_a_change() {
        let error = build_update(
            &Keys::generate().public_key(),
            EventId::parse(MANIFEST_ID).expect("manifest ID"),
            &manifest(),
            UpdateAgentDraft {
                channel_id: CHANNEL.to_owned(),
                agent_name: "Scout".to_owned(),
                display_name: None,
                system_prompt: None,
                runtime: None,
                provider: None,
                model: None,
                respond_to: None,
                reply_to: None,
            },
        )
        .expect_err("empty update");
        assert!(error.to_string().contains("at least one field"));
    }

    #[test]
    fn create_rejects_invalid_channel() {
        let error = build_create(
            &Keys::generate().public_key(),
            EventId::parse(MANIFEST_ID).expect("manifest ID"),
            &manifest(),
            CreateAgentDraft {
                channel_id: "general".to_owned(),
                display_name: "Scout".to_owned(),
                system_prompt: "Help".to_owned(),
                reply_to: None,
            },
        )
        .expect_err("invalid channel");
        assert!(error.to_string().contains("invalid channel UUID"));
    }

    fn action_schema<'a>(manifest: &'a BlockManifest, action_id: &str) -> &'a Value {
        manifest
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .and_then(|action| action.input_schema.as_ref())
            .unwrap_or_else(|| panic!("missing {action_id} schema"))
    }

    #[test]
    fn update_uses_exact_camel_case_contract() {
        let manifest = manifest();
        let built = build_update(
            &Keys::generate().public_key(),
            EventId::parse(MANIFEST_ID).expect("manifest ID"),
            &manifest,
            UpdateAgentDraft {
                channel_id: CHANNEL.to_owned(),
                agent_name: "Scout".to_owned(),
                display_name: Some("Researcher".to_owned()),
                system_prompt: Some("Find cited prospects.".to_owned()),
                runtime: Some("acp".to_owned()),
                provider: Some("trusted-provider".to_owned()),
                model: Some("model-id".to_owned()),
                respond_to: Some("owner-only".to_owned()),
                reply_to: None,
            },
        )
        .expect("update proposal");

        assert_eq!(built.request_id, built.instance_id);
        assert_eq!(
            built.data,
            json!({
                "mode": "update",
                "requestId": built.instance_id,
                "channelId": CHANNEL,
                "agentName": "Scout",
                "displayName": "Researcher",
                "systemPrompt": "Find cited prospects.",
                "runtime": "acp",
                "provider": "trusted-provider",
                "model": "model-id",
                "respondTo": "owner-only"
            })
        );
        validate_instance(&manifest.input_schema, &built.data).expect("schema-valid update");
    }

    #[test]
    fn safe_action_schemas_are_closed_non_secret_and_mode_specific() {
        let manifest = manifest();
        let request_id = Uuid::new_v4();
        let create = json!({
            "requestId": request_id,
            "definition": {
                "displayName": "Researcher",
                "avatarUrl": "https://example.com/researcher.png",
                "systemPrompt": "Find cited prospects.",
                "runtime": "acp",
                "provider": "trusted-provider",
                "model": "model-id",
                "behavior": {
                    "respondTo": "allowlist",
                    "respondToAllowlist": ["owner"],
                    "parallelism": 2
                }
            },
            "runOn": {
                "type": "provider",
                "id": "configured-provider"
            }
        });
        let update = json!({
            "requestId": request_id,
            "definition": {
                "id": "researcher",
                "displayName": "Researcher",
                "systemPrompt": "Find cited prospects."
            },
            "runOn": { "type": "local" }
        });
        let create_schema = action_schema(&manifest, "agent.create");
        let update_schema = action_schema(&manifest, "agent.update");
        validate_instance(create_schema, &create).expect("safe create action");
        validate_instance(update_schema, &update).expect("safe update action");

        let mut create_with_id = create.clone();
        create_with_id["definition"]["id"] = json!("forbidden");
        assert!(validate_instance(create_schema, &create_with_id).is_err());

        let mut update_without_id = update.clone();
        update_without_id["definition"]
            .as_object_mut()
            .expect("definition")
            .remove("id");
        assert!(validate_instance(update_schema, &update_without_id).is_err());

        for unsafe_action in [
            json!({
                "requestId": request_id,
                "definition": {
                    "displayName": "Researcher",
                    "systemPrompt": "Find prospects.",
                    "providerConfig": {"token": "secret"}
                },
                "runOn": { "type": "local" }
            }),
            json!({
                "requestId": request_id,
                "definition": {
                    "displayName": "Researcher",
                    "avatarUrl": "data:image/png;base64,abc",
                    "systemPrompt": "Find prospects."
                },
                "runOn": { "type": "local" }
            }),
            json!({
                "requestId": request_id,
                "definition": {
                    "displayName": "Researcher",
                    "systemPrompt": "Find prospects."
                },
                "runOn": {
                    "type": "provider",
                    "id": "configured-provider",
                    "config": {"token": "secret"}
                }
            }),
        ] {
            assert!(validate_instance(create_schema, &unsafe_action).is_err());
        }

        let serialized = serde_json::to_string(&create)
            .expect("serialize action")
            .to_ascii_lowercase();
        for forbidden in [
            "privatekey",
            "private_key",
            "envvars",
            "credentials",
            "providerconfig",
            "backend_config",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }
}
