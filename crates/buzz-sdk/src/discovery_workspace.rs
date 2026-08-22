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

const ACTION_SCHEMA_V1: &str = "colony.discovery-workspace-action/v1";
const ACTION_SCHEMA_V2: &str = "colony.discovery-workspace-action/v2";
const ACTION_SCHEMA_V3: &str = "colony.discovery-workspace-action/v3";
const RECEIPT_SCHEMA_V1: &str = "colony.discovery-workspace-receipt/v1";
const RECEIPT_SCHEMA_V2: &str = "colony.discovery-workspace-receipt/v2";
const RECEIPT_SCHEMA_V3: &str = "colony.discovery-workspace-receipt/v3";

/// Version of the strict Discovery workspace wire envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryWorkspaceWireVersion {
    /// Released Outscraper-only contract.
    V1,
    /// Multi-source Campaign and provenance contract.
    V2,
    /// Colony-funded Campaign budget contract.
    V3,
}

impl DiscoveryWorkspaceWireVersion {
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

/// A strict workspace action together with the relay named by its `p` tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryWorkspaceAction {
    /// Relay public key addressed by the actor.
    pub relay_pubkey: PublicKey,
    /// Exact signed wire version, used to reply compatibly during upgrades.
    pub wire_version: DiscoveryWorkspaceWireVersion,
    /// Validated request.
    pub request: DiscoveryWorkspaceRequest,
}

/// A strict relay receipt together with its private routing references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryWorkspaceReceipt {
    /// Exact relay-authored wire version.
    pub wire_version: DiscoveryWorkspaceWireVersion,
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
    build_discovery_workspace_action_for_version(
        DiscoveryWorkspaceWireVersion::V3,
        relay_pubkey,
        request,
    )
}

fn build_discovery_workspace_action_for_version(
    wire_version: DiscoveryWorkspaceWireVersion,
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkspaceRequest,
) -> Result<EventBuilder, DiscoveryWorkspaceSdkError> {
    request
        .validate()
        .map_err(|_| DiscoveryWorkspaceSdkError::InvalidEnvelope("workspace action"))?;
    if !request_supported_by_wire_version(wire_version, request) {
        return Err(DiscoveryWorkspaceSdkError::InvalidEnvelope(
            "workspace action",
        ));
    }
    let operation = operation_tag(request.payload.operation());
    let request_id = request.request_id.to_string();
    let idempotency_key = request.idempotency_key.to_string();
    let relay = relay_pubkey.to_hex();
    let content = WorkspaceActionContent {
        schema: wire_version.action_schema().to_owned(),
        request: request.clone(),
    };
    let tags = [
        scalar_tag("p", &relay)?,
        tuple_tag(&[
            "discovery-workspace-action",
            wire_version.tag(),
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
    let wire_version = parse_wire_version(&tuple[1], "discovery-workspace-action")?;
    let operation = parse_operation(&tuple[2])?;
    let content: WorkspaceActionContent =
        parse_canonical_content(&event.content, "workspace action")?;
    if content.schema != wire_version.action_schema()
        || content.request.payload.operation() != operation
        || content.request.request_id.to_string() != tuple[3]
        || content.request.idempotency_key.to_string() != tuple[4]
        || content.request.validate().is_err()
    {
        return Err(DiscoveryWorkspaceSdkError::TagContentMismatch(
            "workspace action",
        ));
    }
    if !request_supported_by_wire_version(wire_version, &content.request) {
        return Err(DiscoveryWorkspaceSdkError::InvalidEnvelope(
            "workspace action",
        ));
    }
    Ok(ParsedDiscoveryWorkspaceAction {
        relay_pubkey,
        wire_version,
        request: content.request,
    })
}

/// Build the exact relay-signable, requester-private workspace receipt.
pub fn build_discovery_workspace_receipt(
    actor_pubkey: PublicKey,
    action_event_id: EventId,
    receipt: &DiscoveryWorkspaceReceipt,
) -> Result<EventBuilder, DiscoveryWorkspaceSdkError> {
    build_discovery_workspace_receipt_for_version(
        DiscoveryWorkspaceWireVersion::V3,
        actor_pubkey,
        action_event_id,
        receipt,
    )
}

/// Build a relay receipt matching the exact action wire version.
pub fn build_discovery_workspace_receipt_for_version(
    wire_version: DiscoveryWorkspaceWireVersion,
    actor_pubkey: PublicKey,
    action_event_id: EventId,
    receipt: &DiscoveryWorkspaceReceipt,
) -> Result<EventBuilder, DiscoveryWorkspaceSdkError> {
    validate_receipt(receipt)?;
    if !operation_supported_by_wire_version(wire_version, receipt.operation) {
        return Err(DiscoveryWorkspaceSdkError::InvalidEnvelope(
            "workspace receipt",
        ));
    }
    let actor = actor_pubkey.to_hex();
    let action = action_event_id.to_hex();
    let request_id = receipt.request_id.to_string();
    let idempotency_key = receipt.idempotency_key.to_string();
    let content = WorkspaceReceiptContent {
        schema: wire_version.receipt_schema().to_owned(),
        receipt: receipt_for_wire_version(wire_version, receipt),
    };
    let tags = [
        scalar_tag("p", &actor)?,
        tuple_tag(&["e", &action, "", "discovery-workspace-action"])?,
        tuple_tag(&[
            "discovery-workspace-receipt",
            wire_version.tag(),
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
    let wire_version = parse_wire_version(&tuple[1], "discovery-workspace-receipt")?;
    let operation = parse_operation(&tuple[2])?;
    let content: WorkspaceReceiptContent =
        parse_canonical_content(&event.content, "workspace receipt")?;
    if content.schema != wire_version.receipt_schema()
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
        wire_version,
        actor_pubkey,
        action_event_id,
        receipt: content.receipt,
    })
}

fn request_supported_by_wire_version(
    wire_version: DiscoveryWorkspaceWireVersion,
    request: &DiscoveryWorkspaceRequest,
) -> bool {
    if wire_version == DiscoveryWorkspaceWireVersion::V3 {
        return true;
    }
    match &request.payload {
        buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::CreateCampaign {
            campaign,
        } => match campaign.as_ref() {
            buzz_core::discovery_workspace::DiscoveryCampaignCreateInput::Current(_) => true,
            buzz_core::discovery_workspace::DiscoveryCampaignCreateInput::Legacy(campaign) => {
                wire_version == DiscoveryWorkspaceWireVersion::V2
                    || campaign.source_config.is_default()
            }
        },
        buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::UpdateCampaignSources {
            ..
        }
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::ListLeadCounts
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::GetLead { .. }
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::UpdateLead { .. } => {
            wire_version == DiscoveryWorkspaceWireVersion::V2
        }
        buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::ApproveCampaignBudget {
            ..
        }
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::PauseCampaignBudget {
            ..
        }
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::RevokeCampaignBudget {
            ..
        }
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::GetCampaignBudget {
            ..
        } => false,
        buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::Access
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::GetCampaign { .. }
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::ListCampaigns { .. }
        | buzz_core::discovery_workspace::DiscoveryWorkspaceActionPayload::ListLeads { .. } => true,
    }
}

fn operation_supported_by_wire_version(
    wire_version: DiscoveryWorkspaceWireVersion,
    operation: DiscoveryWorkspaceOperation,
) -> bool {
    match wire_version {
        DiscoveryWorkspaceWireVersion::V3 => true,
        DiscoveryWorkspaceWireVersion::V2 => !matches!(
            operation,
            DiscoveryWorkspaceOperation::ApproveCampaignBudget
                | DiscoveryWorkspaceOperation::PauseCampaignBudget
                | DiscoveryWorkspaceOperation::RevokeCampaignBudget
                | DiscoveryWorkspaceOperation::GetCampaignBudget
        ),
        DiscoveryWorkspaceWireVersion::V1 => matches!(
            operation,
            DiscoveryWorkspaceOperation::Access
                | DiscoveryWorkspaceOperation::CreateCampaign
                | DiscoveryWorkspaceOperation::GetCampaign
                | DiscoveryWorkspaceOperation::ListCampaigns
                | DiscoveryWorkspaceOperation::ListLeads
        ),
    }
}

fn receipt_for_wire_version(
    wire_version: DiscoveryWorkspaceWireVersion,
    receipt: &DiscoveryWorkspaceReceipt,
) -> DiscoveryWorkspaceReceipt {
    let mut compatible = receipt.clone();
    if wire_version != DiscoveryWorkspaceWireVersion::V3 {
        match &mut compatible.result {
            DiscoveryWorkspaceResult::Campaign { campaign } => {
                make_campaign_v1_compatible(campaign)
            }
            DiscoveryWorkspaceResult::Campaigns { page } => {
                for campaign in &mut page.campaigns {
                    make_campaign_v1_compatible(campaign);
                }
            }
            DiscoveryWorkspaceResult::Leads { page } => {
                for lead in &mut page.leads {
                    lead.provider = buzz_core::discovery::DiscoveryProvider::Outscraper;
                }
            }
            DiscoveryWorkspaceResult::Access { .. } => {}
            DiscoveryWorkspaceResult::Budget { .. } => {}
            DiscoveryWorkspaceResult::LeadCounts { .. } => {}
            DiscoveryWorkspaceResult::Lead { .. } => {}
        }
    }
    compatible
}

fn make_campaign_v1_compatible(
    campaign: &mut buzz_core::discovery_workspace::DiscoveryCampaignProjection,
) {
    campaign.source_config = buzz_core::discovery::DiscoverySourceConfig::default();
    campaign.latest_run_sources.clear();
    campaign.budget = None;
}

fn parse_wire_version(
    value: &str,
    tag: &'static str,
) -> Result<DiscoveryWorkspaceWireVersion, DiscoveryWorkspaceSdkError> {
    match value {
        "1" => Ok(DiscoveryWorkspaceWireVersion::V1),
        "2" => Ok(DiscoveryWorkspaceWireVersion::V2),
        "3" => Ok(DiscoveryWorkspaceWireVersion::V3),
        _ => Err(DiscoveryWorkspaceSdkError::InvalidTag(tag)),
    }
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
            DiscoveryWorkspaceOperation::CreateCampaign
                | DiscoveryWorkspaceOperation::UpdateCampaignSources
                | DiscoveryWorkspaceOperation::GetCampaign,
            DiscoveryWorkspaceResult::Campaign { .. }
        ) | (
            DiscoveryWorkspaceOperation::ApproveCampaignBudget
                | DiscoveryWorkspaceOperation::PauseCampaignBudget
                | DiscoveryWorkspaceOperation::RevokeCampaignBudget
                | DiscoveryWorkspaceOperation::GetCampaignBudget,
            DiscoveryWorkspaceResult::Budget { .. }
        ) | (
            DiscoveryWorkspaceOperation::ListCampaigns,
            DiscoveryWorkspaceResult::Campaigns { .. }
        ) | (
            DiscoveryWorkspaceOperation::ListLeads,
            DiscoveryWorkspaceResult::Leads { .. }
        ) | (
            DiscoveryWorkspaceOperation::ListLeadCounts,
            DiscoveryWorkspaceResult::LeadCounts { .. }
        ) | (
            DiscoveryWorkspaceOperation::GetLead | DiscoveryWorkspaceOperation::UpdateLead,
            DiscoveryWorkspaceResult::Lead { .. }
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
        DiscoveryWorkspaceOperation::UpdateCampaignSources => "update_campaign_sources",
        DiscoveryWorkspaceOperation::ApproveCampaignBudget => "approve_campaign_budget",
        DiscoveryWorkspaceOperation::PauseCampaignBudget => "pause_campaign_budget",
        DiscoveryWorkspaceOperation::RevokeCampaignBudget => "revoke_campaign_budget",
        DiscoveryWorkspaceOperation::GetCampaignBudget => "get_campaign_budget",
        DiscoveryWorkspaceOperation::GetCampaign => "get_campaign",
        DiscoveryWorkspaceOperation::ListCampaigns => "list_campaigns",
        DiscoveryWorkspaceOperation::ListLeads => "list_leads",
        DiscoveryWorkspaceOperation::ListLeadCounts => "list_lead_counts",
        DiscoveryWorkspaceOperation::GetLead => "get_lead",
        DiscoveryWorkspaceOperation::UpdateLead => "update_lead",
    }
}

fn parse_operation(value: &str) -> Result<DiscoveryWorkspaceOperation, DiscoveryWorkspaceSdkError> {
    match value {
        "access" => Ok(DiscoveryWorkspaceOperation::Access),
        "create_campaign" => Ok(DiscoveryWorkspaceOperation::CreateCampaign),
        "update_campaign_sources" => Ok(DiscoveryWorkspaceOperation::UpdateCampaignSources),
        "approve_campaign_budget" => Ok(DiscoveryWorkspaceOperation::ApproveCampaignBudget),
        "pause_campaign_budget" => Ok(DiscoveryWorkspaceOperation::PauseCampaignBudget),
        "revoke_campaign_budget" => Ok(DiscoveryWorkspaceOperation::RevokeCampaignBudget),
        "get_campaign_budget" => Ok(DiscoveryWorkspaceOperation::GetCampaignBudget),
        "get_campaign" => Ok(DiscoveryWorkspaceOperation::GetCampaign),
        "list_campaigns" => Ok(DiscoveryWorkspaceOperation::ListCampaigns),
        "list_leads" => Ok(DiscoveryWorkspaceOperation::ListLeads),
        "list_lead_counts" => Ok(DiscoveryWorkspaceOperation::ListLeadCounts),
        "get_lead" => Ok(DiscoveryWorkspaceOperation::GetLead),
        "update_lead" => Ok(DiscoveryWorkspaceOperation::UpdateLead),
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
        DiscoveryCampaignCreateInput, DiscoveryCampaignInput, DiscoveryCampaignListRequest,
        DiscoveryCampaignProjection, DiscoveryWorkspaceActionPayload,
    };
    use chrono::{TimeZone, Utc};
    use nostr::Keys;
    use uuid::Uuid;

    fn create_request() -> DiscoveryWorkspaceRequest {
        DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::CreateCampaign {
                campaign: Box::new(DiscoveryCampaignCreateInput::Legacy(
                    DiscoveryCampaignInput {
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
                        source_config: buzz_core::discovery::DiscoverySourceConfig::default(),
                    },
                )),
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
        assert_eq!(parsed.wire_version, DiscoveryWorkspaceWireVersion::V3);
        assert_eq!(parsed.relay_pubkey, relay.public_key());
        let DiscoveryWorkspaceActionPayload::CreateCampaign {
            campaign: parsed_campaign,
        } = &parsed.request.payload
        else {
            panic!("parsed campaign fixture");
        };
        let DiscoveryWorkspaceActionPayload::CreateCampaign { campaign } = &request.payload else {
            panic!("campaign fixture");
        };
        assert_eq!(parsed_campaign.normalized(), campaign.normalized());
        assert_eq!(event.tags.len(), 2);
    }

    #[test]
    fn released_v1_action_and_receipt_remain_canonical_and_readable() {
        let relay = Keys::generate();
        let actor = Keys::generate();
        let request = create_request();
        let action = build_discovery_workspace_action_for_version(
            DiscoveryWorkspaceWireVersion::V1,
            relay.public_key(),
            &request,
        )
        .expect("build v1 action")
        .sign_with_keys(&actor)
        .expect("sign v1 action");
        assert!(!action.content.contains("source_config"));
        let parsed = parse_discovery_workspace_action(&action).expect("parse v1 action");
        assert_eq!(parsed.wire_version, DiscoveryWorkspaceWireVersion::V1);
        let DiscoveryWorkspaceActionPayload::CreateCampaign {
            campaign: parsed_campaign,
        } = &parsed.request.payload
        else {
            panic!("parsed campaign fixture");
        };
        let DiscoveryWorkspaceActionPayload::CreateCampaign { campaign } = &request.payload else {
            panic!("campaign fixture");
        };
        assert_eq!(parsed_campaign.normalized(), campaign.normalized());

        let DiscoveryWorkspaceActionPayload::CreateCampaign { campaign } = request.payload else {
            panic!("campaign fixture");
        };
        let campaign = campaign.normalized();
        let now = Utc.timestamp_opt(1_800_000_000, 0).single().unwrap();
        let receipt = DiscoveryWorkspaceReceipt {
            operation: DiscoveryWorkspaceOperation::CreateCampaign,
            request_id: request.request_id,
            idempotency_key: request.idempotency_key,
            result: DiscoveryWorkspaceResult::Campaign {
                campaign: Box::new(DiscoveryCampaignProjection {
                    campaign_id: campaign.campaign_id,
                    name: campaign.name,
                    industry_id: campaign.industry_id,
                    industry_name: campaign.industry_name,
                    vertical_id: campaign.vertical_id,
                    vertical_name: campaign.vertical_name,
                    query: campaign.query,
                    location: campaign.location,
                    target: campaign.target,
                    description: campaign.description,
                    language: campaign.language,
                    region: campaign.region,
                    source_config: buzz_core::discovery::DiscoverySourceConfig::default(),
                    lead_count: 0,
                    latest_run: None,
                    latest_run_sources: Vec::new(),
                    budget: None,
                    created_at: now,
                    updated_at: now,
                }),
            },
        };
        let receipt_event = build_discovery_workspace_receipt_for_version(
            DiscoveryWorkspaceWireVersion::V1,
            actor.public_key(),
            action.id,
            &receipt,
        )
        .expect("build v1 receipt")
        .sign_with_keys(&relay)
        .expect("sign v1 receipt");
        assert!(!receipt_event.content.contains("source_config"));
        assert!(!receipt_event.content.contains("latest_run_sources"));
        let parsed_receipt =
            parse_discovery_workspace_receipt(&receipt_event).expect("parse v1 receipt");
        assert_eq!(
            parsed_receipt.wire_version,
            DiscoveryWorkspaceWireVersion::V1
        );
        assert_eq!(parsed_receipt.receipt, receipt);
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

    #[test]
    fn source_update_round_trips_as_a_private_canonical_action() {
        let relay = Keys::generate();
        let actor = Keys::generate();
        let request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::UpdateCampaignSources {
                campaign_id: Uuid::new_v4(),
                source_config: buzz_core::discovery::DiscoverySourceConfig {
                    mode: buzz_core::discovery::DiscoverySourceMode::Concurrent,
                    sources: vec![
                        buzz_core::discovery::DiscoverySource::BraveSearch,
                        buzz_core::discovery::DiscoverySource::ExaSearch,
                    ],
                },
            },
        };
        let event = build_discovery_workspace_action(relay.public_key(), &request)
            .expect("build update")
            .sign_with_keys(&actor)
            .expect("sign update");
        let parsed = parse_discovery_workspace_action(&event).expect("parse update");
        assert_eq!(parsed.request, request);
        assert!(event.content.contains("update_campaign_sources"));
        assert!(!event.content.contains("api_key"));
    }

    #[test]
    fn list_lead_counts_is_v2_only() {
        let relay = Keys::generate().public_key();
        let request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::ListLeadCounts,
        };
        assert!(
            build_discovery_workspace_action_for_version(
                DiscoveryWorkspaceWireVersion::V2,
                relay,
                &request,
            )
            .is_ok(),
            "v2 must carry the new operation"
        );
        assert!(
            build_discovery_workspace_action_for_version(
                DiscoveryWorkspaceWireVersion::V1,
                relay,
                &request,
            )
            .is_err(),
            "v1 must reject an operation it cannot represent"
        );
    }

    #[test]
    fn lead_update_round_trips_as_a_private_canonical_action() {
        let relay = Keys::generate();
        let actor = Keys::generate();
        let request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::UpdateLead {
                lead_id: Uuid::new_v4(),
                input: buzz_core::discovery_workspace::DiscoveryLeadUpdateInput {
                    website: Some("https://acme.example".into()),
                    email: None,
                    phone: None,
                    linkedin_url: None,
                    contact_name: None,
                    contact_title: None,
                    notes: None,
                    score: None,
                    owner_persona_id: None,
                    status: Some(buzz_core::discovery_workspace::DiscoveryLeadStatus::Accepted),
                },
            },
        };
        let event = build_discovery_workspace_action(relay.public_key(), &request)
            .expect("build update lead")
            .sign_with_keys(&actor)
            .expect("sign update lead");
        let parsed = parse_discovery_workspace_action(&event).expect("parse update lead");
        assert_eq!(parsed.request, request);
    }
}
