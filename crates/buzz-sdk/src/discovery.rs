//! Signed Nostr envelopes for Colony business Discovery commands and receipts.

use std::str::FromStr;

use buzz_core::{
    block::canonical_json,
    discovery::{
        DiscoveryAction, DiscoveryBusinessSearchSpec, DiscoveryOperation, DiscoveryReceipt,
        DiscoveryRunRequest, DiscoveryStartRequest,
    },
    kind::{KIND_DISCOVERY_ACTION, KIND_DISCOVERY_RECEIPT},
};
use nostr::{Event, EventBuilder, EventId, Kind, PublicKey, Tag};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const ACTION_SCHEMA_V1: &str = "colony.discovery-action/v1";
const ACTION_SCHEMA_V2: &str = "colony.discovery-action/v2";
const ACTION_SCHEMA_V3: &str = "colony.discovery-action/v3";
const RECEIPT_SCHEMA_V1: &str = "colony.discovery-receipt/v1";
const RECEIPT_SCHEMA_V2: &str = "colony.discovery-receipt/v2";
const RECEIPT_SCHEMA_V3: &str = "colony.discovery-receipt/v3";

/// Version of the strict Discovery run wire envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryWireVersion {
    /// Released Outscraper-only run contract.
    V1,
    /// Multi-source-aware run contract.
    V2,
    /// Colony-funded run contract with Campaign-derived search and billing.
    V3,
}

impl DiscoveryWireVersion {
    const fn tag(self) -> &'static str {
        match self {
            Self::V1 => "1",
            Self::V2 => "2",
            Self::V3 => "3",
        }
    }

    const fn action_schema(self) -> &'static str {
        match self {
            Self::V1 => ACTION_SCHEMA_V1,
            Self::V2 => ACTION_SCHEMA_V2,
            Self::V3 => ACTION_SCHEMA_V3,
        }
    }

    const fn receipt_schema(self) -> &'static str {
        match self {
            Self::V1 => RECEIPT_SCHEMA_V1,
            Self::V2 => RECEIPT_SCHEMA_V2,
            Self::V3 => RECEIPT_SCHEMA_V3,
        }
    }
}

/// A strict Discovery action together with the relay named by its `p` tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryAction {
    /// Relay public key addressed by the actor.
    pub relay_pubkey: PublicKey,
    /// Exact signed wire version, used to enforce rollout-safe behavior.
    pub wire_version: DiscoveryWireVersion,
    /// Validated operation-specific payload.
    pub action: DiscoveryAction,
}

/// A strict Discovery receipt together with its private routing references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryReceipt {
    /// Exact relay-authored wire version.
    pub wire_version: DiscoveryWireVersion,
    /// Requester public key named by the receipt's `p` tag.
    pub actor_pubkey: PublicKey,
    /// Exact signed action processed by the relay.
    pub action_event_id: EventId,
    /// Validated safe receipt content.
    pub receipt: DiscoveryReceipt,
}

/// Validation error for Discovery Nostr envelopes.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DiscoverySdkError {
    /// The event kind is not the required Discovery kind.
    #[error("expected kind {expected}, got {actual}")]
    UnexpectedKind {
        /// Expected kind number.
        expected: u32,
        /// Actual kind number.
        actual: u32,
    },
    /// A required tag is missing, duplicated, or malformed.
    #[error("invalid `{0}` tag")]
    InvalidTag(&'static str),
    /// The envelope carries an unexpected tag.
    #[error("unexpected tag in {0}")]
    UnexpectedTag(&'static str),
    /// Canonical content is malformed or unsupported.
    #[error("invalid {0} content")]
    InvalidContent(&'static str),
    /// Public tags disagree with signed content.
    #[error("{0} tags and content do not match")]
    TagContentMismatch(&'static str),
    /// A UUID, public key, event ID, or operation is invalid.
    #[error("invalid {0} envelope")]
    InvalidEnvelope(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct DiscoveryActionContent {
    schema: String,
    operation: DiscoveryOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    campaign_id: Option<Uuid>,
    run_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protocol_version: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    business_search: Option<DiscoveryBusinessSearchSpec>,
}

struct DiscoveryActionInput {
    wire_version: DiscoveryWireVersion,
    operation: DiscoveryOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    campaign_id: Option<Uuid>,
    run_id: Option<Uuid>,
    protocol_version: Option<u16>,
    business_search: Option<DiscoveryBusinessSearchSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct DiscoveryReceiptContent {
    schema: String,
    #[serde(flatten)]
    receipt: DiscoveryReceipt,
}

/// Build a member-signable Discovery start action.
pub fn build_discovery_start_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryStartRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    request
        .validate()
        .map_err(|_| DiscoverySdkError::InvalidEnvelope("discovery action"))?;
    let (wire_version, protocol_version) = match request.protocol_version {
        buzz_core::discovery::DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION => (
            DiscoveryWireVersion::V3,
            Some(buzz_core::discovery::DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION),
        ),
        buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION => {
            (DiscoveryWireVersion::V2, None)
        }
        _ => return Err(DiscoverySdkError::InvalidEnvelope("discovery action")),
    };
    build_action(
        relay_pubkey,
        DiscoveryActionInput {
            wire_version,
            operation: DiscoveryOperation::Start,
            request_id: request.request_id,
            idempotency_key: request.idempotency_key,
            campaign_id: Some(request.campaign_id),
            run_id: None,
            protocol_version,
            business_search: request.business_search.clone(),
        },
    )
}

/// Build a member-signable Discovery status action.
pub fn build_discovery_status_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryRunRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    build_run_action(relay_pubkey, DiscoveryOperation::Status, request)
}

/// Build a member-signable Discovery cancel action.
pub fn build_discovery_cancel_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryRunRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    build_run_action(relay_pubkey, DiscoveryOperation::Cancel, request)
}

/// Build the exact relay-signable Discovery receipt envelope.
///
/// Relay ingest rejects client-authored receipt kinds, so exposing the shape
/// does not grant authority; the configured relay key remains the trust root.
pub fn build_discovery_receipt(
    actor_pubkey: PublicKey,
    action_event_id: EventId,
    receipt: &DiscoveryReceipt,
) -> Result<EventBuilder, DiscoverySdkError> {
    build_discovery_receipt_for_version(
        DiscoveryWireVersion::V2,
        actor_pubkey,
        action_event_id,
        receipt,
    )
}

/// Build a relay receipt matching the exact run action wire version.
pub fn build_discovery_receipt_for_version(
    wire_version: DiscoveryWireVersion,
    actor_pubkey: PublicKey,
    action_event_id: EventId,
    receipt: &DiscoveryReceipt,
) -> Result<EventBuilder, DiscoverySdkError> {
    validate_projection(receipt)?;
    let actor_text = actor_pubkey.to_hex();
    let action_text = action_event_id.to_hex();
    let run_text = receipt.run.run_id.to_string();
    let request_text = receipt.request_id.to_string();
    let idempotency_text = receipt.idempotency_key.to_string();
    let mut compatible_receipt = receipt.clone();
    if wire_version != DiscoveryWireVersion::V3 {
        compatible_receipt.run.protocol_version =
            buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION;
        compatible_receipt.run.billing = None;
    }
    let content = DiscoveryReceiptContent {
        schema: wire_version.receipt_schema().to_owned(),
        receipt: compatible_receipt,
    };
    let tags = [
        scalar_tag("p", &actor_text)?,
        tuple_tag(&["e", &action_text, "", "discovery-action"])?,
        scalar_tag("run", &run_text)?,
        tuple_tag(&[
            "discovery-receipt",
            wire_version.tag(),
            operation_tag(receipt.operation),
            &request_text,
            &idempotency_text,
            &run_text,
        ])?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_DISCOVERY_RECEIPT as u16),
        canonical_content(&content, "discovery receipt")?,
    )
    .tags(tags))
}

fn build_run_action(
    relay_pubkey: PublicKey,
    operation: DiscoveryOperation,
    request: &DiscoveryRunRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    validate_uuid(request.request_id, "discovery action")?;
    validate_uuid(request.idempotency_key, "discovery action")?;
    validate_uuid(request.run_id, "discovery action")?;
    build_action(
        relay_pubkey,
        DiscoveryActionInput {
            wire_version: DiscoveryWireVersion::V2,
            operation,
            request_id: request.request_id,
            idempotency_key: request.idempotency_key,
            campaign_id: None,
            run_id: Some(request.run_id),
            protocol_version: None,
            business_search: None,
        },
    )
}

fn build_action(
    relay_pubkey: PublicKey,
    input: DiscoveryActionInput,
) -> Result<EventBuilder, DiscoverySdkError> {
    let DiscoveryActionInput {
        wire_version,
        operation,
        request_id,
        idempotency_key,
        campaign_id,
        run_id,
        protocol_version,
        business_search,
    } = input;
    let target = campaign_id
        .or(run_id)
        .ok_or(DiscoverySdkError::InvalidEnvelope("discovery action"))?;
    let target_tag = if campaign_id.is_some() {
        "campaign"
    } else {
        "run"
    };
    let operation_tag = operation_tag(operation);
    let request_text = request_id.to_string();
    let idempotency_text = idempotency_key.to_string();
    let target_text = target.to_string();
    let relay_text = relay_pubkey.to_hex();
    let content = DiscoveryActionContent {
        schema: wire_version.action_schema().to_owned(),
        operation,
        request_id,
        idempotency_key,
        campaign_id,
        run_id,
        protocol_version,
        business_search,
    };
    let tags = [
        scalar_tag("p", &relay_text)?,
        scalar_tag(target_tag, &target_text)?,
        tuple_tag(&[
            "discovery-action",
            wire_version.tag(),
            operation_tag,
            &request_text,
            &idempotency_text,
        ])?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_DISCOVERY_ACTION as u16),
        canonical_content(&content, "discovery action")?,
    )
    .tags(tags))
}

/// Parse the exact Discovery action envelope.
///
/// Signature validity, authenticated authorship, relay recipient authority,
/// entitlement, and actor capability remain relay concerns.
pub fn parse_discovery_action(event: &Event) -> Result<ParsedDiscoveryAction, DiscoverySdkError> {
    require_kind(event, KIND_DISCOVERY_ACTION)?;
    if event.tags.len() != 3 {
        return Err(DiscoverySdkError::UnexpectedTag("discovery action"));
    }
    let relay_pubkey = parse_pubkey(required_scalar_tag(event, "p")?, "discovery action")?;
    let tuple = required_tuple_tag(event, "discovery-action", 5)?;
    let wire_version = parse_wire_version(&tuple[1], "discovery-action")?;
    let operation = parse_operation(&tuple[2])?;
    let request_id = parse_uuid(&tuple[3], "discovery action")?;
    let idempotency_key = parse_uuid(&tuple[4], "discovery action")?;
    let target_tag = match operation {
        DiscoveryOperation::Start => "campaign",
        DiscoveryOperation::Status | DiscoveryOperation::Cancel => "run",
    };
    require_exact_tag_names(
        event,
        &["p", target_tag, "discovery-action"],
        "discovery action",
    )?;
    let target_id = parse_uuid(required_scalar_tag(event, target_tag)?, "discovery action")?;
    let content: DiscoveryActionContent =
        parse_canonical_content(&event.content, "discovery action")?;
    if content.schema != wire_version.action_schema()
        || content.operation != operation
        || content.request_id != request_id
        || content.idempotency_key != idempotency_key
    {
        return Err(DiscoverySdkError::TagContentMismatch("discovery action"));
    }
    let action = match operation {
        DiscoveryOperation::Start
            if content.campaign_id == Some(target_id) && content.run_id.is_none() =>
        {
            let protocol_version = match (wire_version, content.protocol_version) {
                (DiscoveryWireVersion::V1, None) => 1,
                (DiscoveryWireVersion::V2, None) => {
                    buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION
                }
                (DiscoveryWireVersion::V3, Some(version))
                    if version
                        == buzz_core::discovery::DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION =>
                {
                    version
                }
                _ => return Err(DiscoverySdkError::TagContentMismatch("discovery action")),
            };
            let request = DiscoveryStartRequest {
                request_id,
                idempotency_key,
                campaign_id: target_id,
                protocol_version,
                business_search: content.business_search,
            };
            request
                .validate()
                .map_err(|_| DiscoverySdkError::InvalidEnvelope("discovery action"))?;
            DiscoveryAction::Start(request)
        }
        DiscoveryOperation::Status
            if content.run_id == Some(target_id)
                && content.campaign_id.is_none()
                && content.protocol_version.is_none()
                && content.business_search.is_none() =>
        {
            DiscoveryAction::Status(DiscoveryRunRequest {
                request_id,
                idempotency_key,
                run_id: target_id,
            })
        }
        DiscoveryOperation::Cancel
            if content.run_id == Some(target_id)
                && content.campaign_id.is_none()
                && content.protocol_version.is_none()
                && content.business_search.is_none() =>
        {
            DiscoveryAction::Cancel(DiscoveryRunRequest {
                request_id,
                idempotency_key,
                run_id: target_id,
            })
        }
        _ => return Err(DiscoverySdkError::TagContentMismatch("discovery action")),
    };
    Ok(ParsedDiscoveryAction {
        relay_pubkey,
        wire_version,
        action,
    })
}

/// Parse an exact relay-authored Discovery receipt envelope.
///
/// The caller must verify the event signature and require the configured relay
/// public key before trusting the returned projection.
pub fn parse_discovery_receipt(event: &Event) -> Result<ParsedDiscoveryReceipt, DiscoverySdkError> {
    require_kind(event, KIND_DISCOVERY_RECEIPT)?;
    require_exact_tag_names(
        event,
        &["p", "e", "run", "discovery-receipt"],
        "discovery receipt",
    )?;
    let actor_pubkey = parse_pubkey(required_scalar_tag(event, "p")?, "discovery receipt")?;
    let action_ref = required_tuple_tag(event, "e", 4)?;
    if !action_ref[2].is_empty() || action_ref[3] != "discovery-action" {
        return Err(DiscoverySdkError::InvalidTag("e"));
    }
    let action_event_id = EventId::from_hex(&action_ref[1])
        .map_err(|_| DiscoverySdkError::InvalidEnvelope("discovery receipt"))?;
    let run_id = parse_uuid(required_scalar_tag(event, "run")?, "discovery receipt")?;
    let tuple = required_tuple_tag(event, "discovery-receipt", 6)?;
    let wire_version = parse_wire_version(&tuple[1], "discovery-receipt")?;
    let operation = parse_operation(&tuple[2])?;
    let request_id = parse_uuid(&tuple[3], "discovery receipt")?;
    let idempotency_key = parse_uuid(&tuple[4], "discovery receipt")?;
    if tuple[5] != run_id.to_string() {
        return Err(DiscoverySdkError::TagContentMismatch("discovery receipt"));
    }
    let content: DiscoveryReceiptContent =
        parse_canonical_content(&event.content, "discovery receipt")?;
    if content.schema != wire_version.receipt_schema()
        || content.receipt.operation != operation
        || content.receipt.request_id != request_id
        || content.receipt.idempotency_key != idempotency_key
        || content.receipt.run.run_id != run_id
    {
        return Err(DiscoverySdkError::TagContentMismatch("discovery receipt"));
    }
    validate_projection(&content.receipt)?;
    Ok(ParsedDiscoveryReceipt {
        wire_version,
        actor_pubkey,
        action_event_id,
        receipt: content.receipt,
    })
}

fn parse_wire_version(
    value: &str,
    tag: &'static str,
) -> Result<DiscoveryWireVersion, DiscoverySdkError> {
    match value {
        "1" => Ok(DiscoveryWireVersion::V1),
        "2" => Ok(DiscoveryWireVersion::V2),
        "3" => Ok(DiscoveryWireVersion::V3),
        _ => Err(DiscoverySdkError::InvalidTag(tag)),
    }
}

fn validate_projection(receipt: &DiscoveryReceipt) -> Result<(), DiscoverySdkError> {
    validate_uuid(receipt.request_id, "discovery receipt")?;
    validate_uuid(receipt.idempotency_key, "discovery receipt")?;
    validate_uuid(receipt.run.run_id, "discovery receipt")?;
    validate_uuid(receipt.run.campaign_id, "discovery receipt")?;
    receipt
        .run
        .validate()
        .map_err(|_| DiscoverySdkError::InvalidEnvelope("discovery receipt"))
}

fn operation_tag(operation: DiscoveryOperation) -> &'static str {
    match operation {
        DiscoveryOperation::Start => "start",
        DiscoveryOperation::Status => "status",
        DiscoveryOperation::Cancel => "cancel",
    }
}

fn parse_operation(value: &str) -> Result<DiscoveryOperation, DiscoverySdkError> {
    match value {
        "start" => Ok(DiscoveryOperation::Start),
        "status" => Ok(DiscoveryOperation::Status),
        "cancel" => Ok(DiscoveryOperation::Cancel),
        _ => Err(DiscoverySdkError::InvalidEnvelope("discovery action")),
    }
}

pub(crate) fn validate_uuid(value: Uuid, entity: &'static str) -> Result<(), DiscoverySdkError> {
    if value.is_nil() {
        Err(DiscoverySdkError::InvalidEnvelope(entity))
    } else {
        Ok(())
    }
}

pub(crate) fn parse_uuid(value: &str, entity: &'static str) -> Result<Uuid, DiscoverySdkError> {
    let parsed = Uuid::parse_str(value).map_err(|_| DiscoverySdkError::InvalidEnvelope(entity))?;
    if parsed.is_nil() || parsed.to_string() != value {
        return Err(DiscoverySdkError::InvalidEnvelope(entity));
    }
    Ok(parsed)
}

pub(crate) fn parse_pubkey(
    value: &str,
    entity: &'static str,
) -> Result<PublicKey, DiscoverySdkError> {
    if value.len() != 64
        || value
            .chars()
            .any(|character| !character.is_ascii_digit() && !matches!(character, 'a'..='f'))
    {
        return Err(DiscoverySdkError::InvalidEnvelope(entity));
    }
    PublicKey::from_str(value).map_err(|_| DiscoverySdkError::InvalidEnvelope(entity))
}

pub(crate) fn scalar_tag(name: &'static str, value: &str) -> Result<Tag, DiscoverySdkError> {
    tuple_tag(&[name, value])
}

pub(crate) fn tuple_tag(parts: &[&str]) -> Result<Tag, DiscoverySdkError> {
    let name = match parts.first().copied() {
        Some("p") => "p",
        Some("e") => "e",
        Some("run") => "run",
        Some("campaign") => "campaign",
        Some("discovery-action") => "discovery-action",
        Some("discovery-receipt") => "discovery-receipt",
        _ => "discovery",
    };
    Tag::parse(parts.iter().copied()).map_err(|_| DiscoverySdkError::InvalidTag(name))
}

pub(crate) fn canonical_content<T: Serialize>(
    value: &T,
    entity: &'static str,
) -> Result<String, DiscoverySdkError> {
    let value =
        serde_json::to_value(value).map_err(|_| DiscoverySdkError::InvalidContent(entity))?;
    canonical_json(&value).map_err(|_| DiscoverySdkError::InvalidContent(entity))
}

pub(crate) fn parse_canonical_content<T: DeserializeOwned>(
    content: &str,
    entity: &'static str,
) -> Result<T, DiscoverySdkError> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| DiscoverySdkError::InvalidContent(entity))?;
    let canonical =
        canonical_json(&value).map_err(|_| DiscoverySdkError::InvalidContent(entity))?;
    if canonical != content {
        return Err(DiscoverySdkError::InvalidContent(entity));
    }
    serde_json::from_value(value).map_err(|_| DiscoverySdkError::InvalidContent(entity))
}

pub(crate) fn require_kind(event: &Event, expected: u32) -> Result<(), DiscoverySdkError> {
    let actual = u32::from(event.kind.as_u16());
    if actual == expected {
        Ok(())
    } else {
        Err(DiscoverySdkError::UnexpectedKind { expected, actual })
    }
}

pub(crate) fn require_exact_tag_names(
    event: &Event,
    required: &[&str],
    entity: &'static str,
) -> Result<(), DiscoverySdkError> {
    if event.tags.len() != required.len() {
        return Err(DiscoverySdkError::UnexpectedTag(entity));
    }
    for name in required {
        if event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(*name))
            .count()
            != 1
        {
            return Err(DiscoverySdkError::InvalidTag(match *name {
                "p" => "p",
                "e" => "e",
                "run" => "run",
                "campaign" => "campaign",
                "discovery-action" => "discovery-action",
                "discovery-receipt" => "discovery-receipt",
                _ => "discovery",
            }));
        }
    }
    Ok(())
}

pub(crate) fn required_scalar_tag<'a>(
    event: &'a Event,
    name: &'static str,
) -> Result<&'a str, DiscoverySdkError> {
    let tuple = required_tuple_tag(event, name, 2)?;
    Ok(tuple[1].as_str())
}

pub(crate) fn required_tuple_tag<'a>(
    event: &'a Event,
    name: &'static str,
    length: usize,
) -> Result<&'a [String], DiscoverySdkError> {
    let matches = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
        .collect::<Vec<_>>();
    if matches.len() != 1 || matches[0].as_slice().len() != length {
        return Err(DiscoverySdkError::InvalidTag(name));
    }
    Ok(matches[0].as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::discovery::{
        DiscoveryAction, DiscoveryBusinessSearchSpec, DiscoveryOperation, DiscoveryReceipt,
        DiscoveryRunProjection, DiscoveryRunRequest, DiscoveryRunState, DiscoveryStartRequest,
    };
    use chrono::TimeZone;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use uuid::Uuid;

    fn business_search() -> DiscoveryBusinessSearchSpec {
        DiscoveryBusinessSearchSpec {
            query: "dentists".to_owned(),
            location: "Sandton, Johannesburg, South Africa".to_owned(),
            limit: 3,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        }
    }

    #[test]
    fn start_action_round_trips_with_exact_tags() {
        let keys = Keys::generate();
        let relay_keys = Keys::generate();
        let request = DiscoveryStartRequest {
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            campaign_id: Uuid::from_u128(3),
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            business_search: Some(business_search()),
        };
        let event = build_discovery_start_action(relay_keys.public_key(), &request)
            .expect("test event must build")
            .sign_with_keys(&keys)
            .expect("test event must sign");

        let parsed = parse_discovery_action(&event).expect("strict parser must accept its builder");
        assert_eq!(parsed.relay_pubkey, relay_keys.public_key());
        assert_eq!(parsed.wire_version, DiscoveryWireVersion::V2);
        assert_eq!(parsed.action, DiscoveryAction::Start(request));
        assert_eq!(event.tags.len(), 3);
    }

    #[test]
    fn status_and_cancel_actions_round_trip() {
        let relay = Keys::generate().public_key();
        let request = DiscoveryRunRequest {
            request_id: Uuid::from_u128(11),
            idempotency_key: Uuid::from_u128(12),
            run_id: Uuid::from_u128(13),
        };
        let status = build_discovery_status_action(relay, &request)
            .expect("status builds")
            .sign_with_keys(&Keys::generate())
            .expect("status signs");
        let cancel = build_discovery_cancel_action(relay, &request)
            .expect("cancel builds")
            .sign_with_keys(&Keys::generate())
            .expect("cancel signs");

        assert_eq!(
            parse_discovery_action(&status)
                .expect("status parses")
                .action,
            DiscoveryAction::Status(request.clone())
        );
        assert_eq!(
            parse_discovery_action(&cancel)
                .expect("cancel parses")
                .action,
            DiscoveryAction::Cancel(request)
        );
    }

    #[test]
    fn action_builder_rejects_nil_identifiers() {
        let request = DiscoveryStartRequest {
            request_id: Uuid::nil(),
            idempotency_key: Uuid::from_u128(2),
            campaign_id: Uuid::from_u128(3),
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            business_search: Some(business_search()),
        };
        assert!(matches!(
            build_discovery_start_action(Keys::generate().public_key(), &request),
            Err(DiscoverySdkError::InvalidEnvelope("discovery action"))
        ));
    }

    #[test]
    fn start_action_rejects_invalid_or_secret_shaped_search_content() {
        let mut request = DiscoveryStartRequest {
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            campaign_id: Uuid::from_u128(3),
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            business_search: Some(business_search()),
        };
        request.business_search.as_mut().expect("search").limit = 0;
        assert!(matches!(
            build_discovery_start_action(Keys::generate().public_key(), &request),
            Err(DiscoverySdkError::InvalidEnvelope("discovery action"))
        ));

        request.business_search = Some(business_search());
        let original = build_discovery_start_action(Keys::generate().public_key(), &request)
            .expect("valid action builds")
            .sign_with_keys(&Keys::generate())
            .expect("valid action signs");
        let mut content: serde_json::Value =
            serde_json::from_str(&original.content).expect("valid content");
        content
            .as_object_mut()
            .expect("action object")
            .insert("api_key".to_owned(), serde_json::json!("must-not-fit"));
        let tampered = EventBuilder::new(
            Kind::Custom(KIND_DISCOVERY_ACTION as u16),
            canonical_json(&content).expect("canonical test content"),
        )
        .tags(original.tags.iter().cloned())
        .sign_with_keys(&Keys::generate())
        .expect("tampered action signs");
        assert!(matches!(
            parse_discovery_action(&tampered),
            Err(DiscoverySdkError::InvalidContent("discovery action"))
        ));
    }

    #[test]
    fn action_parser_rejects_extra_tags() {
        let relay = Keys::generate();
        let request = DiscoveryStartRequest {
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            campaign_id: Uuid::from_u128(3),
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            business_search: Some(business_search()),
        };
        let original = build_discovery_start_action(relay.public_key(), &request)
            .expect("action builds")
            .sign_with_keys(&Keys::generate())
            .expect("action signs");
        let mut tags = original.tags.iter().cloned().collect::<Vec<_>>();
        tags.push(Tag::parse(["h", "forbidden-channel"]).expect("test tag"));
        let event = EventBuilder::new(Kind::Custom(KIND_DISCOVERY_ACTION as u16), original.content)
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .expect("tampered event signs");

        assert!(matches!(
            parse_discovery_action(&event),
            Err(DiscoverySdkError::UnexpectedTag("discovery action"))
        ));
    }

    #[test]
    fn action_parser_rejects_tag_content_mismatch() {
        let relay = Keys::generate();
        let request = DiscoveryStartRequest {
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            campaign_id: Uuid::from_u128(3),
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            business_search: Some(business_search()),
        };
        let original = build_discovery_start_action(relay.public_key(), &request)
            .expect("action builds")
            .sign_with_keys(&Keys::generate())
            .expect("action signs");
        let content = DiscoveryActionContent {
            schema: ACTION_SCHEMA_V2.to_owned(),
            operation: DiscoveryOperation::Start,
            request_id: request.request_id,
            idempotency_key: request.idempotency_key,
            campaign_id: Some(Uuid::from_u128(99)),
            run_id: None,
            protocol_version: None,
            business_search: request.business_search.clone(),
        };
        let event = EventBuilder::new(
            Kind::Custom(KIND_DISCOVERY_ACTION as u16),
            canonical_content(&content, "test").expect("canonical content"),
        )
        .tags(original.tags.iter().cloned())
        .sign_with_keys(&Keys::generate())
        .expect("tampered event signs");

        assert!(matches!(
            parse_discovery_action(&event),
            Err(DiscoverySdkError::TagContentMismatch("discovery action"))
        ));
    }

    #[test]
    fn receipt_round_trips_with_exact_private_tags() {
        let actor = Keys::generate();
        let relay = Keys::generate();
        let action = EventBuilder::new(Kind::Custom(KIND_DISCOVERY_ACTION as u16), "{}")
            .sign_with_keys(&actor)
            .expect("test action signs");
        let receipt = DiscoveryReceipt {
            operation: DiscoveryOperation::Start,
            request_id: Uuid::from_u128(21),
            idempotency_key: Uuid::from_u128(22),
            run: DiscoveryRunProjection {
                run_id: Uuid::from_u128(23),
                campaign_id: Uuid::from_u128(24),
                protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
                state: DiscoveryRunState::Queued,
                completed_steps: 0,
                total_steps: 5,
                cancel_requested: false,
                terminal_reason: None,
                billing: None,
                created_at: chrono::Utc
                    .timestamp_opt(1_800_000_000, 0)
                    .single()
                    .expect("time"),
                updated_at: chrono::Utc
                    .timestamp_opt(1_800_000_000, 0)
                    .single()
                    .expect("time"),
            },
        };
        let event = build_discovery_receipt(actor.public_key(), action.id, &receipt)
            .expect("receipt builds")
            .sign_with_keys(&relay)
            .expect("receipt signs");
        let parsed = parse_discovery_receipt(&event).expect("receipt parses");

        assert_eq!(parsed.wire_version, DiscoveryWireVersion::V2);
        assert_eq!(parsed.actor_pubkey, actor.public_key());
        assert_eq!(parsed.action_event_id, action.id);
        assert_eq!(parsed.receipt, receipt);
        assert_eq!(event.tags.len(), 4);
    }

    #[test]
    fn released_v1_run_envelopes_remain_parseable_and_receive_v1_receipts() {
        let actor = Keys::generate();
        let relay = Keys::generate();
        let request = DiscoveryStartRequest {
            request_id: Uuid::from_u128(31),
            idempotency_key: Uuid::from_u128(32),
            campaign_id: Uuid::from_u128(33),
            protocol_version: 1,
            business_search: Some(business_search()),
        };
        let action = build_action(
            relay.public_key(),
            DiscoveryActionInput {
                wire_version: DiscoveryWireVersion::V1,
                operation: DiscoveryOperation::Start,
                request_id: request.request_id,
                idempotency_key: request.idempotency_key,
                campaign_id: Some(request.campaign_id),
                run_id: None,
                protocol_version: None,
                business_search: request.business_search.clone(),
            },
        )
        .expect("legacy action builds")
        .sign_with_keys(&actor)
        .expect("legacy action signs");
        let parsed = parse_discovery_action(&action).expect("legacy action parses");
        assert_eq!(parsed.wire_version, DiscoveryWireVersion::V1);
        assert_eq!(parsed.action, DiscoveryAction::Start(request));

        let receipt = DiscoveryReceipt {
            operation: DiscoveryOperation::Start,
            request_id: Uuid::from_u128(31),
            idempotency_key: Uuid::from_u128(32),
            run: DiscoveryRunProjection {
                run_id: Uuid::from_u128(34),
                campaign_id: Uuid::from_u128(33),
                protocol_version: 1,
                state: DiscoveryRunState::Queued,
                completed_steps: 0,
                total_steps: 1,
                cancel_requested: false,
                terminal_reason: None,
                billing: None,
                created_at: chrono::Utc
                    .timestamp_opt(1_800_000_000, 0)
                    .single()
                    .expect("time"),
                updated_at: chrono::Utc
                    .timestamp_opt(1_800_000_000, 0)
                    .single()
                    .expect("time"),
            },
        };
        let receipt_event = build_discovery_receipt_for_version(
            parsed.wire_version,
            actor.public_key(),
            action.id,
            &receipt,
        )
        .expect("legacy receipt builds")
        .sign_with_keys(&relay)
        .expect("legacy receipt signs");
        assert_eq!(
            parse_discovery_receipt(&receipt_event)
                .expect("legacy receipt parses")
                .wire_version,
            DiscoveryWireVersion::V1
        );
    }
}
