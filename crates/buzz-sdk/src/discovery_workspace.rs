//! Signed private Nostr envelopes for Discovery campaigns and Leads.

use std::str::FromStr;

use buzz_core::{
    block::canonical_json,
    discovery_workspace::{
        DiscoveryWorkspaceOperation, DiscoveryWorkspaceReceipt, DiscoveryWorkspaceRequest,
        DiscoveryWorkspaceResult,
    },
    kind::{KIND_DISCOVERY_WORKSPACE_ACTION, KIND_DISCOVERY_WORKSPACE_RECEIPT},
};
use nostr::{Event, EventBuilder, EventId, Kind, PublicKey, Tag};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use thiserror::Error;

const ACTION_SCHEMA: &str = "colony.discovery-workspace-action/v1";
const RECEIPT_SCHEMA: &str = "colony.discovery-workspace-receipt/v1";

/// A strict workspace action together with the relay named by its `p` tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryWorkspaceAction {
    /// Relay public key addressed by the actor.
    pub relay_pubkey: PublicKey,
    /// Validated request.
    pub request: DiscoveryWorkspaceRequest,
}

/// A strict relay receipt together with its private routing references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryWorkspaceReceipt {
    /// Requester public key named by the receipt's `p` tag.
    pub actor_pubkey: PublicKey,
    /// Exact signed action processed by the relay.
    pub action_event_id: EventId,
    /// Validated private receipt content.
    pub receipt: DiscoveryWorkspaceReceipt,
}

/// Validation error for Discovery workspace Nostr envelopes.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DiscoveryWorkspaceSdkError {
    /// The event kind is not the required Discovery workspace kind.
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
    /// Request or result validation failed.
    #[error("invalid {0} envelope")]
    InvalidEnvelope(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct WorkspaceActionContent {
    schema: String,
    request: DiscoveryWorkspaceRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct WorkspaceReceiptContent {
    schema: String,
    receipt: DiscoveryWorkspaceReceipt,
}

/// Build a member-signable private Discovery workspace action.
pub fn build_discovery_workspace_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkspaceRequest,
) -> Result<EventBuilder, DiscoveryWorkspaceSdkError> {
    request
        .validate()
        .map_err(|_| DiscoveryWorkspaceSdkError::InvalidEnvelope("workspace action"))?;
    let operation = operation_tag(request.payload.operation());
    let request_id = request.request_id.to_string();
    let idempotency_key = request.idempotency_key.to_string();
    let relay = relay_pubkey.to_hex();
    let content = WorkspaceActionContent {
        schema: ACTION_SCHEMA.to_owned(),
        request: request.clone(),
    };
    let tags = [
        scalar_tag("p", &relay)?,
        tuple_tag(&[
            "discovery-workspace-action",
            "1",
            operation,
            &request_id,
            &idempotency_key,
        ])?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_DISCOVERY_WORKSPACE_ACTION as u16),
        canonical_content(&content, "workspace action")?,
    )
    .tags(tags))
}

/// Parse the exact member-signed Discovery workspace action envelope.
pub fn parse_discovery_workspace_action(
    event: &Event,
) -> Result<ParsedDiscoveryWorkspaceAction, DiscoveryWorkspaceSdkError> {
    require_kind(event, KIND_DISCOVERY_WORKSPACE_ACTION)?;
    require_exact_tag_names(
        event,
        &["p", "discovery-workspace-action"],
        "workspace action",
    )?;
    let relay_pubkey = parse_pubkey(required_scalar_tag(event, "p")?)?;
    let tuple = required_tuple_tag(event, "discovery-workspace-action", 5)?;
    if tuple[1] != "1" {
        return Err(DiscoveryWorkspaceSdkError::InvalidTag(
            "discovery-workspace-action",
        ));
    }
    let operation = parse_operation(&tuple[2])?;
    let content: WorkspaceActionContent =
        parse_canonical_content(&event.content, "workspace action")?;
    if content.schema != ACTION_SCHEMA
        || content.request.payload.operation() != operation
        || content.request.request_id.to_string() != tuple[3]
        || content.request.idempotency_key.to_string() != tuple[4]
        || content.request.validate().is_err()
    {
        return Err(DiscoveryWorkspaceSdkError::TagContentMismatch(
            "workspace action",
        ));
    }
    Ok(ParsedDiscoveryWorkspaceAction {
        relay_pubkey,
        request: content.request,
    })
}

/// Build the exact relay-signable, requester-private workspace receipt.
pub fn build_discovery_workspace_receipt(
    actor_pubkey: PublicKey,
    action_event_id: EventId,
    receipt: &DiscoveryWorkspaceReceipt,
) -> Result<EventBuilder, DiscoveryWorkspaceSdkError> {
    validate_receipt(receipt)?;
    let actor = actor_pubkey.to_hex();
    let action = action_event_id.to_hex();
    let request_id = receipt.request_id.to_string();
    let idempotency_key = receipt.idempotency_key.to_string();
    let content = WorkspaceReceiptContent {
        schema: RECEIPT_SCHEMA.to_owned(),
        receipt: receipt.clone(),
    };
    let tags = [
        scalar_tag("p", &actor)?,
        tuple_tag(&["e", &action, "", "discovery-workspace-action"])?,
        tuple_tag(&[
            "discovery-workspace-receipt",
            "1",
            operation_tag(receipt.operation),
            &request_id,
            &idempotency_key,
        ])?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_DISCOVERY_WORKSPACE_RECEIPT as u16),
        canonical_content(&content, "workspace receipt")?,
    )
    .tags(tags))
}

/// Parse the exact relay-authored Discovery workspace receipt envelope.
pub fn parse_discovery_workspace_receipt(
    event: &Event,
) -> Result<ParsedDiscoveryWorkspaceReceipt, DiscoveryWorkspaceSdkError> {
    require_kind(event, KIND_DISCOVERY_WORKSPACE_RECEIPT)?;
    require_exact_tag_names(
        event,
        &["p", "e", "discovery-workspace-receipt"],
        "workspace receipt",
    )?;
    let actor_pubkey = parse_pubkey(required_scalar_tag(event, "p")?)?;
    let action = required_tuple_tag(event, "e", 4)?;
    if !action[2].is_empty() || action[3] != "discovery-workspace-action" {
        return Err(DiscoveryWorkspaceSdkError::InvalidTag("e"));
    }
    let action_event_id = EventId::from_hex(&action[1])
        .map_err(|_| DiscoveryWorkspaceSdkError::InvalidEnvelope("workspace receipt"))?;
    let tuple = required_tuple_tag(event, "discovery-workspace-receipt", 5)?;
    if tuple[1] != "1" {
        return Err(DiscoveryWorkspaceSdkError::InvalidTag(
            "discovery-workspace-receipt",
        ));
    }
    let operation = parse_operation(&tuple[2])?;
    let content: WorkspaceReceiptContent =
        parse_canonical_content(&event.content, "workspace receipt")?;
    if content.schema != RECEIPT_SCHEMA
        || content.receipt.operation != operation
        || content.receipt.request_id.to_string() != tuple[3]
        || content.receipt.idempotency_key.to_string() != tuple[4]
    {
        return Err(DiscoveryWorkspaceSdkError::TagContentMismatch(
            "workspace receipt",
        ));
    }
    validate_receipt(&content.receipt)?;
    Ok(ParsedDiscoveryWorkspaceReceipt {
        actor_pubkey,
        action_event_id,
        receipt: content.receipt,
    })
}

fn validate_receipt(receipt: &DiscoveryWorkspaceReceipt) -> Result<(), DiscoveryWorkspaceSdkError> {
    if receipt.request_id.is_nil() || receipt.idempotency_key.is_nil() {
        return Err(DiscoveryWorkspaceSdkError::InvalidEnvelope(
            "workspace receipt",
        ));
    }
    let matches = matches!(
        (receipt.operation, &receipt.result),
        (
            DiscoveryWorkspaceOperation::Access,
            DiscoveryWorkspaceResult::Access { .. }
        ) | (
            DiscoveryWorkspaceOperation::CreateCampaign | DiscoveryWorkspaceOperation::GetCampaign,
            DiscoveryWorkspaceResult::Campaign { .. }
        ) | (
            DiscoveryWorkspaceOperation::ListCampaigns,
            DiscoveryWorkspaceResult::Campaigns { .. }
        ) | (
            DiscoveryWorkspaceOperation::ListLeads,
            DiscoveryWorkspaceResult::Leads { .. }
        )
    );
    if !matches {
        return Err(DiscoveryWorkspaceSdkError::InvalidEnvelope(
            "workspace receipt",
        ));
    }
    Ok(())
}

fn operation_tag(operation: DiscoveryWorkspaceOperation) -> &'static str {
    match operation {
        DiscoveryWorkspaceOperation::Access => "access",
        DiscoveryWorkspaceOperation::CreateCampaign => "create_campaign",
        DiscoveryWorkspaceOperation::GetCampaign => "get_campaign",
        DiscoveryWorkspaceOperation::ListCampaigns => "list_campaigns",
        DiscoveryWorkspaceOperation::ListLeads => "list_leads",
    }
}

fn parse_operation(value: &str) -> Result<DiscoveryWorkspaceOperation, DiscoveryWorkspaceSdkError> {
    match value {
        "access" => Ok(DiscoveryWorkspaceOperation::Access),
        "create_campaign" => Ok(DiscoveryWorkspaceOperation::CreateCampaign),
        "get_campaign" => Ok(DiscoveryWorkspaceOperation::GetCampaign),
        "list_campaigns" => Ok(DiscoveryWorkspaceOperation::ListCampaigns),
        "list_leads" => Ok(DiscoveryWorkspaceOperation::ListLeads),
        _ => Err(DiscoveryWorkspaceSdkError::InvalidEnvelope(
            "workspace action",
        )),
    }
}

fn canonical_content<T: Serialize>(
    value: &T,
    entity: &'static str,
) -> Result<String, DiscoveryWorkspaceSdkError> {
    let value = serde_json::to_value(value)
        .map_err(|_| DiscoveryWorkspaceSdkError::InvalidContent(entity))?;
    canonical_json(&value).map_err(|_| DiscoveryWorkspaceSdkError::InvalidContent(entity))
}

fn parse_canonical_content<T: DeserializeOwned + Serialize>(
    content: &str,
    entity: &'static str,
) -> Result<T, DiscoveryWorkspaceSdkError> {
    let parsed = serde_json::from_str(content)
        .map_err(|_| DiscoveryWorkspaceSdkError::InvalidContent(entity))?;
    if canonical_content(&parsed, entity)? != content {
        return Err(DiscoveryWorkspaceSdkError::InvalidContent(entity));
    }
    Ok(parsed)
}

fn scalar_tag(name: &str, value: &str) -> Result<Tag, DiscoveryWorkspaceSdkError> {
    Tag::parse([name, value]).map_err(|_| DiscoveryWorkspaceSdkError::InvalidTag("scalar"))
}

fn tuple_tag(values: &[&str]) -> Result<Tag, DiscoveryWorkspaceSdkError> {
    Tag::parse(values.iter().copied()).map_err(|_| DiscoveryWorkspaceSdkError::InvalidTag("tuple"))
}

fn require_kind(event: &Event, expected: u32) -> Result<(), DiscoveryWorkspaceSdkError> {
    let actual = event.kind.as_u16() as u32;
    if actual != expected {
        return Err(DiscoveryWorkspaceSdkError::UnexpectedKind { expected, actual });
    }
    Ok(())
}

fn parse_pubkey(value: &str) -> Result<PublicKey, DiscoveryWorkspaceSdkError> {
    PublicKey::from_str(value)
        .map_err(|_| DiscoveryWorkspaceSdkError::InvalidEnvelope("workspace action"))
}

fn require_exact_tag_names(
    event: &Event,
    expected: &[&str],
    entity: &'static str,
) -> Result<(), DiscoveryWorkspaceSdkError> {
    if event.tags.len() != expected.len() {
        return Err(DiscoveryWorkspaceSdkError::UnexpectedTag(entity));
    }
    let mut actual = event
        .tags
        .iter()
        .filter_map(|tag| tag.as_slice().first().map(String::as_str))
        .collect::<Vec<_>>();
    actual.sort_unstable();
    let mut wanted = expected.to_vec();
    wanted.sort_unstable();
    if actual != wanted {
        return Err(DiscoveryWorkspaceSdkError::UnexpectedTag(entity));
    }
    Ok(())
}

fn required_scalar_tag<'a>(
    event: &'a Event,
    name: &'static str,
) -> Result<&'a str, DiscoveryWorkspaceSdkError> {
    let tag = required_tuple_tag(event, name, 2)?;
    Ok(&tag[1])
}

fn required_tuple_tag<'a>(
    event: &'a Event,
    name: &'static str,
    length: usize,
) -> Result<&'a [String], DiscoveryWorkspaceSdkError> {
    let matches = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
        .collect::<Vec<_>>();
    if matches.len() != 1 || matches[0].as_slice().len() != length {
        return Err(DiscoveryWorkspaceSdkError::InvalidTag(name));
    }
    Ok(matches[0].as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::discovery_workspace::{
        DiscoveryCampaignInput, DiscoveryCampaignListRequest, DiscoveryWorkspaceActionPayload,
    };
    use nostr::Keys;
    use uuid::Uuid;

    fn create_request() -> DiscoveryWorkspaceRequest {
        DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::CreateCampaign {
                campaign: DiscoveryCampaignInput {
                    campaign_id: Uuid::new_v4(),
                    name: "Sandton dentists".into(),
                    industry_id: "healthcare".into(),
                    industry_name: "Healthcare".into(),
                    vertical_id: "dentists".into(),
                    vertical_name: "Dentists".into(),
                    query: "dentists".into(),
                    location: "Sandton, Johannesburg, South Africa".into(),
                    target: 3,
                    description: None,
                    language: "en".into(),
                    region: Some("ZA".into()),
                },
            },
        }
    }

    #[test]
    fn action_round_trips_with_exact_private_tags() {
        let relay = Keys::generate();
        let actor = Keys::generate();
        let request = create_request();
        let event = build_discovery_workspace_action(relay.public_key(), &request)
            .expect("build action")
            .sign_with_keys(&actor)
            .expect("sign action");
        let parsed = parse_discovery_workspace_action(&event).expect("parse action");
        assert_eq!(parsed.relay_pubkey, relay.public_key());
        assert_eq!(parsed.request, request);
        assert_eq!(event.tags.len(), 2);
    }

    #[test]
    fn list_action_is_bounded_before_signing() {
        let request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::ListCampaigns {
                request: DiscoveryCampaignListRequest {
                    industry_id: None,
                    vertical_id: None,
                    offset: 0,
                    limit: 101,
                },
            },
        };
        assert!(build_discovery_workspace_action(Keys::generate().public_key(), &request).is_err());
    }
}
