//! Typed event builders for chat-native Blocks.

use buzz_core::{
    block::{
        canonical_json, normalize_block_handle, validate_instance, validate_manifest,
        BlockCatalogEntry, BlockCatalogStatus, BlockInteraction, BlockManifest,
        BLOCK_ATTENTION_REQUIRED_TAG, BLOCK_ATTENTION_RESOLVED_TAG,
    },
    kind::{KIND_BLOCK_ACTION, KIND_BLOCK_CATALOG_ENTRY, KIND_BLOCK_MANIFEST, KIND_BLOCK_RECEIPT},
};
use nostr::{EventBuilder, EventId, Kind, PublicKey, Tag, Timestamp, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::SdkError;

const INLINE_DATA_MAX_BYTES: usize = 32 * 1024;
const EXTERNAL_DATA_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Durable attention requested by a Block instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockAttention {
    /// The instance does not require a human decision.
    None,
    /// The named decision maker must explicitly resolve the instance.
    Required {
        /// Human whose decision is required.
        decision_maker: PublicKey,
    },
}

/// Thread coordinates for a Block instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockThreadRef {
    /// Root event in the conversation thread.
    pub root_event_id: EventId,
    /// Immediate parent event.
    pub parent_event_id: EventId,
}

/// Inline or externally stored instance data.
#[derive(Debug, Clone, PartialEq)]
pub enum BlockInstanceData {
    /// Canonical JSON embedded directly in a `block-data` tag.
    Inline(Value),
    /// Content-addressed JSON downloaded and verified by the client.
    External {
        /// Public HTTP(S) URL.
        url: String,
        /// Declared MIME type.
        mime: String,
        /// Lowercase SHA-256 digest of the bytes.
        sha256: String,
        /// Declared byte size.
        byte_size: u64,
        /// Local source data used by the SDK to validate against the manifest.
        validation_data: Value,
    },
}

/// Input for a kind `9` Block instance.
#[derive(Debug, Clone)]
pub struct BlockInstanceInput<'a> {
    /// Conversation channel.
    pub channel_id: Uuid,
    /// Exact immutable manifest event.
    pub manifest_id: EventId,
    /// Stable instance identifier.
    pub instance_id: Uuid,
    /// Pinned manifest contract.
    pub manifest: &'a BlockManifest,
    /// Human-readable fallback text.
    pub fallback: String,
    /// Inline or external instance data.
    pub data: BlockInstanceData,
    /// Processor responsible for any signed action.
    pub processor: Option<PublicKey>,
    /// Optional conversation thread.
    pub thread: Option<BlockThreadRef>,
    /// Durable attention state.
    pub attention: BlockAttention,
}

/// Input for a signed Block action.
#[derive(Debug, Clone)]
pub struct BlockActionInput<'a> {
    /// Conversation channel.
    pub channel_id: Uuid,
    /// Processor responsible for executing the accepted action.
    pub processor: PublicKey,
    /// Block instance event being acted on.
    pub instance_event_id: EventId,
    /// Exact immutable manifest event.
    pub manifest_id: EventId,
    /// Stable instance identifier.
    pub instance_id: Uuid,
    /// Pinned manifest contract.
    pub manifest: &'a BlockManifest,
    /// Declared signed action identifier.
    pub action_id: String,
    /// Schema-valid, non-secret action input.
    pub data: Value,
    /// Caller-provided retry key, or `None` to generate a UUID.
    pub idempotency_key: Option<Uuid>,
}

/// A Block action builder together with the effective retry key.
pub struct BuiltBlockAction {
    /// Unsigned Nostr event builder.
    pub builder: EventBuilder,
    /// Effective idempotency key, generated when the caller did not supply one.
    pub idempotency_key: Uuid,
}

/// Receipt status carried in the public receipt tag.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BlockReceiptStatus {
    /// Processing completed successfully.
    Succeeded,
    /// The requested operation was explicitly denied.
    Denied,
    /// Processing failed and remains retryable.
    Failed,
    /// Processing exceeded its execution window and remains retryable.
    TimedOut,
}

impl BlockReceiptStatus {
    fn as_tag_value(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Denied => "denied",
            Self::Failed => "failed",
            Self::TimedOut => "timed-out",
        }
    }

    fn can_resolve_attention(self) -> bool {
        matches!(self, Self::Succeeded | Self::Denied)
    }
}

/// Input for an auditable Block action receipt.
#[derive(Debug, Clone)]
pub struct BlockReceiptInput<'a> {
    /// Conversation channel.
    pub channel_id: Uuid,
    /// Accepted action event.
    pub action_event_id: EventId,
    /// Original Block instance event.
    pub instance_event_id: EventId,
    /// Stable instance identifier.
    pub instance_id: Uuid,
    /// Retry key copied from the action.
    pub idempotency_key: Uuid,
    /// Action declaration used to authorize attention resolution.
    pub action_id: String,
    /// Pinned manifest contract.
    pub manifest: &'a BlockManifest,
    /// Terminal or current result status.
    pub status: BlockReceiptStatus,
    /// Safe result data.
    pub result: Value,
    /// Request a durable resolved-attention marker.
    pub resolves_attention: bool,
}

/// Build an immutable Block manifest event.
pub fn build_block_manifest(manifest: &BlockManifest) -> Result<EventBuilder, SdkError> {
    validate_manifest(manifest).map_err(block_error)?;
    let content = canonical_content(manifest)?;
    let version = manifest.version.to_string();
    let tags = [tag(&["block", "1", &manifest.handle, &version])?];
    Ok(
        EventBuilder::new(Kind::Custom(KIND_BLOCK_MANIFEST as u16), content)
            .tags(tags)
            .custom_created_at(Timestamp::from(manifest.created_at)),
    )
}

/// Build the relay-authored catalog head for one stable Block handle.
pub fn build_block_catalog_entry(entry: &BlockCatalogEntry) -> Result<EventBuilder, SdkError> {
    let handle = normalize_block_handle(&entry.handle).map_err(block_error)?;
    if handle != entry.handle {
        return Err(SdkError::InvalidInput(
            "catalog handle must already be normalized".to_owned(),
        ));
    }
    EventId::from_hex(&entry.active_manifest_id)
        .map_err(|error| SdkError::InvalidInput(format!("invalid active manifest ID: {error}")))?;
    let state = match entry.status {
        BlockCatalogStatus::Active => "active",
        BlockCatalogStatus::Deprecated => "deprecated",
    };
    let tags = [
        tag(&["d", &handle])?,
        tag(&["e", &entry.active_manifest_id, "", "block-manifest"])?,
        tag(&["block-state", state])?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_BLOCK_CATALOG_ENTRY as u16),
        canonical_content(entry)?,
    )
    .tags(tags))
}

/// Build a normal kind `9` message containing a validated Block instance.
pub fn build_block_instance(input: &BlockInstanceInput<'_>) -> Result<EventBuilder, SdkError> {
    validate_manifest(input.manifest).map_err(block_error)?;
    if input.fallback.trim().is_empty() {
        return Err(SdkError::InvalidInput(
            "Block fallback text must not be empty".to_owned(),
        ));
    }

    let signed_actions = input
        .manifest
        .actions
        .iter()
        .any(|action| matches!(action.interaction, BlockInteraction::Signed { .. }));
    if signed_actions && input.processor.is_none() {
        return Err(SdkError::InvalidInput(
            "a responsible processor is required for signed Block actions".to_owned(),
        ));
    }
    let resolves_attention = input.manifest.actions.iter().any(|action| {
        matches!(
            action.interaction,
            BlockInteraction::Signed {
                resolves_attention: true,
                ..
            }
        )
    });
    if let BlockAttention::Required { decision_maker } = &input.attention {
        if !resolves_attention {
            return Err(SdkError::InvalidInput(
                "attention requires a manifest-declared resolving action".to_owned(),
            ));
        }
        if input.processor.as_ref() != Some(decision_maker) {
            return Err(SdkError::InvalidInput(
                "the attention decision maker must match the responsible processor".to_owned(),
            ));
        }
    }

    let mut tags = vec![
        tag(&["h", &input.channel_id.to_string()])?,
        tag(&["e", &input.manifest_id.to_hex(), "", "block"])?,
        tag(&[
            "block",
            "1",
            &input.manifest.handle,
            &input.manifest_id.to_hex(),
            &input.instance_id.to_string(),
        ])?,
    ];
    if let Some(thread) = input.thread {
        tags.push(tag(&[
            "e",
            &thread.root_event_id.to_hex(),
            "",
            if thread.root_event_id == thread.parent_event_id {
                "reply"
            } else {
                "root"
            },
        ])?);
        if thread.root_event_id != thread.parent_event_id {
            tags.push(tag(&["e", &thread.parent_event_id.to_hex(), "", "reply"])?);
        }
    }
    if let Some(processor) = &input.processor {
        tags.push(tag(&["p", &processor.to_hex()])?);
    }
    if matches!(input.attention, BlockAttention::Required { .. }) {
        tags.push(tag(&BLOCK_ATTENTION_REQUIRED_TAG)?);
    }
    match &input.data {
        BlockInstanceData::Inline(data) => {
            validate_instance(&input.manifest.input_schema, data).map_err(block_error)?;
            let data = canonical_json(data).map_err(block_error)?;
            if data.len() > INLINE_DATA_MAX_BYTES {
                return Err(SdkError::ContentTooLarge {
                    max: INLINE_DATA_MAX_BYTES,
                    got: data.len(),
                });
            }
            tags.push(tag(&["block-data", &data])?);
        }
        BlockInstanceData::External {
            url,
            mime,
            sha256,
            byte_size,
            validation_data,
        } => {
            validate_instance(&input.manifest.input_schema, validation_data)
                .map_err(block_error)?;
            validate_external_data(url, mime, sha256, *byte_size)?;
            tags.push(tag(&[
                "block-data-ref",
                url,
                mime,
                sha256,
                &byte_size.to_string(),
            ])?);
        }
    }

    Ok(EventBuilder::new(Kind::Custom(9), &input.fallback).tags(tags))
}

/// Build a signed Block action and return its effective idempotency key.
pub fn build_block_action(input: &BlockActionInput<'_>) -> Result<BuiltBlockAction, SdkError> {
    validate_manifest(input.manifest).map_err(block_error)?;
    let action = input
        .manifest
        .actions
        .iter()
        .find(|action| action.id == input.action_id)
        .ok_or_else(|| SdkError::InvalidInput("unknown Block action".to_owned()))?;
    let schema = match &action.interaction {
        BlockInteraction::Signed { action_id, .. } if action_id == &input.action_id => {
            action.input_schema.as_ref().ok_or_else(|| {
                SdkError::InvalidInput("signed action has no input schema".to_owned())
            })?
        }
        _ => {
            return Err(SdkError::InvalidInput(
                "presentation controls cannot produce signed actions".to_owned(),
            ))
        }
    };
    validate_instance(schema, &input.data).map_err(block_error)?;
    let idempotency_key = input.idempotency_key.unwrap_or_else(Uuid::new_v4);
    let tags = [
        tag(&["h", &input.channel_id.to_string()])?,
        tag(&["p", &input.processor.to_hex()])?,
        tag(&["e", &input.instance_event_id.to_hex(), "", "block-instance"])?,
        tag(&["e", &input.manifest_id.to_hex(), "", "block-manifest"])?,
        tag(&[
            "block-action",
            "1",
            &input.action_id,
            &input.instance_id.to_string(),
            &idempotency_key.to_string(),
        ])?,
    ];
    Ok(BuiltBlockAction {
        builder: EventBuilder::new(
            Kind::Custom(KIND_BLOCK_ACTION as u16),
            canonical_json(&input.data).map_err(block_error)?,
        )
        .tags(tags),
        idempotency_key,
    })
}

/// Build an auditable Block receipt.
pub fn build_block_receipt(input: &BlockReceiptInput<'_>) -> Result<EventBuilder, SdkError> {
    validate_manifest(input.manifest).map_err(block_error)?;
    let action = input
        .manifest
        .actions
        .iter()
        .find(|action| action.id == input.action_id)
        .ok_or_else(|| SdkError::InvalidInput("unknown Block action".to_owned()))?;
    let action_resolves = matches!(
        &action.interaction,
        BlockInteraction::Signed {
            action_id,
            resolves_attention: true,
        } if action_id == &input.action_id
    );
    if input.resolves_attention && (!action_resolves || !input.status.can_resolve_attention()) {
        return Err(SdkError::InvalidInput(
            "receipt status or action cannot resolve attention".to_owned(),
        ));
    }
    let mut tags = vec![
        tag(&["h", &input.channel_id.to_string()])?,
        tag(&["e", &input.action_event_id.to_hex(), "", "block-action"])?,
        tag(&["e", &input.instance_event_id.to_hex(), "", "block-instance"])?,
        tag(&[
            "block-receipt",
            "1",
            &input.instance_id.to_string(),
            &input.idempotency_key.to_string(),
            input.status.as_tag_value(),
        ])?,
    ];
    if input.resolves_attention {
        tags.push(tag(&BLOCK_ATTENTION_RESOLVED_TAG)?);
    }
    Ok(EventBuilder::new(
        Kind::Custom(KIND_BLOCK_RECEIPT as u16),
        canonical_json(&input.result).map_err(block_error)?,
    )
    .tags(tags))
}

/// Build a typed `a` tag referencing a relay-authored Block catalog head.
pub fn block_reference_tag(publisher: &PublicKey, handle: &str) -> Result<Tag, SdkError> {
    let handle = normalize_block_handle(handle).map_err(block_error)?;
    let coordinate = format!("{KIND_BLOCK_CATALOG_ENTRY}:{}:{handle}", publisher.to_hex());
    tag(&["a", &coordinate, "", "block"])
}

fn canonical_content<T: Serialize>(value: &T) -> Result<String, SdkError> {
    let value = serde_json::to_value(value)
        .map_err(|error| SdkError::InvalidInput(format!("cannot serialize Block: {error}")))?;
    canonical_json(&value).map_err(block_error)
}

fn validate_external_data(
    raw_url: &str,
    mime: &str,
    sha256: &str,
    byte_size: u64,
) -> Result<(), SdkError> {
    let url = Url::parse(raw_url)
        .map_err(|error| SdkError::InvalidInput(format!("invalid data URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(SdkError::InvalidInput(
            "external Block data URL must use HTTP(S)".to_owned(),
        ));
    }
    if mime.trim().is_empty() {
        return Err(SdkError::InvalidInput(
            "external Block data MIME type is required".to_owned(),
        ));
    }
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SdkError::InvalidInput(
            "external Block data hash must be lowercase SHA-256".to_owned(),
        ));
    }
    if byte_size == 0 || byte_size > EXTERNAL_DATA_MAX_BYTES {
        return Err(SdkError::InvalidInput(format!(
            "external Block data must be between 1 and {EXTERNAL_DATA_MAX_BYTES} bytes"
        )));
    }
    Ok(())
}

fn tag(parts: &[&str]) -> Result<Tag, SdkError> {
    Tag::parse(parts.iter().copied()).map_err(|error| SdkError::InvalidTag(error.to_string()))
}

fn block_error(error: buzz_core::block::BlockError) -> SdkError {
    SdkError::InvalidInput(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use buzz_core::block::{
        BlockActionDeclaration, BlockCatalogEntry, BlockCatalogStatus, BlockExample, BlockGap,
        BlockNode, BlockOrigin, BlockValidation, SectionNode, JSON_SCHEMA_DRAFT_2020_12,
    };
    use nostr::{Event, Keys};
    use serde_json::{json, Map};

    use super::*;

    fn schema() -> Value {
        json!({
            "$schema": JSON_SCHEMA_DRAFT_2020_12,
            "type": "object"
        })
    }

    fn action_schema() -> Value {
        json!({
            "$schema": JSON_SCHEMA_DRAFT_2020_12,
            "type": "object",
            "properties": {
                "value": {"type": "string"}
            },
            "required": ["value"],
            "additionalProperties": false
        })
    }

    fn manifest() -> BlockManifest {
        BlockManifest {
            schema: "https://ai-native-office.dev/schemas/block-manifest/v1".to_owned(),
            handle: "test-card".to_owned(),
            version: "1.2.3".parse().expect("semver"),
            name: "Test Card".to_owned(),
            description: "A deterministic SDK fixture".to_owned(),
            origin: BlockOrigin::Core,
            created_at: 1_700_000_000,
            input_schema: schema(),
            tree: BlockNode::Stack {
                gap: BlockGap::Medium,
                children: vec![BlockNode::Section(SectionNode {
                    title: Some("{{title}}".to_owned()),
                    text: None,
                })],
            },
            actions: vec![BlockActionDeclaration {
                id: "test.submit".to_owned(),
                label: "Submit".to_owned(),
                input_schema: Some(action_schema()),
                interaction: BlockInteraction::Signed {
                    action_id: "test.submit".to_owned(),
                    resolves_attention: true,
                },
                permissions: vec![],
            }],
            permissions: vec![],
            fallback_template: "Test: {{title}}".to_owned(),
            supported_clients: vec!["desktop".to_owned()],
            primitive_versions: BTreeMap::from([("section".to_owned(), 1)]),
            examples: vec![BlockExample {
                name: "Default".to_owned(),
                data: json!({"title": "Hello"}),
            }],
            validation: BlockValidation {
                state: buzz_core::block::BlockValidationState::Tested,
                requires_attention: true,
            },
        }
    }

    fn event(builder: EventBuilder) -> Event {
        builder
            .sign_with_keys(&Keys::generate())
            .expect("event should sign")
    }

    fn tag_values(event: &Event) -> Vec<Vec<String>> {
        event
            .tags
            .iter()
            .map(|tag| tag.as_slice().iter().map(ToString::to_string).collect())
            .collect()
    }

    fn event_id(byte: u8) -> EventId {
        EventId::from_hex(&hex_string(byte)).expect("event ID")
    }

    fn hex_string(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    #[test]
    fn blocks_manifest_has_exact_kind_tags_content_and_timestamp() {
        let manifest = manifest();
        let event = event(build_block_manifest(&manifest).expect("manifest builder"));

        assert_eq!(event.kind.as_u16() as u32, KIND_BLOCK_MANIFEST);
        assert_eq!(event.created_at.as_secs(), manifest.created_at);
        assert_eq!(
            tag_values(&event),
            vec![vec![
                "block".to_owned(),
                "1".to_owned(),
                "test-card".to_owned(),
                "1.2.3".to_owned()
            ]]
        );
        let expected = canonical_json(&serde_json::to_value(&manifest).expect("manifest JSON"))
            .expect("canonical manifest");
        assert_eq!(event.content, expected);
    }

    #[test]
    fn blocks_catalog_head_has_exact_tags_and_canonical_content() {
        let manifest_id = event_id(0x11);
        let entry = BlockCatalogEntry {
            schema: "https://ai-native-office.dev/schemas/block-catalog-entry/v1".to_owned(),
            handle: "test-card".to_owned(),
            active_manifest_id: manifest_id.to_hex(),
            status: BlockCatalogStatus::Active,
            summary: "Test card".to_owned(),
            origin: BlockOrigin::Core,
            preview: json!({"z": 1, "a": 2}),
            permissions: vec![],
            workshop: Some("buzz://message?channel=abc&id=def".to_owned()),
        };
        let event = event(build_block_catalog_entry(&entry).expect("catalog builder"));

        assert_eq!(event.kind.as_u16() as u32, KIND_BLOCK_CATALOG_ENTRY);
        assert_eq!(
            tag_values(&event),
            vec![
                vec!["d".to_owned(), "test-card".to_owned()],
                vec![
                    "e".to_owned(),
                    manifest_id.to_hex(),
                    String::new(),
                    "block-manifest".to_owned()
                ],
                vec!["block-state".to_owned(), "active".to_owned()],
            ]
        );
        assert_eq!(
            event.content,
            canonical_json(&serde_json::to_value(entry).expect("catalog JSON"))
                .expect("canonical catalog")
        );
    }

    #[test]
    fn blocks_inline_instance_has_one_data_source_and_required_attention() {
        let manifest = manifest();
        let manifest_id = event_id(0x22);
        let processor = Keys::generate().public_key();
        let instance_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").expect("UUID");
        let channel_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").expect("UUID");
        let event = event(
            build_block_instance(&BlockInstanceInput {
                channel_id,
                manifest_id,
                instance_id,
                manifest: &manifest,
                fallback: "Fallback".to_owned(),
                data: BlockInstanceData::Inline(json!({"z": 1, "a": 2})),
                processor: Some(processor),
                thread: None,
                attention: BlockAttention::Required {
                    decision_maker: processor,
                },
            })
            .expect("instance builder"),
        );

        assert_eq!(event.kind.as_u16(), 9);
        assert_eq!(event.content, "Fallback");
        assert_eq!(
            tag_values(&event),
            vec![
                vec!["h".to_owned(), channel_id.to_string()],
                vec![
                    "e".to_owned(),
                    manifest_id.to_hex(),
                    String::new(),
                    "block".to_owned()
                ],
                vec![
                    "block".to_owned(),
                    "1".to_owned(),
                    "test-card".to_owned(),
                    manifest_id.to_hex(),
                    instance_id.to_string()
                ],
                vec!["p".to_owned(), processor.to_hex()],
                BLOCK_ATTENTION_REQUIRED_TAG
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                vec!["block-data".to_owned(), r#"{"a":2,"z":1}"#.to_owned()],
            ]
        );
    }

    #[test]
    fn blocks_external_instance_has_one_content_addressed_data_source() {
        let manifest = manifest();
        let manifest_id = event_id(0x23);
        let processor = Keys::generate().public_key();
        let event = event(
            build_block_instance(&BlockInstanceInput {
                channel_id: Uuid::nil(),
                manifest_id,
                instance_id: Uuid::nil(),
                manifest: &manifest,
                fallback: "External fallback".to_owned(),
                data: BlockInstanceData::External {
                    url: "https://cdn.example.com/block.json".to_owned(),
                    mime: "application/json".to_owned(),
                    sha256: "ab".repeat(32),
                    byte_size: 1_024,
                    validation_data: json!({"title": "External"}),
                },
                processor: Some(processor),
                thread: None,
                attention: BlockAttention::None,
            })
            .expect("external instance builder"),
        );
        let tags = tag_values(&event);
        let data_tags = tags
            .iter()
            .filter(|tag| {
                matches!(
                    tag.first().map(String::as_str),
                    Some("block-data" | "block-data-ref")
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(data_tags.len(), 1);
        assert_eq!(
            data_tags[0],
            &vec![
                "block-data-ref".to_owned(),
                "https://cdn.example.com/block.json".to_owned(),
                "application/json".to_owned(),
                "ab".repeat(32),
                "1024".to_owned(),
            ]
        );
    }

    #[test]
    fn blocks_action_returns_effective_idempotency_key_and_exact_tags() {
        let manifest = manifest();
        let processor = Keys::generate().public_key();
        let instance_event_id = event_id(0x31);
        let manifest_id = event_id(0x32);
        let instance_id = Uuid::parse_str("11111111-1111-4111-8111-111111111111").expect("UUID");
        let supplied_key = Uuid::parse_str("22222222-2222-4222-8222-222222222222").expect("UUID");
        let channel_id = Uuid::parse_str("33333333-3333-4333-8333-333333333333").expect("UUID");
        let built = build_block_action(&BlockActionInput {
            channel_id,
            processor,
            instance_event_id,
            manifest_id,
            instance_id,
            manifest: &manifest,
            action_id: "test.submit".to_owned(),
            data: json!({"value": "yes"}),
            idempotency_key: Some(supplied_key),
        })
        .expect("action builder");
        assert_eq!(built.idempotency_key, supplied_key);
        let event = event(built.builder);

        assert_eq!(event.kind.as_u16() as u32, KIND_BLOCK_ACTION);
        assert_eq!(event.content, r#"{"value":"yes"}"#);
        assert_eq!(
            tag_values(&event),
            vec![
                vec!["h".to_owned(), channel_id.to_string()],
                vec!["p".to_owned(), processor.to_hex()],
                vec![
                    "e".to_owned(),
                    instance_event_id.to_hex(),
                    String::new(),
                    "block-instance".to_owned()
                ],
                vec![
                    "e".to_owned(),
                    manifest_id.to_hex(),
                    String::new(),
                    "block-manifest".to_owned()
                ],
                vec![
                    "block-action".to_owned(),
                    "1".to_owned(),
                    "test.submit".to_owned(),
                    instance_id.to_string(),
                    supplied_key.to_string()
                ],
            ]
        );

        let generated = build_block_action(&BlockActionInput {
            channel_id,
            processor,
            instance_event_id,
            manifest_id,
            instance_id,
            manifest: &manifest,
            action_id: "test.submit".to_owned(),
            data: json!({"value": "yes"}),
            idempotency_key: None,
        })
        .expect("generated action key");
        assert_ne!(generated.idempotency_key, Uuid::nil());
    }

    #[test]
    fn blocks_receipt_emits_resolved_attention_only_for_compatible_outcomes() {
        let manifest = manifest();
        let action_event_id = event_id(0x41);
        let instance_event_id = event_id(0x42);
        let instance_id = Uuid::parse_str("44444444-4444-4444-8444-444444444444").expect("UUID");
        let key = Uuid::parse_str("55555555-5555-4555-8555-555555555555").expect("UUID");
        let channel_id = Uuid::parse_str("66666666-6666-4666-8666-666666666666").expect("UUID");
        let event = event(
            build_block_receipt(&BlockReceiptInput {
                channel_id,
                action_event_id,
                instance_event_id,
                instance_id,
                idempotency_key: key,
                action_id: "test.submit".to_owned(),
                manifest: &manifest,
                status: BlockReceiptStatus::Succeeded,
                result: json!({"z": true, "a": "done"}),
                resolves_attention: true,
            })
            .expect("receipt builder"),
        );
        assert_eq!(event.kind.as_u16() as u32, KIND_BLOCK_RECEIPT);
        assert_eq!(event.content, r#"{"a":"done","z":true}"#);
        assert_eq!(
            tag_values(&event),
            vec![
                vec!["h".to_owned(), channel_id.to_string()],
                vec![
                    "e".to_owned(),
                    action_event_id.to_hex(),
                    String::new(),
                    "block-action".to_owned()
                ],
                vec![
                    "e".to_owned(),
                    instance_event_id.to_hex(),
                    String::new(),
                    "block-instance".to_owned()
                ],
                vec![
                    "block-receipt".to_owned(),
                    "1".to_owned(),
                    instance_id.to_string(),
                    key.to_string(),
                    "succeeded".to_owned()
                ],
                BLOCK_ATTENTION_RESOLVED_TAG
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            ]
        );

        let error = build_block_receipt(&BlockReceiptInput {
            channel_id,
            action_event_id,
            instance_event_id,
            instance_id,
            idempotency_key: key,
            action_id: "test.submit".to_owned(),
            manifest: &manifest,
            status: BlockReceiptStatus::Failed,
            result: json!({"error": "safe"}),
            resolves_attention: true,
        })
        .expect_err("failed receipts cannot resolve attention");
        assert!(error.to_string().contains("cannot resolve attention"));
    }

    #[test]
    fn blocks_reference_tag_has_exact_catalog_coordinate() {
        let publisher = Keys::generate().public_key();
        let tag = block_reference_tag(&publisher, "@Test-Card").expect("reference tag");
        assert_eq!(
            tag.as_slice()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec![
                "a".to_owned(),
                format!(
                    "{KIND_BLOCK_CATALOG_ENTRY}:{}:test-card",
                    publisher.to_hex()
                ),
                String::new(),
                "block".to_owned(),
            ]
        );
    }

    #[test]
    fn blocks_reject_invalid_instance_inputs_and_resolution_claims() {
        let manifest = manifest();
        let processor = Keys::generate().public_key();
        let missing_fallback = build_block_instance(&BlockInstanceInput {
            channel_id: Uuid::nil(),
            manifest_id: event_id(0x51),
            instance_id: Uuid::nil(),
            manifest: &manifest,
            fallback: "  ".to_owned(),
            data: BlockInstanceData::Inline(json!({})),
            processor: Some(processor),
            thread: None,
            attention: BlockAttention::None,
        });
        assert!(missing_fallback.is_err());

        let wrong_processor = build_block_instance(&BlockInstanceInput {
            channel_id: Uuid::nil(),
            manifest_id: event_id(0x52),
            instance_id: Uuid::nil(),
            manifest: &manifest,
            fallback: "Fallback".to_owned(),
            data: BlockInstanceData::Inline(json!({})),
            processor: Some(processor),
            thread: None,
            attention: BlockAttention::Required {
                decision_maker: Keys::generate().public_key(),
            },
        });
        assert!(wrong_processor.is_err());
    }

    #[test]
    fn blocks_canonicalize_one_hundred_differently_ordered_objects_identically() {
        let manifest = manifest();
        let processor = Keys::generate().public_key();
        let mut expected_data_tag = None;
        let mut expected_envelope_tags = None;
        let keys = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

        for iteration in 0..100 {
            let mut object = Map::new();
            for offset in 0..keys.len() {
                let index = (offset * 5 + iteration) % keys.len();
                object.insert(keys[index].to_owned(), json!(index));
            }
            let event = event(
                build_block_instance(&BlockInstanceInput {
                    channel_id: Uuid::nil(),
                    manifest_id: event_id(0x61),
                    instance_id: Uuid::nil(),
                    manifest: &manifest,
                    fallback: "Stable fallback".to_owned(),
                    data: BlockInstanceData::Inline(Value::Object(object)),
                    processor: Some(processor),
                    thread: None,
                    attention: BlockAttention::None,
                })
                .expect("canonical instance"),
            );
            let tags = tag_values(&event);
            let data_tag = tags
                .iter()
                .find(|tag| tag.first().map(String::as_str) == Some("block-data"))
                .expect("block-data tag")
                .clone();
            let envelope_tags = tags
                .iter()
                .filter(|tag| tag.first().map(String::as_str) != Some("block-data"))
                .cloned()
                .collect::<Vec<_>>();
            match (&expected_data_tag, &expected_envelope_tags) {
                (Some(expected_data), Some(expected_tags)) => {
                    assert_eq!(&data_tag, expected_data);
                    assert_eq!(&envelope_tags, expected_tags);
                }
                _ => {
                    expected_data_tag = Some(data_tag);
                    expected_envelope_tags = Some(envelope_tags);
                }
            }
        }
    }
}
