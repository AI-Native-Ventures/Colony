//! Public-envelope validation for chat-native Block events.
//!
//! Validation is deliberately split in two. [`parse_public_envelope`] performs
//! bounded, network-free shape checks. [`validate_public_envelope`] then
//! resolves only events already stored in the request's community. Neither
//! path downloads external Block data or executes a Block action.

use buzz_core::kind::{
    event_kind_u32, KIND_BLOCK_ACTION, KIND_BLOCK_CATALOG_ENTRY, KIND_BLOCK_MANIFEST,
    KIND_BLOCK_RECEIPT, KIND_STREAM_MESSAGE,
};
use buzz_core::tenant::TenantContext;
use nostr::Event;
use serde_json::Value;
use uuid::Uuid;

use crate::state::AppState;

const INLINE_DATA_MAX_BYTES: usize = 32 * 1024;
const EXTERNAL_DATA_MAX_BYTES: u64 = 2 * 1024 * 1024;
const ACTION_CONTENT_MAX_BYTES: usize = 32 * 1024;
const RECEIPT_CONTENT_MAX_BYTES: usize = 32 * 1024;
const MANIFEST_CONTENT_MAX_BYTES: usize = 256 * 1024;

/// A validated Block event and the references needed by ingest.
#[derive(Debug)]
pub(crate) enum ValidatedBlockEvent {
    /// Immutable Block manifest.
    Manifest(ManifestEnvelope),
    /// Relay-authored catalog head.
    Catalog(CatalogEnvelope),
    /// Kind:9 Block instance.
    Instance(InstanceEnvelope),
    /// Signed Block action.
    Action(ActionEnvelope),
    /// Auditable Block receipt.
    Receipt(ReceiptEnvelope),
}

/// Public fields pinned by an immutable manifest event.
#[derive(Debug)]
pub(crate) struct ManifestEnvelope {
    pub(crate) handle: String,
    pub(crate) content: Value,
}

/// Public fields pinned by a catalog-head event.
#[derive(Debug)]
pub(crate) struct CatalogEnvelope {
    pub(crate) handle: String,
    pub(crate) manifest_event_id: Vec<u8>,
    pub(crate) state: String,
}

/// Inline or content-addressed instance data.
#[derive(Debug)]
pub(crate) enum InstanceData {
    Inline(Value),
    External,
}

/// Public fields pinned by a Block instance.
#[derive(Debug)]
pub(crate) struct InstanceEnvelope {
    pub(crate) channel_id: Uuid,
    pub(crate) handle: String,
    pub(crate) manifest_event_id: Vec<u8>,
    pub(crate) instance_id: Uuid,
    pub(crate) data: InstanceData,
    pub(crate) processor_pubkey: Option<Vec<u8>>,
    pub(crate) attention_pubkey: Option<Vec<u8>>,
}

/// Public fields pinned by a Block action.
#[derive(Debug)]
pub(crate) struct ActionEnvelope {
    pub(crate) channel_id: Uuid,
    pub(crate) processor_pubkey: Vec<u8>,
    pub(crate) instance_event_id: Vec<u8>,
    pub(crate) manifest_event_id: Vec<u8>,
    pub(crate) action_id: String,
    pub(crate) instance_id: Uuid,
    pub(crate) idempotency_key: Uuid,
    pub(crate) content: Value,
}

/// Public fields pinned by a Block receipt.
#[derive(Debug)]
pub(crate) struct ReceiptEnvelope {
    pub(crate) channel_id: Uuid,
    pub(crate) action_event_id: Vec<u8>,
    pub(crate) instance_event_id: Vec<u8>,
    pub(crate) instance_id: Uuid,
    pub(crate) idempotency_key: Uuid,
    pub(crate) status: ReceiptStatus,
    pub(crate) resolves_attention: bool,
}

/// Closed receipt states shared with `buzz_sdk::blocks::BlockReceiptStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReceiptStatus {
    /// Processing completed successfully.
    Succeeded,
    /// The decision maker explicitly denied the operation.
    Denied,
    /// Processing failed.
    Failed,
    /// Processing exceeded its execution window.
    TimedOut,
}

impl ReceiptStatus {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "succeeded" => Ok(Self::Succeeded),
            "denied" => Ok(Self::Denied),
            "failed" => Ok(Self::Failed),
            "timed-out" => Ok(Self::TimedOut),
            _ => Err("Block receipt status is invalid".into()),
        }
    }

    fn can_resolve_attention(self) -> bool {
        matches!(self, Self::Succeeded | Self::Denied)
    }
}

fn tags_named(event: &Event, name: &str) -> Vec<Vec<String>> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts.first().is_some_and(|part| part == name))
                .then(|| parts.iter().map(ToString::to_string).collect())
        })
        .collect()
}

fn exact_tag(event: &Event, name: &str) -> Result<Vec<String>, String> {
    let tags = tags_named(event, name);
    if tags.len() != 1 {
        return Err(format!(
            "Block event must include exactly one `{name}` tag (got {})",
            tags.len()
        ));
    }
    tags.into_iter()
        .next()
        .ok_or_else(|| format!("Block event is missing its `{name}` tag"))
}

fn exact_channel(event: &Event) -> Result<Uuid, String> {
    let tag = exact_tag(event, "h")?;
    if tag.len() != 2 {
        return Err("Block `h` tag must have exactly two fields".into());
    }
    Uuid::parse_str(&tag[1]).map_err(|_| "Block `h` tag must contain a UUID".into())
}

fn lowercase_event_id(raw: &str, field: &str) -> Result<Vec<u8>, String> {
    if raw.len() != 64
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{field} must be 64 lowercase hexadecimal characters"
        ));
    }
    hex::decode(raw).map_err(|_| format!("{field} must be valid hexadecimal"))
}

fn optional_pubkey(event: &Event) -> Result<Option<Vec<u8>>, String> {
    let tags = tags_named(event, "p");
    if tags.len() > 1 {
        return Err(format!(
            "Block event must include at most one `p` tag (got {})",
            tags.len()
        ));
    }
    let Some(tag) = tags.first() else {
        return Ok(None);
    };
    if tag.len() != 2 {
        return Err("Block processor/decision-maker `p` tag must have exactly two fields".into());
    }
    lowercase_event_id(&tag[1], "Block `p` tag").map(Some)
}

fn exact_pubkey(event: &Event) -> Result<Vec<u8>, String> {
    optional_pubkey(event)?
        .ok_or_else(|| "Block event must include exactly one processor `p` tag".into())
}

fn optional_instance_processor(event: &Event) -> Result<Option<Vec<u8>>, String> {
    let tags = tags_named(event, "block-processor");
    if tags.len() > 1 {
        return Err(format!(
            "Block instance must include at most one `block-processor` tag (got {})",
            tags.len()
        ));
    }
    let Some(tag) = tags.first() else {
        return Ok(None);
    };
    if tag.len() != 3 || tag[1] != "1" {
        return Err("Block processor tag must be `[\"block-processor\",\"1\",pubkey]`".into());
    }
    lowercase_event_id(&tag[2], "Block processor pubkey").map(Some)
}

fn exact_event_reference(
    event: &Event,
    expected_id: &str,
    marker: &str,
) -> Result<Vec<u8>, String> {
    let candidates = tags_named(event, "e")
        .into_iter()
        .filter(|tag| {
            tag.get(1).is_some_and(|value| value == expected_id)
                || tag.get(3).is_some_and(|value| value == marker)
        })
        .collect::<Vec<_>>();

    if candidates.len() != 1 {
        return Err(format!(
            "Block event must include exactly one `{marker}` event reference"
        ));
    }
    let tag = &candidates[0];
    if tag.len() != 4 || tag[1] != expected_id || !tag[2].is_empty() || tag[3] != marker {
        return Err(format!(
            "Block `{marker}` event reference has an invalid marker or shape"
        ));
    }
    lowercase_event_id(expected_id, &format!("Block `{marker}` event ID"))
}

fn valid_handle(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn valid_semver(raw: &str) -> bool {
    let core = raw.split_once('-').map_or(raw, |(core, _)| core);
    let mut parts = core.split('.');
    let valid_number = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'))
    };
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(major), Some(minor), Some(patch), None)
            if valid_number(major) && valid_number(minor) && valid_number(patch)
    )
}

fn parse_json_object(content: &str, label: &str, max_bytes: usize) -> Result<Value, String> {
    if content.len() > max_bytes {
        return Err(format!("{label} exceeds maximum size of {max_bytes} bytes"));
    }
    let value: Value =
        serde_json::from_str(content).map_err(|error| format!("{label} must be JSON: {error}"))?;
    if !value.is_object() {
        return Err(format!("{label} must be a JSON object"));
    }
    let canonical = buzz_core::block::canonical_json(&value)
        .map_err(|error| format!("{label} could not be canonicalized: {error}"))?;
    if canonical != content {
        return Err(format!("{label} must use canonical JSON"));
    }
    Ok(value)
}

fn value_string<'a>(value: &'a Value, field: &str, label: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label} must include string field `{field}`"))
}

fn contains_secret_field(value: &Value) -> bool {
    const SECRET_FRAGMENTS: &[&str] = &[
        "privatekey",
        "secretkey",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "password",
        "credential",
        "envvars",
        "backendconfig",
        "providerconfig",
    ];

    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            let normalized = key
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            SECRET_FRAGMENTS
                .iter()
                .any(|fragment| normalized.contains(fragment))
                || contains_secret_field(value)
        }),
        Value::Array(values) => values.iter().any(contains_secret_field),
        _ => false,
    }
}

fn parse_manifest(event: &Event) -> Result<ManifestEnvelope, String> {
    if !tags_named(event, "h").is_empty() {
        return Err("Block manifests are global and must not include an `h` tag".into());
    }
    let block = exact_tag(event, "block")?;
    if block.len() != 4 || block[1] != "1" {
        return Err("Block manifest tag must be `[\"block\",\"1\",handle,version]`".into());
    }
    if !valid_handle(&block[2]) {
        return Err("Block manifest handle is invalid".into());
    }
    if !valid_semver(&block[3]) {
        return Err("Block manifest version must be semantic versioning".into());
    }

    let content = parse_json_object(
        &event.content,
        "Block manifest content",
        MANIFEST_CONTENT_MAX_BYTES,
    )?;
    if value_string(&content, "handle", "Block manifest")? != block[2] {
        return Err("Block manifest content handle does not match its tag".into());
    }
    if value_string(&content, "version", "Block manifest")? != block[3] {
        return Err("Block manifest content version does not match its tag".into());
    }

    let manifest = buzz_core::block::parse_manifest(&event.content)
        .map_err(|error| format!("invalid Block manifest: {error}"))?;
    buzz_core::block::validate_manifest(&manifest)
        .map_err(|error| format!("invalid Block manifest: {error}"))?;

    Ok(ManifestEnvelope {
        handle: block[2].clone(),
        content,
    })
}

fn parse_catalog(event: &Event) -> Result<CatalogEnvelope, String> {
    if !tags_named(event, "h").is_empty() {
        return Err("Block catalog heads are global and must not include an `h` tag".into());
    }
    let d_tag = exact_tag(event, "d")?;
    if d_tag.len() != 2 || !valid_handle(&d_tag[1]) {
        return Err("Block catalog `d` tag must contain one valid handle".into());
    }
    let state_tag = exact_tag(event, "block-state")?;
    if state_tag.len() != 2 || !matches!(state_tag[1].as_str(), "active" | "deprecated") {
        return Err("Block catalog state must be `active` or `deprecated`".into());
    }
    let manifest_reference = exact_tag(event, "e")?;
    if manifest_reference.len() != 4
        || !manifest_reference[2].is_empty()
        || manifest_reference[3] != "block-manifest"
    {
        return Err("Block catalog manifest reference has an invalid marker or shape".into());
    }
    let manifest_event_id =
        lowercase_event_id(&manifest_reference[1], "Block catalog manifest event ID")?;

    let content = parse_json_object(
        &event.content,
        "Block catalog content",
        MANIFEST_CONTENT_MAX_BYTES,
    )?;
    if value_string(&content, "handle", "Block catalog")? != d_tag[1] {
        return Err("Block catalog content handle does not match its `d` tag".into());
    }
    if value_string(&content, "active_manifest_id", "Block catalog")? != manifest_reference[1] {
        return Err("Block catalog content manifest does not match its event reference".into());
    }
    if value_string(&content, "status", "Block catalog")? != state_tag[1] {
        return Err("Block catalog content status does not match its state tag".into());
    }

    Ok(CatalogEnvelope {
        handle: d_tag[1].clone(),
        manifest_event_id,
        state: state_tag[1].clone(),
    })
}

fn parse_instance_data(event: &Event) -> Result<InstanceData, String> {
    let inline = tags_named(event, "block-data");
    let external = tags_named(event, "block-data-ref");
    if inline.len() + external.len() != 1 {
        return Err("Block instance must include exactly one data tag".into());
    }

    if let Some(tag) = inline.first() {
        if tag.len() != 2 {
            return Err("Block inline data tag must have exactly two fields".into());
        }
        if tag[1].len() > INLINE_DATA_MAX_BYTES {
            return Err(format!(
                "Block inline data exceeds maximum size of {INLINE_DATA_MAX_BYTES} bytes"
            ));
        }
        let value = serde_json::from_str(&tag[1])
            .map_err(|error| format!("Block inline data must be JSON: {error}"))?;
        let canonical = buzz_core::block::canonical_json(&value)
            .map_err(|error| format!("Block inline data could not be canonicalized: {error}"))?;
        if canonical != tag[1] {
            return Err("Block inline data must use canonical JSON".into());
        }
        return Ok(InstanceData::Inline(value));
    }

    let tag = &external[0];
    if tag.len() != 5 {
        return Err("Block external data tag must have exactly five fields".into());
    }
    let parsed_url =
        url::Url::parse(&tag[1]).map_err(|_| "Block external data URL is invalid".to_string())?;
    if parsed_url.scheme() != "https" || parsed_url.host_str().is_none() {
        return Err("Block external data URL must use HTTPS and include a host".into());
    }
    if tag[2] != "application/json" {
        return Err("Block external data MIME must be `application/json`".into());
    }
    lowercase_event_id(&tag[3], "Block external data SHA-256")?;
    let byte_size = tag[4]
        .parse::<u64>()
        .map_err(|_| "Block external data byte size must be an integer".to_string())?;
    if byte_size == 0 || byte_size > EXTERNAL_DATA_MAX_BYTES {
        return Err(format!(
            "Block external data byte size must be between 1 and {EXTERNAL_DATA_MAX_BYTES}"
        ));
    }

    Ok(InstanceData::External)
}

fn parse_attention(event: &Event, required_state: &str) -> Result<bool, String> {
    let tags = tags_named(event, "block-attention");
    if tags.is_empty() {
        return Ok(false);
    }
    if tags.len() != 1
        || tags[0].len() != 3
        || tags[0][0] != "block-attention"
        || tags[0][1] != "1"
        || tags[0][2] != required_state
    {
        return Err(format!(
            "Block attention tag must be exactly `[\"block-attention\",\"1\",\"{required_state}\"]`"
        ));
    }
    Ok(true)
}

fn parse_instance(event: &Event) -> Result<InstanceEnvelope, String> {
    let channel_id = exact_channel(event)?;
    let block = exact_tag(event, "block")?;
    if block.len() != 5 || block[1] != "1" {
        return Err(
            "Block instance tag must be `[\"block\",\"1\",handle,manifest_id,instance_id]`".into(),
        );
    }
    if !valid_handle(&block[2]) {
        return Err("Block instance handle is invalid".into());
    }
    let manifest_event_id = exact_event_reference(event, &block[3], "block")?;
    let instance_id =
        Uuid::parse_str(&block[4]).map_err(|_| "Block instance ID must be a UUID".to_string())?;
    let data = parse_instance_data(event)?;
    let audience_pubkey = optional_pubkey(event)?;
    let explicit_processor = optional_instance_processor(event)?;
    let requires_attention = parse_attention(event, "required")?;
    let attention_pubkey = if requires_attention {
        Some(
            audience_pubkey
                .clone()
                .ok_or("Block attention requires exactly one decision-maker `p` tag")?,
        )
    } else {
        None
    };
    let processor_pubkey = explicit_processor.or_else(|| audience_pubkey.clone());

    Ok(InstanceEnvelope {
        channel_id,
        handle: block[2].clone(),
        manifest_event_id,
        instance_id,
        data,
        processor_pubkey,
        attention_pubkey,
    })
}

fn valid_action_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 128
        && raw.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
}

fn parse_action(event: &Event) -> Result<ActionEnvelope, String> {
    let channel_id = exact_channel(event)?;
    let processor_pubkey = exact_pubkey(event)?;
    let action = exact_tag(event, "block-action")?;
    if action.len() != 5 || action[1] != "1" {
        return Err("Block action tag has an invalid version or shape".into());
    }
    if !valid_action_id(&action[2]) {
        return Err("Block action ID is invalid".into());
    }
    let instance_id =
        Uuid::parse_str(&action[3]).map_err(|_| "Block action instance ID must be a UUID")?;
    let idempotency_key =
        Uuid::parse_str(&action[4]).map_err(|_| "Block action idempotency key must be a UUID")?;

    let instance_candidates = tags_named(event, "e")
        .into_iter()
        .filter(|tag| tag.get(3).is_some_and(|marker| marker == "block-instance"))
        .collect::<Vec<_>>();
    if instance_candidates.len() != 1 {
        return Err("Block action must include exactly one `block-instance` reference".into());
    }
    let instance_tag = &instance_candidates[0];
    if instance_tag.len() != 4 || !instance_tag[2].is_empty() {
        return Err("Block action instance reference has an invalid marker or shape".into());
    }
    let instance_event_id = lowercase_event_id(&instance_tag[1], "Block action instance event ID")?;

    let manifest_candidates = tags_named(event, "e")
        .into_iter()
        .filter(|tag| tag.get(3).is_some_and(|marker| marker == "block-manifest"))
        .collect::<Vec<_>>();
    if manifest_candidates.len() != 1 {
        return Err("Block action must include exactly one `block-manifest` reference".into());
    }
    let manifest_tag = &manifest_candidates[0];
    if manifest_tag.len() != 4 || !manifest_tag[2].is_empty() {
        return Err("Block action manifest reference has an invalid marker or shape".into());
    }
    let manifest_event_id = lowercase_event_id(&manifest_tag[1], "Block action manifest event ID")?;

    let content = parse_json_object(
        &event.content,
        "Block action content",
        ACTION_CONTENT_MAX_BYTES,
    )?;
    if contains_secret_field(&content) {
        return Err("Block action content contains a secret-bearing field".into());
    }

    Ok(ActionEnvelope {
        channel_id,
        processor_pubkey,
        instance_event_id,
        manifest_event_id,
        action_id: action[2].clone(),
        instance_id,
        idempotency_key,
        content,
    })
}

fn parse_receipt(event: &Event) -> Result<ReceiptEnvelope, String> {
    let channel_id = exact_channel(event)?;
    let receipt = exact_tag(event, "block-receipt")?;
    if receipt.len() != 5 || receipt[1] != "1" {
        return Err("Block receipt tag has an invalid version or shape".into());
    }
    let instance_id =
        Uuid::parse_str(&receipt[2]).map_err(|_| "Block receipt instance ID must be a UUID")?;
    let idempotency_key =
        Uuid::parse_str(&receipt[3]).map_err(|_| "Block receipt idempotency key must be a UUID")?;
    let status = ReceiptStatus::parse(&receipt[4])?;

    let action_candidates = tags_named(event, "e")
        .into_iter()
        .filter(|tag| tag.get(3).is_some_and(|marker| marker == "block-action"))
        .collect::<Vec<_>>();
    if action_candidates.len() != 1 {
        return Err("Block receipt must reference exactly one Block action".into());
    }
    let action_tag = &action_candidates[0];
    if action_tag.len() != 4 || !action_tag[2].is_empty() {
        return Err("Block receipt action reference has an invalid marker or shape".into());
    }
    let action_event_id = lowercase_event_id(&action_tag[1], "Block receipt action event ID")?;

    let instance_candidates = tags_named(event, "e")
        .into_iter()
        .filter(|tag| tag.get(3).is_some_and(|marker| marker == "block-instance"))
        .collect::<Vec<_>>();
    if instance_candidates.len() != 1 {
        return Err("Block receipt must reference exactly one Block instance".into());
    }
    let instance_tag = &instance_candidates[0];
    if instance_tag.len() != 4 || !instance_tag[2].is_empty() {
        return Err("Block receipt instance reference has an invalid marker or shape".into());
    }
    let instance_event_id =
        lowercase_event_id(&instance_tag[1], "Block receipt instance event ID")?;
    let resolves_attention = parse_attention(event, "resolved")?;
    if resolves_attention && !status.can_resolve_attention() {
        return Err("failed or timed-out receipts cannot resolve Block attention".into());
    }

    let content = parse_json_object(
        &event.content,
        "Block receipt content",
        RECEIPT_CONTENT_MAX_BYTES,
    )?;
    if contains_secret_field(&content) {
        return Err("Block receipt content contains a secret-bearing field".into());
    }

    Ok(ReceiptEnvelope {
        channel_id,
        action_event_id,
        instance_event_id,
        instance_id,
        idempotency_key,
        status,
        resolves_attention,
    })
}

/// Parse the bounded public envelope for a Block event.
///
/// Ordinary kind:9 messages return `Ok(None)`. A kind:9 message carrying any
/// Block tag is treated as a Block attempt and fails closed if malformed.
pub(crate) fn parse_public_envelope(event: &Event) -> Result<Option<ValidatedBlockEvent>, String> {
    let kind = event_kind_u32(event);
    match kind {
        KIND_BLOCK_MANIFEST => parse_manifest(event)
            .map(ValidatedBlockEvent::Manifest)
            .map(Some),
        KIND_BLOCK_CATALOG_ENTRY => parse_catalog(event)
            .map(ValidatedBlockEvent::Catalog)
            .map(Some),
        KIND_BLOCK_ACTION => parse_action(event)
            .map(ValidatedBlockEvent::Action)
            .map(Some),
        KIND_BLOCK_RECEIPT => parse_receipt(event)
            .map(ValidatedBlockEvent::Receipt)
            .map(Some),
        KIND_STREAM_MESSAGE => {
            let has_block_shape = [
                "block",
                "block-data",
                "block-data-ref",
                "block-attention",
                "block-processor",
            ]
            .iter()
            .any(|name| !tags_named(event, name).is_empty())
                || tags_named(event, "e").iter().any(|tag| {
                    tag.get(3)
                        .is_some_and(|marker| marker == "block" || marker.starts_with("block-"))
                });
            if has_block_shape {
                parse_instance(event)
                    .map(ValidatedBlockEvent::Instance)
                    .map(Some)
            } else {
                Ok(None)
            }
        }
        _ => Ok(None),
    }
}

fn manifest_action<'a>(manifest: &'a ManifestEnvelope, action_id: &str) -> Option<&'a Value> {
    manifest
        .content
        .get("actions")
        .and_then(Value::as_array)?
        .iter()
        .find(|action| action.get("id").and_then(Value::as_str) == Some(action_id))
}

fn action_resolves_attention(action: &Value) -> bool {
    action
        .get("resolves_attention")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || action
            .get("interaction")
            .and_then(|interaction| interaction.get("resolves_attention"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn manifest_has_resolving_action(manifest: &ManifestEnvelope) -> bool {
    manifest
        .content
        .get("actions")
        .and_then(Value::as_array)
        .is_some_and(|actions| actions.iter().any(action_resolves_attention))
}

fn manifest_has_signed_action(manifest: &ManifestEnvelope) -> bool {
    manifest
        .content
        .get("actions")
        .and_then(Value::as_array)
        .is_some_and(|actions| {
            actions.iter().any(|action| {
                action
                    .get("interaction")
                    .and_then(|interaction| interaction.get("type"))
                    .and_then(Value::as_str)
                    == Some("signed")
            })
        })
}

fn validate_instance_processor_contract(
    manifest: &ManifestEnvelope,
    instance: &InstanceEnvelope,
) -> Result<(), String> {
    if manifest_has_signed_action(manifest) && instance.processor_pubkey.is_none() {
        return Err(
            "Block instances with signed actions require exactly one processor `p` tag".into(),
        );
    }
    if instance.attention_pubkey.is_some() && instance.processor_pubkey.is_none() {
        return Err("Block attention requires a pinned instance processor".into());
    }
    Ok(())
}

fn validate_action_authority(
    action_signer: &[u8],
    action: &ActionEnvelope,
    instance: &InstanceEnvelope,
) -> Result<(), String> {
    if instance.channel_id != action.channel_id {
        return Err("Block action target belongs to a different channel".into());
    }
    if instance.instance_id != action.instance_id
        || instance.manifest_event_id != action.manifest_event_id
    {
        return Err("Block action does not match its pinned instance".into());
    }
    let processor = instance
        .processor_pubkey
        .as_deref()
        .ok_or_else(|| "Block action target has no pinned processor".to_string())?;
    if action.processor_pubkey.as_slice() != processor {
        return Err("Block action redirects the pinned instance processor".into());
    }
    if let Some(decision_maker) = &instance.attention_pubkey {
        if action_signer != decision_maker {
            return Err("Block attention action must be signed by its decision maker".into());
        }
    }
    Ok(())
}

fn validate_receipt_authority(
    receipt_signer: &[u8],
    action_signer: &[u8],
    action: &ActionEnvelope,
    instance: &InstanceEnvelope,
) -> Result<(), String> {
    validate_action_authority(action_signer, action, instance)?;
    if receipt_signer != action.processor_pubkey {
        return Err("Block receipt signer is not the pinned instance processor".into());
    }
    Ok(())
}

fn manifest_is_tested(manifest: &ManifestEnvelope) -> bool {
    manifest
        .content
        .pointer("/validation/state")
        .and_then(Value::as_str)
        == Some("tested")
}

async fn stored_manifest(
    tenant: &TenantContext,
    state: &AppState,
    event_id: &[u8],
) -> Result<ManifestEnvelope, String> {
    let stored = state
        .db
        .get_event_by_id(tenant.community(), event_id)
        .await
        .map_err(|error| format!("database error loading Block manifest: {error}"))?
        .ok_or_else(|| "referenced Block manifest was not found".to_string())?;
    if stored.channel_id.is_some() || event_kind_u32(&stored.event) != KIND_BLOCK_MANIFEST {
        return Err("referenced Block manifest has the wrong kind or scope".into());
    }
    match parse_public_envelope(&stored.event)? {
        Some(ValidatedBlockEvent::Manifest(manifest)) => Ok(manifest),
        _ => Err("referenced Block manifest is malformed".into()),
    }
}

async fn stored_instance(
    tenant: &TenantContext,
    state: &AppState,
    event_id: &[u8],
) -> Result<InstanceEnvelope, String> {
    let stored = state
        .db
        .get_event_by_id(tenant.community(), event_id)
        .await
        .map_err(|error| format!("database error loading Block instance: {error}"))?
        .ok_or_else(|| "referenced Block instance was not found".to_string())?;
    match parse_public_envelope(&stored.event)? {
        Some(ValidatedBlockEvent::Instance(instance)) => Ok(instance),
        _ => Err("referenced event is not a valid Block instance".into()),
    }
}

async fn stored_action(
    tenant: &TenantContext,
    state: &AppState,
    event_id: &[u8],
) -> Result<(Event, ActionEnvelope), String> {
    let stored = state
        .db
        .get_event_by_id(tenant.community(), event_id)
        .await
        .map_err(|error| format!("database error loading Block action: {error}"))?
        .ok_or_else(|| "referenced Block action was not found".to_string())?;
    let envelope = match parse_public_envelope(&stored.event)? {
        Some(ValidatedBlockEvent::Action(action)) => action,
        _ => return Err("referenced event is not a valid Block action".into()),
    };
    Ok((stored.event, envelope))
}

/// Verify exact, same-community Approval Block evidence submitted by an owned agent.
pub(crate) async fn validate_discovery_budget_approval(
    tenant: &TenantContext,
    state: &AppState,
    submitting_actor: &[u8; 32],
    approval: &buzz_core::discovery_workspace::DiscoveryCampaignBudgetApproval,
) -> Result<Option<[u8; 32]>, String> {
    let Some(action_event_id) = approval.approval_action_event_id.as_deref() else {
        return Ok(None);
    };
    let event_id = lowercase_event_id(action_event_id, "Discovery approval action event ID")?;
    let (action_event, action) = stored_action(tenant, state, &event_id).await?;
    validate_public_envelope(tenant, state, &action_event).await?;
    if action.action_id != "approval.approve" {
        return Err("Discovery budget evidence is not an Approval approval".into());
    }
    if action.processor_pubkey.as_slice() != submitting_actor {
        return Err("Discovery budget approval is pinned to a different agent".into());
    }
    let payer = approval.payer_pubkey.to_bytes();
    if action_event.pubkey.to_bytes() != payer {
        return Err("Discovery budget approval signer is not the named payer".into());
    }
    let owned = state
        .db
        .is_agent_owner(tenant.community(), submitting_actor, &payer)
        .await
        .map_err(|error| format!("database error checking Discovery agent owner: {error}"))?;
    if !owned {
        return Err("Discovery budget approval was not submitted by the payer's agent".into());
    }

    let stored = state
        .db
        .get_event_by_id(tenant.community(), &action.instance_event_id)
        .await
        .map_err(|error| format!("database error loading Approval instance: {error}"))?
        .ok_or_else(|| "Discovery Approval instance was not found".to_string())?;
    if stored.event.pubkey.to_bytes() != *submitting_actor {
        return Err("Discovery Approval instance was not created by the submitting agent".into());
    }
    let instance = match parse_public_envelope(&stored.event)? {
        Some(ValidatedBlockEvent::Instance(instance)) => instance,
        _ => return Err("Discovery approval target is not a valid Block instance".into()),
    };
    if instance.handle != "approval"
        || instance.processor_pubkey.as_deref() != Some(submitting_actor.as_slice())
        || instance.attention_pubkey.as_deref() != Some(payer.as_slice())
    {
        return Err("Discovery budget evidence is not the payer's Approval Block".into());
    }
    let manifest = stored_manifest(tenant, state, &instance.manifest_event_id).await?;
    if manifest.handle != "approval"
        || !manifest_is_trusted_active(tenant, state, &manifest, &instance.manifest_event_id)
            .await?
    {
        return Err("Discovery budget evidence does not use the active Approval manifest".into());
    }
    let InstanceData::Inline(data) = instance.data else {
        return Err("Discovery budget Approval data must be inline".into());
    };
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ApprovalInstance {
        action: String,
        destination: String,
        content: String,
        expires_at: u64,
        status: String,
    }
    let instance = serde_json::from_value::<ApprovalInstance>(data)
        .map_err(|_| "Discovery budget Approval data is malformed".to_string())?;
    if instance.status != "pending" {
        return Err("Discovery budget Approval was not pending when presented".into());
    }
    let current = buzz_core::block::ApprovalProposal {
        action: instance.action,
        destination: instance.destination,
        content: Value::String(instance.content),
        expires_at: instance.expires_at,
    };
    let expected = approval
        .approval_proposal()
        .map_err(|error| error.to_string())?;
    validate_discovery_budget_approval_values(
        &current,
        &expected,
        &action.content,
        u64::try_from(chrono::Utc::now().timestamp())
            .map_err(|_| "current time is invalid".to_string())?,
    )?;
    Ok(Some(payer))
}

fn validate_discovery_budget_approval_values(
    current: &buzz_core::block::ApprovalProposal,
    expected: &buzz_core::block::ApprovalProposal,
    action_content: &Value,
    now: u64,
) -> Result<(), String> {
    if current != expected {
        return Err("Discovery budget Approval does not match the exact Campaign budget".into());
    }
    if current.expires_at <= now {
        return Err("Discovery budget Approval has expired".into());
    }
    let expected_hash = buzz_core::block::compute_approval_hash(current)
        .map_err(|error| format!("Discovery approval hash failed: {error}"))?;
    if action_content.get("approval_hash").and_then(Value::as_str) != Some(&expected_hash) {
        return Err("Discovery budget Approval hash does not match".into());
    }
    Ok(())
}

async fn manifest_is_trusted_active(
    tenant: &TenantContext,
    state: &AppState,
    manifest: &ManifestEnvelope,
    manifest_event_id: &[u8],
) -> Result<bool, String> {
    let entries = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_BLOCK_CATALOG_ENTRY as i32]),
            pubkey: Some(state.relay_keypair.public_key().to_bytes().to_vec()),
            d_tag: Some(manifest.handle.clone()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error loading Block catalog head: {error}"))?;

    let Some(head) = entries.first() else {
        return Ok(false);
    };
    let catalog = match parse_public_envelope(&head.event)? {
        Some(ValidatedBlockEvent::Catalog(catalog)) => catalog,
        _ => return Ok(false),
    };
    Ok(catalog.state == "active" && catalog.manifest_event_id == manifest_event_id)
}

async fn validate_instance_against_manifest(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
    instance: &InstanceEnvelope,
) -> Result<ManifestEnvelope, String> {
    let manifest = stored_manifest(tenant, state, &instance.manifest_event_id).await?;
    if manifest.handle != instance.handle {
        return Err("Block instance handle does not match its pinned manifest".into());
    }
    if let InstanceData::Inline(data) = &instance.data {
        let typed_manifest =
            serde_json::from_value::<buzz_core::block::BlockManifest>(manifest.content.clone())
                .map_err(|error| format!("stored Block manifest is malformed: {error}"))?;
        buzz_core::block::validate_manifest_instance(&typed_manifest, data)
            .map_err(|error| format!("Block instance data does not match its manifest: {error}"))?;
    }
    validate_instance_processor_contract(&manifest, instance)?;

    if let Some(owner_pubkey) = &instance.attention_pubkey {
        if !manifest_has_resolving_action(&manifest) {
            return Err("Block attention requires a manifest-declared resolving action".into());
        }
        if !manifest_is_trusted_active(tenant, state, &manifest, &instance.manifest_event_id)
            .await?
        {
            return Err("Block attention requires an active trusted manifest".into());
        }

        if instance.handle == "agent-proposal" {
            let agent_pubkey = event.pubkey.to_bytes().to_vec();
            let owned = state
                .db
                .is_agent_owner(tenant.community(), &agent_pubkey, owner_pubkey)
                .await
                .map_err(|error| {
                    format!("database error checking Agent Proposal owner: {error}")
                })?;
            if !owned {
                return Err(
                    "actionable Agent Proposals must be signed by the decision maker's owned agent"
                        .into(),
                );
            }
            let (agent_member, owner_member) = tokio::join!(
                state
                    .db
                    .is_member(tenant.community(), instance.channel_id, &agent_pubkey),
                state
                    .db
                    .is_member(tenant.community(), instance.channel_id, owner_pubkey),
            );
            if !agent_member
                .map_err(|error| format!("database error checking agent membership: {error}"))?
                || !owner_member
                    .map_err(|error| format!("database error checking owner membership: {error}"))?
            {
                return Err(
                    "Agent Proposal signer and decision maker must both belong to the channel"
                        .into(),
                );
            }
        }
    }

    Ok(manifest)
}

/// Validate a Block event against same-community, already-stored references.
pub(crate) async fn validate_public_envelope(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
) -> Result<Option<ValidatedBlockEvent>, String> {
    let Some(envelope) = parse_public_envelope(event)? else {
        return Ok(None);
    };

    match &envelope {
        ValidatedBlockEvent::Manifest(_) => {}
        ValidatedBlockEvent::Catalog(catalog) => {
            if event.pubkey != state.relay_keypair.public_key() {
                return Err("Block catalog heads are relay-authored only".into());
            }
            let manifest = stored_manifest(tenant, state, &catalog.manifest_event_id).await?;
            if manifest.handle != catalog.handle {
                return Err("Block catalog handle does not match its target manifest".into());
            }
            if !manifest_is_tested(&manifest) {
                return Err("Block catalog target manifest has not passed testing".into());
            }
        }
        ValidatedBlockEvent::Instance(instance) => {
            validate_instance_against_manifest(tenant, state, event, instance).await?;
        }
        ValidatedBlockEvent::Action(action) => {
            if crate::block_broker::is_catalog_action(&action.action_id) {
                return Err(
                    "reserved catalog actions must use the global relay-broker envelope".into(),
                );
            }
            let instance = stored_instance(tenant, state, &action.instance_event_id).await?;
            validate_action_authority(event.pubkey.as_bytes(), action, &instance)?;
            let manifest = stored_manifest(tenant, state, &action.manifest_event_id).await?;
            let declaration = manifest_action(&manifest, &action.action_id)
                .ok_or_else(|| "Block action ID is not declared by its manifest".to_string())?;
            if let Some(schema) = declaration
                .get("input_schema")
                .or_else(|| declaration.get("schema"))
            {
                buzz_core::block::validate_instance(schema, &action.content).map_err(|error| {
                    format!("Block action input does not match its declaration: {error}")
                })?;
            }
        }
        ValidatedBlockEvent::Receipt(receipt) => {
            let (action_event, action) =
                stored_action(tenant, state, &receipt.action_event_id).await?;
            if action.channel_id != receipt.channel_id
                || action.instance_event_id != receipt.instance_event_id
                || action.instance_id != receipt.instance_id
                || action.idempotency_key != receipt.idempotency_key
            {
                return Err("Block receipt does not match its referenced action".into());
            }
            if action_event.id.as_bytes().as_slice() != receipt.action_event_id {
                return Err("Block receipt action reference does not resolve exactly".into());
            }
            let instance = stored_instance(tenant, state, &receipt.instance_event_id).await?;
            if instance.channel_id != receipt.channel_id
                || instance.instance_id != receipt.instance_id
            {
                return Err("Block receipt target belongs to a different channel".into());
            }
            validate_receipt_authority(
                event.pubkey.as_bytes(),
                action_event.pubkey.as_bytes(),
                &action,
                &instance,
            )?;
            if receipt.resolves_attention {
                if instance.attention_pubkey.is_none() {
                    return Err(
                        "resolving receipt targets a Block that does not require attention".into(),
                    );
                }
                let manifest = stored_manifest(tenant, state, &instance.manifest_event_id).await?;
                let declaration =
                    manifest_action(&manifest, &action.action_id).ok_or_else(|| {
                        "Block receipt action is absent from its manifest".to_string()
                    })?;
                if !action_resolves_attention(declaration) {
                    return Err("Block receipt action is not declared to resolve attention".into());
                }
                if !receipt.status.can_resolve_attention() {
                    return Err("failed or timed-out receipts cannot resolve attention".into());
                }
            }
        }
    }

    Ok(Some(envelope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::block::BlockInteraction;
    use buzz_sdk::blocks::{build_block_receipt, BlockReceiptInput, BlockReceiptStatus};
    use nostr::{EventBuilder, EventId, Keys, Kind, Tag};

    fn tag(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).expect("valid test tag")
    }

    fn signed(kind: u16, tags: Vec<Tag>, content: &str) -> Event {
        EventBuilder::new(Kind::Custom(kind), content)
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .expect("sign test event")
    }

    fn manifest_id() -> String {
        "ab".repeat(32)
    }

    fn instance_tags() -> Vec<Tag> {
        let channel = Uuid::new_v4().to_string();
        let instance = Uuid::new_v4().to_string();
        let manifest = manifest_id();
        let processor = "12".repeat(32);
        vec![
            tag(&["h", &channel]),
            tag(&["e", &manifest, "", "block"]),
            tag(&["block", "1", "lead-card", &manifest, &instance]),
            tag(&["p", &processor]),
            tag(&["block-data", r#"{"name":"Acme"}"#]),
        ]
    }

    fn signed_action_manifest() -> ManifestEnvelope {
        ManifestEnvelope {
            handle: "test-card".to_owned(),
            content: serde_json::json!({
                "actions": [{
                    "id": "test.submit",
                    "interaction": {
                        "type": "signed",
                        "action_id": "test.submit",
                        "resolves_attention": true
                    }
                }]
            }),
        }
    }

    fn instance_envelope(
        processor_pubkey: Option<Vec<u8>>,
        attention_pubkey: Option<Vec<u8>>,
    ) -> InstanceEnvelope {
        InstanceEnvelope {
            channel_id: Uuid::new_v4(),
            handle: "test-card".to_owned(),
            manifest_event_id: vec![0xab; 32],
            instance_id: Uuid::new_v4(),
            data: InstanceData::Inline(serde_json::json!({})),
            processor_pubkey,
            attention_pubkey,
        }
    }

    fn action_envelope(instance: &InstanceEnvelope, processor_pubkey: Vec<u8>) -> ActionEnvelope {
        ActionEnvelope {
            channel_id: instance.channel_id,
            processor_pubkey,
            instance_event_id: vec![0xcd; 32],
            manifest_event_id: instance.manifest_event_id.clone(),
            action_id: "test.submit".to_owned(),
            instance_id: instance.instance_id,
            idempotency_key: Uuid::new_v4(),
            content: serde_json::json!({}),
        }
    }

    #[test]
    fn catalog_eligibility_requires_exact_tested_validation_state() {
        let tested = ManifestEnvelope {
            handle: "section".to_owned(),
            content: serde_json::json!({
                "validation": {
                    "state": "tested",
                    "requires_attention": false
                },
                "examples": [{"name": "preview", "data": {}}]
            }),
        };
        assert!(manifest_is_tested(&tested));

        let draft = ManifestEnvelope {
            handle: "section".to_owned(),
            content: serde_json::json!({
                "validation": {
                    "state": "draft",
                    "requires_attention": false
                },
                "examples": [{"name": "preview", "data": {}}]
            }),
        };
        assert!(!manifest_is_tested(&draft));

        let unmarked = ManifestEnvelope {
            handle: "section".to_owned(),
            content: serde_json::json!({
                "validation": {
                    "requires_attention": false
                },
                "examples": [{"name": "preview", "data": {}}]
            }),
        };
        assert!(!manifest_is_tested(&unmarked));
    }

    #[test]
    fn block_instance_rejects_missing_h() {
        let mut tags = instance_tags();
        tags.remove(0);
        let event = signed(9, tags, "fallback");
        assert!(parse_public_envelope(&event)
            .expect_err("missing h must fail")
            .contains("exactly one `h`"));
    }

    #[test]
    fn block_instance_rejects_duplicate_data_tags() {
        let mut tags = instance_tags();
        tags.push(tag(&["block-data", "{}"]));
        let event = signed(9, tags, "fallback");
        assert!(parse_public_envelope(&event)
            .expect_err("duplicate data must fail")
            .contains("exactly one data tag"));
    }

    #[test]
    fn block_instance_rejects_bad_manifest_marker() {
        let mut tags = instance_tags();
        let manifest = manifest_id();
        tags[1] = tag(&["e", &manifest, "", "reply"]);
        let event = signed(9, tags, "fallback");
        assert!(parse_public_envelope(&event)
            .expect_err("bad marker must fail")
            .contains("invalid marker"));
    }

    #[test]
    fn block_instance_rejects_oversized_inline_json() {
        let mut tags = instance_tags();
        let oversized = format!(r#"{{"value":"{}"}}"#, "x".repeat(INLINE_DATA_MAX_BYTES));
        tags[4] = tag(&["block-data", &oversized]);
        let event = signed(9, tags, "fallback");
        assert!(parse_public_envelope(&event)
            .expect_err("oversized inline data must fail")
            .contains("exceeds maximum"));
    }

    #[test]
    fn block_instance_external_data_requires_https() {
        let mut tags = instance_tags();
        tags[4] = tag(&[
            "block-data-ref",
            "http://cdn.example.com/block.json",
            "application/json",
            &"ab".repeat(32),
            "123",
        ]);
        let event = signed(9, tags, "fallback");
        assert!(parse_public_envelope(&event)
            .expect_err("insecure external data URL must fail")
            .contains("must use HTTPS"));
    }

    #[test]
    fn block_instance_separates_attention_owner_from_processor() {
        let mut tags = instance_tags();
        let decision_maker = "34".repeat(32);
        let processor = "56".repeat(32);
        tags[3] = tag(&["p", &decision_maker]);
        tags.insert(4, tag(&["block-processor", "1", &processor]));
        tags.insert(5, tag(&["block-attention", "1", "required"]));
        let event = signed(9, tags, "fallback");
        let parsed = parse_public_envelope(&event).expect("valid split-role instance");
        let Some(ValidatedBlockEvent::Instance(instance)) = parsed else {
            panic!("expected Block instance");
        };
        assert_eq!(
            instance.attention_pubkey,
            Some(hex::decode(decision_maker).expect("decision-maker hex"))
        );
        assert_eq!(
            instance.processor_pubkey,
            Some(hex::decode(processor).expect("processor hex"))
        );
    }

    #[test]
    fn signed_action_instance_requires_one_processor() {
        let manifest = signed_action_manifest();
        let missing = instance_envelope(None, None);
        assert!(validate_instance_processor_contract(&manifest, &missing)
            .expect_err("signed actions require a processor")
            .contains("exactly one processor"));

        let mut tags = instance_tags();
        tags.push(tag(&["p", &"34".repeat(32)]));
        let event = signed(9, tags, "fallback");
        assert!(parse_public_envelope(&event)
            .expect_err("duplicate processors must fail")
            .contains("at most one `p`"));
    }

    #[test]
    fn action_and_receipt_authority_stay_anchored_to_instance() {
        let user = [0x11; 32];
        let processor = vec![0x22; 32];
        let redirected = vec![0x33; 32];
        let instance = instance_envelope(Some(processor.clone()), None);
        let action = action_envelope(&instance, processor.clone());

        validate_action_authority(&user, &action, &instance)
            .expect("a user may submit a generic action to the pinned processor");
        validate_receipt_authority(&processor, &user, &action, &instance)
            .expect("the pinned processor may receipt the user's action");

        let redirected_action = action_envelope(&instance, redirected.clone());
        assert!(
            validate_action_authority(&user, &redirected_action, &instance)
                .expect_err("action processor redirection must fail")
                .contains("redirects")
        );
        assert!(
            validate_receipt_authority(&redirected, &user, &redirected_action, &instance)
                .expect_err("a redirected receipt chain must fail")
                .contains("redirects")
        );
        assert!(
            validate_receipt_authority(&redirected, &user, &action, &instance)
                .expect_err("a foreign receipt signer must fail")
                .contains("pinned instance processor")
        );
    }

    #[test]
    fn attention_action_requires_decision_maker_signature() {
        let decision_maker = vec![0x44; 32];
        let processor = vec![0x66; 32];
        let other_user = [0x55; 32];
        let instance = instance_envelope(Some(processor.clone()), Some(decision_maker.clone()));
        let action = action_envelope(&instance, processor.clone());

        validate_action_authority(&decision_maker, &action, &instance)
            .expect("the decision maker may submit the attention action");
        validate_receipt_authority(&processor, &decision_maker, &action, &instance)
            .expect("the pinned processor may receipt the decision-maker action");
        assert!(validate_action_authority(&other_user, &action, &instance)
            .expect_err("another user cannot decide")
            .contains("decision maker"));
    }

    #[test]
    fn block_receipt_rejects_missing_action_reference() {
        let channel = Uuid::new_v4().to_string();
        let instance = Uuid::new_v4().to_string();
        let idempotency = Uuid::new_v4().to_string();
        let instance_event = "cd".repeat(32);
        let event = signed(
            KIND_BLOCK_RECEIPT as u16,
            vec![
                tag(&["h", &channel]),
                tag(&["e", &instance_event, "", "block-instance"]),
                tag(&["block-receipt", "1", &instance, &idempotency, "succeeded"]),
            ],
            "{}",
        );
        assert!(parse_public_envelope(&event)
            .expect_err("missing action reference must fail")
            .contains("exactly one Block action"));
    }

    #[test]
    fn failed_and_timed_out_receipts_cannot_resolve_attention() {
        let channel = Uuid::new_v4().to_string();
        let instance = Uuid::new_v4().to_string();
        let idempotency = Uuid::new_v4().to_string();
        let action_event = "ef".repeat(32);
        let instance_event = "cd".repeat(32);
        for status in ["failed", "timed-out"] {
            let event = signed(
                KIND_BLOCK_RECEIPT as u16,
                vec![
                    tag(&["h", &channel]),
                    tag(&["e", &action_event, "", "block-action"]),
                    tag(&["e", &instance_event, "", "block-instance"]),
                    tag(&["block-receipt", "1", &instance, &idempotency, status]),
                    tag(&["block-attention", "1", "resolved"]),
                ],
                "{}",
            );
            assert!(parse_public_envelope(&event)
                .expect_err("non-resolving receipt status must fail")
                .contains("cannot resolve"));
        }
    }

    #[test]
    fn receipt_rejects_noncanonical_status_spellings() {
        let channel = Uuid::new_v4().to_string();
        let instance = Uuid::new_v4().to_string();
        let idempotency = Uuid::new_v4().to_string();
        let action_event = "ef".repeat(32);
        let instance_event = "cd".repeat(32);
        for status in ["declined", "pending", "superseded", "timed_out"] {
            let event = signed(
                KIND_BLOCK_RECEIPT as u16,
                vec![
                    tag(&["h", &channel]),
                    tag(&["e", &action_event, "", "block-action"]),
                    tag(&["e", &instance_event, "", "block-instance"]),
                    tag(&["block-receipt", "1", &instance, &idempotency, status]),
                ],
                "{}",
            );
            assert!(parse_public_envelope(&event)
                .expect_err("unknown status must fail")
                .contains("status is invalid"));
        }
    }

    #[test]
    fn all_sdk_receipt_statuses_parse_with_matching_resolution_semantics() {
        let manifests = crate::core_blocks::core_block_manifests().expect("valid Core manifests");
        let manifest = manifests
            .into_iter()
            .find(|manifest| {
                manifest.actions.iter().any(|action| {
                    matches!(
                        action.interaction,
                        BlockInteraction::Signed {
                            resolves_attention: true,
                            ..
                        }
                    )
                })
            })
            .expect("Core manifest with a resolving signed action");
        let action_id = manifest
            .actions
            .iter()
            .find_map(|action| {
                matches!(
                    action.interaction,
                    BlockInteraction::Signed {
                        resolves_attention: true,
                        ..
                    }
                )
                .then(|| action.id.clone())
            })
            .expect("resolving action");
        let action_event_id = EventId::from_hex(&"ef".repeat(32)).expect("action event ID");
        let instance_event_id = EventId::from_hex(&"cd".repeat(32)).expect("instance event ID");

        let cases = [
            (
                BlockReceiptStatus::Succeeded,
                ReceiptStatus::Succeeded,
                true,
            ),
            (BlockReceiptStatus::Denied, ReceiptStatus::Denied, true),
            (BlockReceiptStatus::Failed, ReceiptStatus::Failed, false),
            (BlockReceiptStatus::TimedOut, ReceiptStatus::TimedOut, false),
        ];
        for (sdk_status, relay_status, resolves_attention) in cases {
            let event = build_block_receipt(&BlockReceiptInput {
                channel_id: Uuid::new_v4(),
                action_event_id,
                instance_event_id,
                instance_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                action_id: action_id.clone(),
                manifest: &manifest,
                status: sdk_status,
                result: serde_json::json!({}),
                resolves_attention,
            })
            .expect("SDK receipt status should build")
            .sign_with_keys(&Keys::generate())
            .expect("SDK receipt should sign");

            let Some(ValidatedBlockEvent::Receipt(receipt)) =
                parse_public_envelope(&event).expect("SDK receipt should parse")
            else {
                panic!("SDK receipt must parse as a receipt");
            };
            assert_eq!(receipt.status, relay_status);
            assert_eq!(receipt.status.can_resolve_attention(), resolves_attention);
            assert_eq!(receipt.resolves_attention, resolves_attention);
        }
    }

    #[test]
    fn action_rejects_secret_bearing_content() {
        let channel = Uuid::new_v4().to_string();
        let instance = Uuid::new_v4().to_string();
        let idempotency = Uuid::new_v4().to_string();
        let instance_event = "cd".repeat(32);
        let manifest = manifest_id();
        let processor = "12".repeat(32);
        let event = signed(
            KIND_BLOCK_ACTION as u16,
            vec![
                tag(&["h", &channel]),
                tag(&["p", &processor]),
                tag(&["e", &instance_event, "", "block-instance"]),
                tag(&["e", &manifest, "", "block-manifest"]),
                tag(&["block-action", "1", "agent.create", &instance, &idempotency]),
            ],
            r#"{"providerCredentials":"never"}"#,
        );
        assert!(parse_public_envelope(&event)
            .expect_err("secret content must fail")
            .contains("secret-bearing"));
    }

    #[test]
    fn discovery_budget_approval_values_reject_changes_expiry_and_wrong_hashes() {
        let proposal = buzz_core::block::ApprovalProposal {
            action: "Approve Colony Credits for Discovery Campaign".into(),
            destination: "colony:discovery:campaign:fixture".into(),
            content: serde_json::json!("{\"approved_nanousd\":\"50000000\"}"),
            expires_at: 2_000,
        };
        let hash = buzz_core::block::compute_approval_hash(&proposal).expect("approval hash");
        assert!(validate_discovery_budget_approval_values(
            &proposal,
            &proposal,
            &serde_json::json!({"approval_hash": hash}),
            1_999,
        )
        .is_ok());

        let mut changed = proposal.clone();
        changed.destination.push_str("-changed");
        assert!(validate_discovery_budget_approval_values(
            &changed,
            &proposal,
            &serde_json::json!({"approval_hash": "00".repeat(32)}),
            1_999,
        )
        .expect_err("changed proposal must fail")
        .contains("does not match"));
        assert!(validate_discovery_budget_approval_values(
            &proposal,
            &proposal,
            &serde_json::json!({"approval_hash": "00".repeat(32)}),
            2_000,
        )
        .expect_err("expired proposal must fail")
        .contains("expired"));
        assert!(validate_discovery_budget_approval_values(
            &proposal,
            &proposal,
            &serde_json::json!({"approval_hash": "00".repeat(32)}),
            1_999,
        )
        .expect_err("wrong hash must fail")
        .contains("hash"));
    }
}
