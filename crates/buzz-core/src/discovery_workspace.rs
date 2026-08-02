//! Strict private contracts for Colony Discovery campaigns and Leads.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::discovery::{DiscoveryBusinessSearchSpec, DiscoveryRunProjection};

const MAX_NAME_BYTES: usize = 256;
const MAX_TAXONOMY_ID_BYTES: usize = 128;
const MAX_DESCRIPTION_BYTES: usize = 2_048;

/// Why a Discovery workspace request was refused before persistence.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DiscoveryWorkspaceValidationError {
    /// A named field is missing, malformed, untrimmed, or outside its bound.
    #[error("invalid Discovery workspace field: {0}")]
    InvalidField(&'static str),
}

/// Operation requested through a private signed Discovery workspace action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryWorkspaceOperation {
    /// Read whether the current workspace has an active entitlement.
    Access,
    /// Create one immutable Businesses campaign.
    CreateCampaign,
    /// Read one campaign and its latest run/count projection.
    GetCampaign,
    /// List campaigns in the workspace.
    ListCampaigns,
    /// List normalized retained Businesses Leads.
    ListLeads,
}

/// Immutable input used to create a live Businesses campaign.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryCampaignInput {
    /// Stable campaign identifier chosen once by the caller.
    pub campaign_id: Uuid,
    /// Human-readable campaign name.
    pub name: String,
    /// Stable taxonomy industry identifier.
    pub industry_id: String,
    /// Industry label snapshotted for durable display.
    pub industry_name: String,
    /// Stable taxonomy vertical identifier.
    pub vertical_id: String,
    /// Vertical label snapshotted for durable display.
    pub vertical_name: String,
    /// Provider search phrase.
    pub query: String,
    /// Human-readable geography appended to the provider query.
    pub location: String,
    /// Maximum unique new Leads requested for the campaign.
    pub target: u16,
    /// Optional user-authored ideal-customer description.
    pub description: Option<String>,
    /// ISO 639-1 provider language code.
    pub language: String,
    /// Optional ISO 3166-1 alpha-2 provider country code.
    pub region: Option<String>,
}

impl DiscoveryCampaignInput {
    /// Validate the strict, non-secret campaign shape.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        validate_uuid(self.campaign_id, "campaign_id")?;
        validate_text(&self.name, MAX_NAME_BYTES, "name")?;
        validate_taxonomy_id(&self.industry_id, "industry_id")?;
        validate_text(&self.industry_name, MAX_NAME_BYTES, "industry_name")?;
        validate_taxonomy_id(&self.vertical_id, "vertical_id")?;
        validate_text(&self.vertical_name, MAX_NAME_BYTES, "vertical_name")?;
        if let Some(description) = &self.description {
            validate_text(description, MAX_DESCRIPTION_BYTES, "description")?;
        }
        self.business_search()
            .validate()
            .map_err(|_| DiscoveryWorkspaceValidationError::InvalidField("business_search"))
    }

    /// Produce the exact immutable run search accepted for this campaign.
    pub fn business_search(&self) -> DiscoveryBusinessSearchSpec {
        DiscoveryBusinessSearchSpec {
            query: self.query.clone(),
            location: self.location.clone(),
            limit: self.target,
            language: self.language.clone(),
            region: self.region.clone(),
        }
    }
}

/// Bounded campaign list filters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryCampaignListRequest {
    /// Optional taxonomy industry filter.
    pub industry_id: Option<String>,
    /// Optional taxonomy vertical filter.
    pub vertical_id: Option<String>,
    /// Zero-based row offset.
    pub offset: u32,
    /// Page size, from 1 through 100.
    pub limit: u16,
}

impl DiscoveryCampaignListRequest {
    /// Validate filters and page bounds.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        if let Some(value) = &self.industry_id {
            validate_taxonomy_id(value, "industry_id")?;
        }
        if let Some(value) = &self.vertical_id {
            validate_taxonomy_id(value, "vertical_id")?;
        }
        validate_page(self.offset, self.limit)
    }
}

/// Bounded Lead list filters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadListRequest {
    /// Optional campaign that first retained each Lead.
    pub campaign_id: Option<Uuid>,
    /// Optional taxonomy industry filter.
    pub industry_id: Option<String>,
    /// Optional taxonomy vertical filter.
    pub vertical_id: Option<String>,
    /// Zero-based row offset.
    pub offset: u32,
    /// Page size, from 1 through 100.
    pub limit: u16,
}

impl DiscoveryLeadListRequest {
    /// Validate filters and page bounds.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        if let Some(value) = self.campaign_id {
            validate_uuid(value, "campaign_id")?;
        }
        if let Some(value) = &self.industry_id {
            validate_taxonomy_id(value, "industry_id")?;
        }
        if let Some(value) = &self.vertical_id {
            validate_taxonomy_id(value, "vertical_id")?;
        }
        validate_page(self.offset, self.limit)
    }
}

/// Operation-specific payload of a signed workspace action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum DiscoveryWorkspaceActionPayload {
    /// Read access without exposing any workspace records.
    Access,
    /// Create one live Businesses campaign.
    CreateCampaign {
        /// Complete immutable campaign input.
        campaign: DiscoveryCampaignInput,
    },
    /// Read one campaign.
    GetCampaign {
        /// Stable campaign identifier.
        campaign_id: Uuid,
    },
    /// List campaigns.
    ListCampaigns {
        /// Bounded filters and pagination.
        request: DiscoveryCampaignListRequest,
    },
    /// List retained Leads.
    ListLeads {
        /// Bounded filters and pagination.
        request: DiscoveryLeadListRequest,
    },
}

impl DiscoveryWorkspaceActionPayload {
    /// Return the operation represented by this payload.
    pub const fn operation(&self) -> DiscoveryWorkspaceOperation {
        match self {
            Self::Access => DiscoveryWorkspaceOperation::Access,
            Self::CreateCampaign { .. } => DiscoveryWorkspaceOperation::CreateCampaign,
            Self::GetCampaign { .. } => DiscoveryWorkspaceOperation::GetCampaign,
            Self::ListCampaigns { .. } => DiscoveryWorkspaceOperation::ListCampaigns,
            Self::ListLeads { .. } => DiscoveryWorkspaceOperation::ListLeads,
        }
    }

    /// Validate every operation-specific field.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        match self {
            Self::Access => Ok(()),
            Self::CreateCampaign { campaign } => campaign.validate(),
            Self::GetCampaign { campaign_id } => validate_uuid(*campaign_id, "campaign_id"),
            Self::ListCampaigns { request } => request.validate(),
            Self::ListLeads { request } => request.validate(),
        }
    }
}

/// Complete validated request carried by a signed workspace action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkspaceRequest {
    /// Unique command-attempt identifier.
    pub request_id: Uuid,
    /// Stable retry key for this logical operation.
    pub idempotency_key: Uuid,
    /// Operation-specific payload.
    pub payload: DiscoveryWorkspaceActionPayload,
}

impl DiscoveryWorkspaceRequest {
    /// Validate identifiers and operation-specific fields.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        validate_uuid(self.request_id, "request_id")?;
        validate_uuid(self.idempotency_key, "idempotency_key")?;
        self.payload.validate()
    }
}

/// Relay-owned campaign projection safe for an entitled requester.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryCampaignProjection {
    /// Stable campaign identifier.
    pub campaign_id: Uuid,
    /// Human-readable campaign name.
    pub name: String,
    /// Stable taxonomy industry identifier.
    pub industry_id: String,
    /// Snapshotted industry label.
    pub industry_name: String,
    /// Stable taxonomy vertical identifier.
    pub vertical_id: String,
    /// Snapshotted vertical label.
    pub vertical_name: String,
    /// Immutable provider search phrase.
    pub query: String,
    /// Immutable provider geography.
    pub location: String,
    /// Requested unique Lead target.
    pub target: u16,
    /// Optional ideal-customer description.
    pub description: Option<String>,
    /// Provider language code.
    pub language: String,
    /// Optional provider country code.
    pub region: Option<String>,
    /// Count of unique Leads first retained by this campaign.
    pub lead_count: u32,
    /// Latest run, when the campaign has been executed.
    pub latest_run: Option<DiscoveryRunProjection>,
    /// Creation time.
    pub created_at: DateTime<Utc>,
    /// Last campaign or run update time.
    pub updated_at: DateTime<Utc>,
}

/// Normalized provider-neutral business Lead projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryBusinessLeadProjection {
    /// Stable workspace business identifier.
    pub lead_id: Uuid,
    /// Campaign that first retained this Lead.
    pub campaign_id: Uuid,
    /// Taxonomy industry inherited from the first campaign.
    pub industry_id: String,
    /// Taxonomy vertical inherited from the first campaign.
    pub vertical_id: String,
    /// Business name.
    pub name: String,
    /// Public website, when returned.
    pub website: Option<String>,
    /// Public phone, when returned.
    pub phone: Option<String>,
    /// Full public address, when returned.
    pub full_address: Option<String>,
    /// City, when returned.
    pub city: Option<String>,
    /// State or province, when returned.
    pub state: Option<String>,
    /// Country, when returned.
    pub country: Option<String>,
    /// Primary category, when returned.
    pub category: Option<String>,
    /// Provider-neutral subtype labels.
    pub subtypes: Vec<String>,
    /// Rating in hundredths, from zero through five hundred.
    pub rating_hundredths: Option<u16>,
    /// Public review count.
    pub reviews_count: Option<u64>,
    /// Public source page.
    pub source_url: Option<String>,
    /// Public business image.
    pub image_url: Option<String>,
    /// Time the unique business was first retained.
    pub added_at: DateTime<Utc>,
}

/// Bounded page of campaign projections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryCampaignPage {
    /// Campaigns in stable newest-first order.
    pub campaigns: Vec<DiscoveryCampaignProjection>,
    /// Total matching campaigns.
    pub total: u32,
    /// Zero-based row offset returned.
    pub offset: u32,
    /// Requested page size.
    pub limit: u16,
}

/// Bounded page of Lead projections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadPage {
    /// Leads in stable newest-first order.
    pub leads: Vec<DiscoveryBusinessLeadProjection>,
    /// Total matching Leads.
    pub total: u32,
    /// Zero-based row offset returned.
    pub offset: u32,
    /// Requested page size.
    pub limit: u16,
}

/// Private result returned in a relay-signed workspace receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum DiscoveryWorkspaceResult {
    /// Current commercial access state.
    Access {
        /// Whether live Discovery is currently active.
        active: bool,
    },
    /// One campaign created or fetched.
    Campaign {
        /// Complete entitled campaign projection.
        campaign: Box<DiscoveryCampaignProjection>,
    },
    /// Bounded campaign page.
    Campaigns {
        /// Complete entitled campaign page.
        page: DiscoveryCampaignPage,
    },
    /// Bounded Lead page.
    Leads {
        /// Complete entitled Lead page.
        page: DiscoveryLeadPage,
    },
}

/// Public content of a relay-signed, requester-private workspace receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkspaceReceipt {
    /// Operation processed by the relay.
    pub operation: DiscoveryWorkspaceOperation,
    /// Command-attempt identifier copied from the action.
    pub request_id: Uuid,
    /// Stable retry key copied from the action.
    pub idempotency_key: Uuid,
    /// Strict operation result.
    pub result: DiscoveryWorkspaceResult,
}

fn validate_page(offset: u32, limit: u16) -> Result<(), DiscoveryWorkspaceValidationError> {
    if limit == 0 || limit > 100 || offset > 1_000_000 {
        return Err(DiscoveryWorkspaceValidationError::InvalidField("page"));
    }
    Ok(())
}

fn validate_uuid(
    value: Uuid,
    field: &'static str,
) -> Result<(), DiscoveryWorkspaceValidationError> {
    if value.is_nil() {
        Err(DiscoveryWorkspaceValidationError::InvalidField(field))
    } else {
        Ok(())
    }
}

fn validate_text(
    value: &str,
    max_bytes: usize,
    field: &'static str,
) -> Result<(), DiscoveryWorkspaceValidationError> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(DiscoveryWorkspaceValidationError::InvalidField(field));
    }
    Ok(())
}

fn validate_taxonomy_id(
    value: &str,
    field: &'static str,
) -> Result<(), DiscoveryWorkspaceValidationError> {
    if value.is_empty()
        || value.len() > MAX_TAXONOMY_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(DiscoveryWorkspaceValidationError::InvalidField(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn campaign() -> DiscoveryCampaignInput {
        DiscoveryCampaignInput {
            campaign_id: Uuid::new_v4(),
            name: "Sandton dentists".into(),
            industry_id: "healthcare".into(),
            industry_name: "Healthcare".into(),
            vertical_id: "dentists".into(),
            vertical_name: "Dentists".into(),
            query: "dentists".into(),
            location: "Sandton, Johannesburg, South Africa".into(),
            target: 100,
            description: Some("Independent dental practices".into()),
            language: "en".into(),
            region: Some("ZA".into()),
        }
    }

    #[test]
    fn campaign_is_strict_and_reuses_run_search_validation() {
        let valid = campaign();
        assert_eq!(valid.validate(), Ok(()));
        assert_eq!(valid.business_search().limit, valid.target);

        let invalid = DiscoveryCampaignInput {
            vertical_id: "Dentists".into(),
            ..valid
        };
        assert_eq!(
            invalid.validate(),
            Err(DiscoveryWorkspaceValidationError::InvalidField(
                "vertical_id"
            ))
        );
    }

    #[test]
    fn list_requests_are_bounded() {
        let valid = DiscoveryLeadListRequest {
            campaign_id: None,
            industry_id: None,
            vertical_id: None,
            offset: 0,
            limit: 100,
        };
        assert_eq!(valid.validate(), Ok(()));
        assert!(DiscoveryLeadListRequest {
            limit: 101,
            ..valid
        }
        .validate()
        .is_err());
    }

    #[test]
    fn action_round_trip_denies_unknown_fields() {
        let request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::CreateCampaign {
                campaign: campaign(),
            },
        };
        let value = serde_json::to_value(&request).expect("serialize request");
        let decoded: DiscoveryWorkspaceRequest =
            serde_json::from_value(value).expect("decode request");
        assert_eq!(decoded, request);
        assert_eq!(decoded.validate(), Ok(()));
    }
}
