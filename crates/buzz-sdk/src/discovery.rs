//! Signed Nostr envelopes for Colony business Discovery commands and receipts.

use std::str::FromStr;

use buzz_core::{
    block::canonical_json,
    discovery::{
        DiscoveryAction, DiscoveryOperation, DiscoveryReceipt, DiscoveryRunRequest,
        DiscoveryStartRequest,
    },
    kind::{KIND_DISCOVERY_ACTION, KIND_DISCOVERY_RECEIPT},
};
use nostr::{Event, EventBuilder, EventId, Kind, PublicKey, Tag};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const ACTION_SCHEMA: &str = "colony.discovery-action/v1";
const RECEIPT_SCHEMA: &str = "colony.discovery-receipt/v1";

/// A strict Discovery action together with the relay named by its `p` tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryAction {
    /// Relay public key addressed by the actor.
    pub relay_pubkey: PublicKey,
    /// Validated operation-specific payload.
    pub action: DiscoveryAction,
}

/// A strict Discovery receipt together with its private routing references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryReceipt {
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
    validate_uuid(request.request_id, "discovery action")?;
    validate_uuid(request.idempotency_key, "discovery action")?;
    validate_uuid(request.campaign_id, "discovery action")?;
    build_action(
        relay_pubkey,
        DiscoveryOperation::Start,
        request.request_id,
        request.idempotency_key,
        Some(request.campaign_id),
        None,
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
        operation,
        request.request_id,
        request.idempotency_key,
        None,
        Some(request.run_id),
    )
}

fn build_action(
    relay_pubkey: PublicKey,
    operation: DiscoveryOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    campaign_id: Option<Uuid>,
    run_id: Option<Uuid>,
) -> Result<EventBuilder, DiscoverySdkError> {
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
        schema: ACTION_SCHEMA.to_owned(),
        operation,
        request_id,
        idempotency_key,
        campaign_id,
        run_id,
    };
    let tags = [
        scalar_tag("p", &relay_text)?,
        scalar_tag(target_tag, &target_text)?,
        tuple_tag(&[
            "discovery-action",
            "1",
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
    if tuple[1] != "1" {
        return Err(DiscoverySdkError::InvalidTag("discovery-action"));
    }
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
    if content.schema != ACTION_SCHEMA
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
            DiscoveryAction::Start(DiscoveryStartRequest {
                request_id,
                idempotency_key,
                campaign_id: target_id,
            })
        }
        DiscoveryOperation::Status
            if content.run_id == Some(target_id) && content.campaign_id.is_none() =>
        {
            DiscoveryAction::Status(DiscoveryRunRequest {
                request_id,
                idempotency_key,
                run_id: target_id,
            })
        }
        DiscoveryOperation::Cancel
            if content.run_id == Some(target_id) && content.campaign_id.is_none() =>
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
    if tuple[1] != "1" {
        return Err(DiscoverySdkError::InvalidTag("discovery-receipt"));
    }
    let operation = parse_operation(&tuple[2])?;
    let request_id = parse_uuid(&tuple[3], "discovery receipt")?;
    let idempotency_key = parse_uuid(&tuple[4], "discovery receipt")?;
    if tuple[5] != run_id.to_string() {
        return Err(DiscoverySdkError::TagContentMismatch("discovery receipt"));
    }
    let content: DiscoveryReceiptContent =
        parse_canonical_content(&event.content, "discovery receipt")?;
    if content.schema != RECEIPT_SCHEMA
        || content.receipt.operation != operation
        || content.receipt.request_id != request_id
        || content.receipt.idempotency_key != idempotency_key
        || content.receipt.run.run_id != run_id
    {
        return Err(DiscoverySdkError::TagContentMismatch("discovery receipt"));
    }
    validate_projection(&content.receipt)?;
    Ok(ParsedDiscoveryReceipt {
        actor_pubkey,
        action_event_id,
        receipt: content.receipt,
    })
}

fn validate_projection(receipt: &DiscoveryReceipt) -> Result<(), DiscoverySdkError> {
    validate_uuid(receipt.request_id, "discovery receipt")?;
    validate_uuid(receipt.idempotency_key, "discovery receipt")?;
    validate_uuid(receipt.run.run_id, "discovery receipt")?;
    validate_uuid(receipt.run.campaign_id, "discovery receipt")?;
    if receipt.run.total_steps == 0 || receipt.run.completed_steps > receipt.run.total_steps {
        return Err(DiscoverySdkError::InvalidEnvelope("discovery receipt"));
    }
    Ok(())
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

fn validate_uuid(value: Uuid, entity: &'static str) -> Result<(), DiscoverySdkError> {
    if value.is_nil() {
        Err(DiscoverySdkError::InvalidEnvelope(entity))
    } else {
        Ok(())
    }
}

fn parse_uuid(value: &str, entity: &'static str) -> Result<Uuid, DiscoverySdkError> {
    let parsed = Uuid::parse_str(value).map_err(|_| DiscoverySdkError::InvalidEnvelope(entity))?;
    if parsed.is_nil() || parsed.to_string() != value {
        return Err(DiscoverySdkError::InvalidEnvelope(entity));
    }
    Ok(parsed)
}

fn parse_pubkey(value: &str, entity: &'static str) -> Result<PublicKey, DiscoverySdkError> {
    if value.len() != 64
        || value
            .chars()
            .any(|character| !character.is_ascii_digit() && !matches!(character, 'a'..='f'))
    {
        return Err(DiscoverySdkError::InvalidEnvelope(entity));
    }
    PublicKey::from_str(value).map_err(|_| DiscoverySdkError::InvalidEnvelope(entity))
}

fn scalar_tag(name: &'static str, value: &str) -> Result<Tag, DiscoverySdkError> {
    tuple_tag(&[name, value])
}

fn tuple_tag(parts: &[&str]) -> Result<Tag, DiscoverySdkError> {
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

fn canonical_content<T: Serialize>(
    value: &T,
    entity: &'static str,
) -> Result<String, DiscoverySdkError> {
    let value =
        serde_json::to_value(value).map_err(|_| DiscoverySdkError::InvalidContent(entity))?;
    canonical_json(&value).map_err(|_| DiscoverySdkError::InvalidContent(entity))
}

fn parse_canonical_content<T: DeserializeOwned>(
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

fn require_kind(event: &Event, expected: u32) -> Result<(), DiscoverySdkError> {
    let actual = u32::from(event.kind.as_u16());
    if actual == expected {
        Ok(())
    } else {
        Err(DiscoverySdkError::UnexpectedKind { expected, actual })
    }
}

fn require_exact_tag_names(
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

fn required_scalar_tag<'a>(
    event: &'a Event,
    name: &'static str,
) -> Result<&'a str, DiscoverySdkError> {
    let tuple = required_tuple_tag(event, name, 2)?;
    Ok(tuple[1].as_str())
}

fn required_tuple_tag<'a>(
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
    use buzz_core::discovery::{DiscoveryAction, DiscoveryRunRequest, DiscoveryStartRequest};
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use uuid::Uuid;

    #[test]
    fn start_action_round_trips_with_exact_tags() {
        let keys = Keys::generate();
        let relay_keys = Keys::generate();
        let request = DiscoveryStartRequest {
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            campaign_id: Uuid::from_u128(3),
        };
        let event = build_discovery_start_action(relay_keys.public_key(), &request)
            .expect("test event must build")
            .sign_with_keys(&keys)
            .expect("test event must sign");

        let parsed = parse_discovery_action(&event).expect("strict parser must accept its builder");
        assert_eq!(parsed.relay_pubkey, relay_keys.public_key());
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
        };
        assert!(matches!(
            build_discovery_start_action(Keys::generate().public_key(), &request),
            Err(DiscoverySdkError::InvalidEnvelope("discovery action"))
        ));
    }

    #[test]
    fn action_parser_rejects_extra_tags() {
        let relay = Keys::generate();
        let request = DiscoveryStartRequest {
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            campaign_id: Uuid::from_u128(3),
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
        };
        let original = build_discovery_start_action(relay.public_key(), &request)
            .expect("action builds")
            .sign_with_keys(&Keys::generate())
            .expect("action signs");
        let content = DiscoveryActionContent {
            schema: ACTION_SCHEMA.to_owned(),
            operation: DiscoveryOperation::Start,
            request_id: request.request_id,
            idempotency_key: request.idempotency_key,
            campaign_id: Some(Uuid::from_u128(99)),
            run_id: None,
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
}
