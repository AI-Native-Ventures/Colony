//! Strict private contracts for Colony Discovery campaigns and Leads.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::discovery::{
    DiscoveryBusinessSearchSpec, DiscoveryProvider, DiscoveryRunProjection, DiscoverySourceConfig,
};
use crate::discovery_worker::DiscoveryRunSourceProjection;
use crate::party::{RelationshipKind, RelationshipStatus};

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
    /// Replace the mutable source plan for future Campaign runs.
    UpdateCampaignSources,
    /// Read one campaign and its latest run/count projection.
    GetCampaign,
    /// List campaigns in the workspace.
    ListCampaigns,
    /// List normalized retained Businesses Leads.
    ListLeads,
    /// List retained-Lead counts per taxonomy row.
    ListLeadCounts,
    /// Read one retained Lead with its editable profile.
    GetLead,
    /// Update one retained Lead's editable profile and funnel status.
    UpdateLead,
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
    /// Sources and execution mode used by future Campaign runs.
    #[serde(default, skip_serializing_if = "DiscoverySourceConfig::is_default")]
    pub source_config: DiscoverySourceConfig,
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
            .map_err(|_| DiscoveryWorkspaceValidationError::InvalidField("business_search"))?;
        self.source_config
            .validate()
            .map_err(|_| DiscoveryWorkspaceValidationError::InvalidField("source_config"))
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
    /// Optional funnel status filter.
    pub status: Option<DiscoveryLeadStatus>,
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
        campaign: Box<DiscoveryCampaignInput>,
    },
    /// Replace the source plan used by future runs of one Campaign.
    UpdateCampaignSources {
        /// Stable Campaign identifier.
        campaign_id: Uuid,
        /// Complete replacement source configuration.
        source_config: DiscoverySourceConfig,
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
    /// List retained-Lead counts per taxonomy row.
    ListLeadCounts,
    /// Read one retained Lead with its editable profile.
    GetLead {
        /// Stable observation identifier.
        lead_id: Uuid,
    },
    /// Update one retained Lead's editable profile and funnel status.
    UpdateLead {
        /// Stable observation identifier.
        lead_id: Uuid,
        /// Complete replacement profile fields.
        input: DiscoveryLeadUpdateInput,
    },
}

impl DiscoveryWorkspaceActionPayload {
    /// Return the operation represented by this payload.
    pub const fn operation(&self) -> DiscoveryWorkspaceOperation {
        match self {
            Self::Access => DiscoveryWorkspaceOperation::Access,
            Self::CreateCampaign { .. } => DiscoveryWorkspaceOperation::CreateCampaign,
            Self::UpdateCampaignSources { .. } => {
                DiscoveryWorkspaceOperation::UpdateCampaignSources
            }
            Self::GetCampaign { .. } => DiscoveryWorkspaceOperation::GetCampaign,
            Self::ListCampaigns { .. } => DiscoveryWorkspaceOperation::ListCampaigns,
            Self::ListLeads { .. } => DiscoveryWorkspaceOperation::ListLeads,
            Self::ListLeadCounts => DiscoveryWorkspaceOperation::ListLeadCounts,
            Self::GetLead { .. } => DiscoveryWorkspaceOperation::GetLead,
            Self::UpdateLead { .. } => DiscoveryWorkspaceOperation::UpdateLead,
        }
    }

    /// Validate every operation-specific field.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        match self {
            Self::Access => Ok(()),
            Self::CreateCampaign { campaign } => campaign.validate(),
            Self::UpdateCampaignSources {
                campaign_id,
                source_config,
            } => {
                validate_uuid(*campaign_id, "campaign_id")?;
                source_config
                    .validate()
                    .map_err(|_| DiscoveryWorkspaceValidationError::InvalidField("source_config"))
            }
            Self::GetCampaign { campaign_id } => validate_uuid(*campaign_id, "campaign_id"),
            Self::ListCampaigns { request } => request.validate(),
            Self::ListLeads { request } => request.validate(),
            Self::ListLeadCounts => Ok(()),
            Self::GetLead { lead_id } => validate_uuid(*lead_id, "lead_id"),
            Self::UpdateLead { lead_id, input } => {
                validate_uuid(*lead_id, "lead_id")?;
                input.validate()
            }
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
    /// Sources and execution mode used by future Campaign runs.
    #[serde(default, skip_serializing_if = "DiscoverySourceConfig::is_default")]
    pub source_config: DiscoverySourceConfig,
    /// Count of unique Leads first retained by this campaign.
    pub lead_count: u32,
    /// Latest run, when the campaign has been executed.
    pub latest_run: Option<DiscoveryRunProjection>,
    /// Durable source rows for the latest run, in the snapshotted execution order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub latest_run_sources: Vec<DiscoveryRunSourceProjection>,
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
    /// Provider that first retained this unique business.
    #[serde(
        default = "default_outscraper_provider",
        skip_serializing_if = "is_outscraper_provider"
    )]
    pub provider: DiscoveryProvider,
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

/// One aggregated retained-Lead count for a taxonomy row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadCountRow {
    /// Taxonomy industry identifier.
    pub industry_id: String,
    /// Taxonomy vertical identifier; present when this row counts a vertical.
    pub vertical_id: Option<String>,
    /// Number of retained Leads in the workspace for this row.
    pub count: u32,
}

/// Aggregated retained-Lead counts for taxonomy grids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadCounts {
    /// Total retained Leads in the workspace.
    pub total: u32,
    /// Counts per industry, highest first.
    pub industries: Vec<DiscoveryLeadCountRow>,
    /// Counts per vertical within their industry, highest first.
    pub verticals: Vec<DiscoveryLeadCountRow>,
}

/// Funnel status vocabulary for a retained Lead, mirroring the Party
/// relationship lifecycle (`client_active` displays as Converted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryLeadStatus {
    Candidate,
    Accepted,
    Qualified,
    Dormant,
    Disqualified,
    ClientActive,
}

impl DiscoveryLeadStatus {
    pub const fn to_relationship_status(self) -> RelationshipStatus {
        match self {
            Self::Candidate => RelationshipStatus::Candidate,
            Self::Accepted => RelationshipStatus::Accepted,
            Self::Qualified => RelationshipStatus::Qualified,
            Self::Dormant => RelationshipStatus::Dormant,
            Self::Disqualified => RelationshipStatus::Disqualified,
            Self::ClientActive => RelationshipStatus::Active,
        }
    }

    pub const fn from_relationship_status(status: RelationshipStatus) -> Self {
        match status {
            RelationshipStatus::Candidate => Self::Candidate,
            RelationshipStatus::Accepted => Self::Accepted,
            RelationshipStatus::Qualified => Self::Qualified,
            RelationshipStatus::Dormant => Self::Dormant,
            RelationshipStatus::Disqualified => Self::Disqualified,
            RelationshipStatus::Active => Self::ClientActive,
            RelationshipStatus::Paused | RelationshipStatus::Former => Self::ClientActive,
        }
    }
}

/// Editable lead fields carried by an `update_lead` workspace action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadUpdateInput {
    pub website: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub linkedin_url: Option<String>,
    pub contact_name: Option<String>,
    pub contact_title: Option<String>,
    pub notes: Option<String>,
    pub score: Option<u16>,
    pub owner_persona_id: Option<String>,
    pub status: Option<DiscoveryLeadStatus>,
}

impl DiscoveryLeadUpdateInput {
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        for (value, field) in [
            (&self.website, "website"),
            (&self.email, "email"),
            (&self.phone, "phone"),
            (&self.linkedin_url, "linkedin_url"),
            (&self.contact_name, "contact_name"),
            (&self.contact_title, "contact_title"),
        ] {
            if let Some(value) = value {
                validate_text(value, 2048, field)?;
            }
        }
        if let Some(notes) = &self.notes {
            validate_text(notes, 8000, "notes")?;
        }
        if let Some(score) = self.score {
            if score > 100 {
                return Err(DiscoveryWorkspaceValidationError::InvalidField("score"));
            }
        }
        if let Some(owner) = &self.owner_persona_id {
            validate_text(owner, 256, "owner_persona_id")?;
        }
        Ok(())
    }
}

/// One retained Lead plus its editable profile fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadDetail {
    #[serde(flatten)]
    pub lead: DiscoveryBusinessLeadProjection,
    pub status: DiscoveryLeadStatus,
    pub owner_persona_id: Option<String>,
    pub website_override: Option<String>,
    pub email: Option<String>,
    pub phone_override: Option<String>,
    pub linkedin_url: Option<String>,
    pub contact_name: Option<String>,
    pub contact_title: Option<String>,
    pub notes: Option<String>,
    pub score: Option<u16>,
    pub updated_by: String,
    pub updated_at: DateTime<Utc>,
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
    /// Aggregated retained-Lead counts.
    LeadCounts {
        /// Complete entitled count aggregation.
        counts: DiscoveryLeadCounts,
    },
    /// One retained Lead with its editable profile.
    Lead {
        /// Complete entitled lead detail.
        lead: Box<DiscoveryLeadDetail>,
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

fn default_outscraper_provider() -> DiscoveryProvider {
    DiscoveryProvider::Outscraper
}

fn is_outscraper_provider(provider: &DiscoveryProvider) -> bool {
    *provider == DiscoveryProvider::Outscraper
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
    use crate::discovery::{DiscoverySource, DiscoverySourceConfig, DiscoverySourceMode};
    use crate::party::{is_relationship_transition_allowed, RelationshipKind, RelationshipStatus};

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
            source_config: DiscoverySourceConfig::default(),
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
            status: None,
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
                campaign: Box::new(campaign()),
            },
        };
        let value = serde_json::to_value(&request).expect("serialize request");
        let decoded: DiscoveryWorkspaceRequest =
            serde_json::from_value(value).expect("decode request");
        assert_eq!(decoded, request);
        assert_eq!(decoded.validate(), Ok(()));
    }

    #[test]
    fn campaign_sources_are_validated_and_update_is_explicit() {
        let mut valid = campaign();
        valid.source_config = DiscoverySourceConfig {
            mode: DiscoverySourceMode::Concurrent,
            sources: vec![DiscoverySource::BraveSearch, DiscoverySource::ExaSearch],
        };
        assert_eq!(valid.validate(), Ok(()));

        let update = DiscoveryWorkspaceActionPayload::UpdateCampaignSources {
            campaign_id: valid.campaign_id,
            source_config: valid.source_config.clone(),
        };
        assert_eq!(
            update.operation(),
            DiscoveryWorkspaceOperation::UpdateCampaignSources
        );
        assert_eq!(update.validate(), Ok(()));

        let invalid = DiscoveryWorkspaceActionPayload::UpdateCampaignSources {
            campaign_id: valid.campaign_id,
            source_config: DiscoverySourceConfig {
                mode: DiscoverySourceMode::Waterfall,
                sources: vec![],
            },
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn legacy_campaign_input_defaults_to_outscraper_waterfall() {
        let mut value = serde_json::to_value(campaign()).expect("serialize Campaign");
        value
            .as_object_mut()
            .expect("Campaign object")
            .remove("source_config");
        let decoded: DiscoveryCampaignInput =
            serde_json::from_value(value).expect("decode legacy Campaign");
        assert_eq!(decoded.source_config, DiscoverySourceConfig::default());
        assert_eq!(decoded.validate(), Ok(()));
    }

    #[test]
    fn lead_counts_round_trip_and_operation_mapping() {
        let counts = DiscoveryLeadCounts {
            total: 2,
            industries: vec![DiscoveryLeadCountRow {
                industry_id: "healthcare".into(),
                vertical_id: None,
                count: 2,
            }],
            verticals: vec![DiscoveryLeadCountRow {
                industry_id: "healthcare".into(),
                vertical_id: Some("dentists".into()),
                count: 2,
            }],
        };
        let value = serde_json::to_value(&counts).expect("serialize counts");
        let decoded: DiscoveryLeadCounts = serde_json::from_value(value).expect("decode counts");
        assert_eq!(decoded, counts);

        let request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::ListLeadCounts,
        };
        assert_eq!(
            request.payload.operation(),
            DiscoveryWorkspaceOperation::ListLeadCounts
        );
        assert_eq!(request.validate(), Ok(()));

        let result = DiscoveryWorkspaceResult::LeadCounts { counts };
        let encoded: DiscoveryWorkspaceResult =
            serde_json::from_value(serde_json::to_value(&result).expect("serialize"))
                .expect("decode");
        assert_eq!(encoded, result);
    }

    #[test]
    fn lead_update_input_round_trips_and_uses_party_status_vocabulary() {
        let input = DiscoveryLeadUpdateInput {
            website: Some("https://acme.example".into()),
            email: Some("hello@acme.example".into()),
            phone: None,
            linkedin_url: None,
            contact_name: None,
            contact_title: None,
            notes: Some("Warm intro from Sipho".into()),
            score: Some(82),
            owner_persona_id: Some("chief-of-staff".into()),
            status: Some(DiscoveryLeadStatus::Qualified),
        };
        assert_eq!(input.validate(), Ok(()));

        let payload = DiscoveryWorkspaceActionPayload::UpdateLead {
            lead_id: Uuid::new_v4(),
            input,
        };
        assert_eq!(payload.operation(), DiscoveryWorkspaceOperation::UpdateLead);
        assert_eq!(payload.validate(), Ok(()));

        let get = DiscoveryWorkspaceActionPayload::GetLead {
            lead_id: Uuid::new_v4(),
        };
        assert_eq!(get.operation(), DiscoveryWorkspaceOperation::GetLead);
        assert_eq!(get.validate(), Ok(()));
    }

    #[test]
    fn lead_status_uses_the_party_lifecycle_and_rejects_client_only_states() {
        assert_eq!(
            DiscoveryLeadStatus::Candidate.to_relationship_status(),
            RelationshipStatus::Candidate
        );
        assert!(is_relationship_transition_allowed(
            RelationshipKind::Lead,
            RelationshipStatus::Candidate,
            RelationshipStatus::Accepted,
        ));
        assert!(!is_relationship_transition_allowed(
            RelationshipKind::Lead,
            RelationshipStatus::Disqualified,
            RelationshipStatus::Accepted,
        ));
    }
}
