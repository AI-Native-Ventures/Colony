//! Strict private contracts for Colony Discovery campaigns and Leads.

use chrono::{DateTime, Utc};
use nostr::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::discovery::{
    DiscoveryBusinessSearchSpec, DiscoveryNanoUsd, DiscoveryProvider, DiscoveryRunProjection,
    DiscoverySourceConfig, DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD,
};
use crate::discovery_worker::DiscoveryRunSourceProjection;
use crate::party::RelationshipStatus;

const MAX_NAME_BYTES: usize = 256;
const MAX_TAXONOMY_ID_BYTES: usize = 128;
const MAX_DESCRIPTION_BYTES: usize = 2_048;

/// Exact Approval Block action used for agent-submitted Campaign budgets.
pub const DISCOVERY_BUDGET_APPROVAL_ACTION: &str = "Approve Colony Credits for Discovery Campaign";

/// Stable destination prefix pinned into a Campaign budget Approval Block.
pub const DISCOVERY_BUDGET_APPROVAL_DESTINATION_PREFIX: &str = "colony:discovery:campaign:";

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
    /// Approve or increase one Campaign's maximum spend.
    ApproveCampaignBudget,
    /// Pause new spend while preserving the approval.
    PauseCampaignBudget,
    /// Permanently revoke new spend under the approval.
    RevokeCampaignBudget,
    /// Read the current Campaign budget projection.
    GetCampaignBudget,
    /// Read one campaign and its latest run/count projection.
    GetCampaign,
    /// List campaigns in the workspace.
    ListCampaigns,
    /// List normalized retained Businesses Leads.
    ListLeads,
    /// List retained-Lead counts per taxonomy row.
    ListLeadCounts,
    /// Search taxonomies, Campaigns, Lead collections, Leads, and runs
    /// for mention suggestions.
    SearchEntities,
    /// Resolve mention references into current permission-checked context.
    ResolveEntities,
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

/// Current Campaign-create input. Colony owns the provider source plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryCampaignInputV2 {
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
    /// Provider-neutral search phrase.
    pub query: String,
    /// Human-readable geography.
    pub location: String,
    /// Maximum unique new Leads requested for the Campaign.
    pub target: u16,
    /// Optional user-authored ideal-customer description.
    pub description: Option<String>,
    /// ISO 639-1 provider language code.
    pub language: String,
    /// Optional ISO 3166-1 alpha-2 provider country code.
    pub region: Option<String>,
}

impl DiscoveryCampaignInputV2 {
    /// Convert a released input while discarding its user-selected source plan.
    pub fn from_legacy(value: DiscoveryCampaignInput) -> Self {
        Self {
            campaign_id: value.campaign_id,
            name: value.name,
            industry_id: value.industry_id,
            industry_name: value.industry_name,
            vertical_id: value.vertical_id,
            vertical_name: value.vertical_name,
            query: value.query,
            location: value.location,
            target: value.target,
            description: value.description,
            language: value.language,
            region: value.region,
        }
    }

    /// Validate the strict, provider-neutral Campaign shape.
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

    /// Produce the immutable search derived by the relay at run admission.
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

/// Rolling-compatible Campaign-create input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DiscoveryCampaignCreateInput {
    /// Current source-free input.
    Current(DiscoveryCampaignInputV2),
    /// Released input accepted only for rolling compatibility.
    Legacy(DiscoveryCampaignInput),
}

impl DiscoveryCampaignCreateInput {
    /// Validate either released or current JSON without weakening either shape.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        match self {
            Self::Current(value) => value.validate(),
            Self::Legacy(value) => value.validate(),
        }
    }

    /// Return the provider-neutral input used by the relay.
    pub fn normalized(&self) -> DiscoveryCampaignInputV2 {
        match self {
            Self::Current(value) => value.clone(),
            Self::Legacy(value) => DiscoveryCampaignInputV2::from_legacy(value.clone()),
        }
    }
}

/// Durable Campaign budget lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryCampaignBudgetState {
    /// No human spending approval exists.
    Unapproved,
    /// New runs and provider requests may reserve approved funds.
    Active,
    /// Approval remains but no new spend may begin.
    Paused,
    /// Approval was permanently revoked.
    Revoked,
    /// No approved Campaign capacity remains.
    Exhausted,
}

/// Exact human approval or submitted approval-Block evidence for a Campaign.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryCampaignBudgetApproval {
    /// Campaign covered by the approval.
    pub campaign_id: Uuid,
    /// Human Colony Credits account funding the Campaign.
    pub payer_pubkey: PublicKey,
    /// Maximum approved Campaign spend.
    pub approved_nanousd: DiscoveryNanoUsd,
    /// Fixed price covered by this approval.
    pub price_per_retained_lead_nanousd: DiscoveryNanoUsd,
    /// Hex-encoded canonical fingerprint of all spend-sensitive fields.
    pub campaign_fingerprint: String,
    /// Human approval Block action event, when an agent submits evidence.
    pub approval_action_event_id: Option<String>,
    /// Approval Block expiry, when an agent submits evidence.
    pub approval_expires_at: Option<DateTime<Utc>>,
}

impl DiscoveryCampaignBudgetApproval {
    /// Validate the launch price, bounded maximum, fingerprint, and evidence shape.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        validate_uuid(self.campaign_id, "campaign_id")?;
        if self.approved_nanousd.is_zero()
            || self.price_per_retained_lead_nanousd.get() != DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD
        {
            return Err(DiscoveryWorkspaceValidationError::InvalidField("budget"));
        }
        validate_hex_id(&self.campaign_fingerprint, "campaign_fingerprint")?;
        match (
            self.approval_action_event_id.as_deref(),
            self.approval_expires_at,
        ) {
            (None, None) => Ok(()),
            (Some(event_id), Some(_)) => validate_hex_id(event_id, "approval_action_event_id"),
            _ => Err(DiscoveryWorkspaceValidationError::InvalidField(
                "approval_evidence",
            )),
        }
    }

    /// Build the exact Approval Block proposal an agent must present to the payer.
    pub fn approval_proposal(
        &self,
    ) -> Result<crate::block::ApprovalProposal, DiscoveryWorkspaceValidationError> {
        self.validate()?;
        let expires_at = self
            .approval_expires_at
            .ok_or(DiscoveryWorkspaceValidationError::InvalidField(
                "approval_evidence",
            ))?
            .timestamp();
        let expires_at = u64::try_from(expires_at)
            .map_err(|_| DiscoveryWorkspaceValidationError::InvalidField("approval_evidence"))?;
        let content = crate::block::canonical_json(&serde_json::json!({
            "approved_nanousd": self.approved_nanousd.get().to_string(),
            "campaign_fingerprint": self.campaign_fingerprint,
            "campaign_id": self.campaign_id,
            "payer_pubkey": self.payer_pubkey.to_hex(),
            "price_per_retained_lead_nanousd": self
                .price_per_retained_lead_nanousd
                .get()
                .to_string(),
        }))
        .map_err(|_| DiscoveryWorkspaceValidationError::InvalidField("approval_evidence"))?;
        Ok(crate::block::ApprovalProposal {
            action: DISCOVERY_BUDGET_APPROVAL_ACTION.to_owned(),
            destination: format!(
                "{DISCOVERY_BUDGET_APPROVAL_DESTINATION_PREFIX}{}",
                self.campaign_id
            ),
            content: serde_json::Value::String(content),
            expires_at,
        })
    }
}

/// Current Campaign budget safe for entitled workspace readers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryCampaignBudgetProjection {
    /// Durable budget state.
    pub state: DiscoveryCampaignBudgetState,
    /// Funding human, once approved.
    pub payer_pubkey: Option<PublicKey>,
    /// Approved maximum Campaign spend.
    pub approved_nanousd: DiscoveryNanoUsd,
    /// Settled Campaign spend.
    pub spent_nanousd: DiscoveryNanoUsd,
    /// Active run reservations.
    pub reserved_nanousd: DiscoveryNanoUsd,
    /// Fixed price covered by the approval.
    pub price_per_retained_lead_nanousd: Option<DiscoveryNanoUsd>,
    /// Hex-encoded approved Campaign fingerprint.
    pub campaign_fingerprint: Option<String>,
    /// Approval action evidence event ID.
    pub approval_action_event_id: Option<String>,
    /// Approval time.
    pub approved_at: Option<DateTime<Utc>>,
}

impl DiscoveryCampaignBudgetProjection {
    /// Validate budget state coherence and arithmetic.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        let remaining = self.remaining_nanousd()?;
        match self.state {
            DiscoveryCampaignBudgetState::Unapproved
                if self.payer_pubkey.is_none()
                    && self.approved_nanousd.is_zero()
                    && self.spent_nanousd.is_zero()
                    && self.reserved_nanousd.is_zero()
                    && self.price_per_retained_lead_nanousd.is_none()
                    && self.campaign_fingerprint.is_none()
                    && self.approval_action_event_id.is_none()
                    && self.approved_at.is_none() =>
            {
                Ok(())
            }
            DiscoveryCampaignBudgetState::Active
            | DiscoveryCampaignBudgetState::Paused
            | DiscoveryCampaignBudgetState::Revoked
            | DiscoveryCampaignBudgetState::Exhausted
                if self.payer_pubkey.is_some()
                    && !self.approved_nanousd.is_zero()
                    && self
                        .price_per_retained_lead_nanousd
                        .is_some_and(|price| !price.is_zero())
                    && self.campaign_fingerprint.as_deref().is_some_and(|value| {
                        validate_hex_id(value, "campaign_fingerprint").is_ok()
                    })
                    && self
                        .approval_action_event_id
                        .as_deref()
                        .is_some_and(|value| {
                            validate_hex_id(value, "approval_action_event_id").is_ok()
                        })
                    && self.approved_at.is_some()
                    && (self.state != DiscoveryCampaignBudgetState::Active
                        || !remaining.is_zero())
                    && (self.state != DiscoveryCampaignBudgetState::Exhausted
                        || remaining.is_zero()) =>
            {
                Ok(())
            }
            _ => Err(DiscoveryWorkspaceValidationError::InvalidField("budget")),
        }
    }

    /// Remaining approved amount after settled spend and active reservations.
    pub fn remaining_nanousd(&self) -> Result<DiscoveryNanoUsd, DiscoveryWorkspaceValidationError> {
        let used = self
            .spent_nanousd
            .get()
            .checked_add(self.reserved_nanousd.get())
            .ok_or(DiscoveryWorkspaceValidationError::InvalidField("budget"))?;
        DiscoveryNanoUsd::new(
            self.approved_nanousd
                .get()
                .checked_sub(used)
                .ok_or(DiscoveryWorkspaceValidationError::InvalidField("budget"))?,
        )
        .map_err(|_| DiscoveryWorkspaceValidationError::InvalidField("budget"))
    }
}

/// Build the versioned fingerprint used by human spending approval.
pub fn campaign_budget_fingerprint(
    campaign: &DiscoveryCampaignInputV2,
    payer: &PublicKey,
    price_per_retained_lead_nanousd: DiscoveryNanoUsd,
) -> Result<[u8; 32], DiscoveryWorkspaceValidationError> {
    campaign.validate()?;
    if price_per_retained_lead_nanousd.is_zero() {
        return Err(DiscoveryWorkspaceValidationError::InvalidField("price"));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"colony.discovery-campaign-budget/v1\0");
    hasher.update(campaign.campaign_id.as_bytes());
    update_fingerprint_text(&mut hasher, &campaign.industry_id);
    update_fingerprint_text(&mut hasher, &campaign.vertical_id);
    update_fingerprint_text(&mut hasher, &campaign.query);
    update_fingerprint_text(&mut hasher, &campaign.location);
    hasher.update(campaign.target.to_be_bytes());
    update_fingerprint_text(&mut hasher, &campaign.language);
    match campaign.region.as_deref() {
        Some(region) => {
            hasher.update([1]);
            update_fingerprint_text(&mut hasher, region);
        }
        None => hasher.update([0]),
    }
    hasher.update(price_per_retained_lead_nanousd.get().to_be_bytes());
    hasher.update(payer.to_bytes());
    Ok(hasher.finalize().into())
}

fn update_fingerprint_text(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u32).to_be_bytes());
    hasher.update(value.as_bytes());
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
        /// Rolling-compatible Campaign input normalized to Colony-owned sources.
        campaign: Box<DiscoveryCampaignCreateInput>,
        /// Optional direct human approval committed atomically with Campaign creation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        budget_approval: Option<DiscoveryCampaignBudgetApproval>,
    },
    /// Replace the source plan used by future runs of one Campaign.
    UpdateCampaignSources {
        /// Stable Campaign identifier.
        campaign_id: Uuid,
        /// Complete replacement source configuration.
        source_config: DiscoverySourceConfig,
    },
    /// Approve or increase a maximum Campaign budget.
    ApproveCampaignBudget {
        /// Exact budget approval and optional human Block evidence.
        approval: DiscoveryCampaignBudgetApproval,
    },
    /// Pause new reservations under an existing approval.
    PauseCampaignBudget {
        /// Stable Campaign identifier.
        campaign_id: Uuid,
    },
    /// Revoke new reservations under an existing approval.
    RevokeCampaignBudget {
        /// Stable Campaign identifier.
        campaign_id: Uuid,
    },
    /// Read the current Campaign budget projection.
    GetCampaignBudget {
        /// Stable Campaign identifier.
        campaign_id: Uuid,
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
    /// Search mentionable Discovery entities in the active community.
    SearchEntities {
        /// Case-insensitive text query. Empty matches the newest entities.
        query: String,
        /// Maximum rows, 1 through [`DISCOVERY_MENTION_MAX_REFS`].
        limit: u16,
    },
    /// Resolve mention references into current permission-checked context.
    ResolveEntities {
        /// Strict references, at most [`DISCOVERY_MENTION_MAX_REFS`].
        refs: Vec<DiscoveryEntityRef>,
    },
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
            Self::ApproveCampaignBudget { .. } => {
                DiscoveryWorkspaceOperation::ApproveCampaignBudget
            }
            Self::PauseCampaignBudget { .. } => DiscoveryWorkspaceOperation::PauseCampaignBudget,
            Self::RevokeCampaignBudget { .. } => DiscoveryWorkspaceOperation::RevokeCampaignBudget,
            Self::GetCampaignBudget { .. } => DiscoveryWorkspaceOperation::GetCampaignBudget,
            Self::GetCampaign { .. } => DiscoveryWorkspaceOperation::GetCampaign,
            Self::ListCampaigns { .. } => DiscoveryWorkspaceOperation::ListCampaigns,
            Self::ListLeads { .. } => DiscoveryWorkspaceOperation::ListLeads,
            Self::ListLeadCounts => DiscoveryWorkspaceOperation::ListLeadCounts,
            Self::SearchEntities { .. } => DiscoveryWorkspaceOperation::SearchEntities,
            Self::ResolveEntities { .. } => DiscoveryWorkspaceOperation::ResolveEntities,
            Self::GetLead { .. } => DiscoveryWorkspaceOperation::GetLead,
            Self::UpdateLead { .. } => DiscoveryWorkspaceOperation::UpdateLead,
        }
    }

    /// Validate every operation-specific field.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        match self {
            Self::Access => Ok(()),
            Self::CreateCampaign {
                campaign,
                budget_approval,
            } => {
                campaign.validate()?;
                let Some(approval) = budget_approval else {
                    return Ok(());
                };
                approval.validate()?;
                let campaign = campaign.normalized();
                if approval.campaign_id != campaign.campaign_id
                    || approval.approval_action_event_id.is_some()
                    || approval.approval_expires_at.is_some()
                {
                    return Err(DiscoveryWorkspaceValidationError::InvalidField(
                        "budget_approval",
                    ));
                }
                let expected = campaign_budget_fingerprint(
                    &campaign,
                    &approval.payer_pubkey,
                    approval.price_per_retained_lead_nanousd,
                )?;
                if hex::decode(&approval.campaign_fingerprint).ok().as_deref()
                    != Some(expected.as_slice())
                {
                    return Err(DiscoveryWorkspaceValidationError::InvalidField(
                        "budget_approval",
                    ));
                }
                Ok(())
            }
            Self::UpdateCampaignSources {
                campaign_id,
                source_config,
            } => {
                validate_uuid(*campaign_id, "campaign_id")?;
                source_config
                    .validate()
                    .map_err(|_| DiscoveryWorkspaceValidationError::InvalidField("source_config"))
            }
            Self::ApproveCampaignBudget { approval } => approval.validate(),
            Self::PauseCampaignBudget { campaign_id }
            | Self::RevokeCampaignBudget { campaign_id }
            | Self::GetCampaignBudget { campaign_id } => validate_uuid(*campaign_id, "campaign_id"),
            Self::GetCampaign { campaign_id } => validate_uuid(*campaign_id, "campaign_id"),
            Self::ListCampaigns { request } => request.validate(),
            Self::ListLeads { request } => request.validate(),
            Self::ListLeadCounts => Ok(()),
            Self::SearchEntities { query, limit } => {
                crate::discovery_taxonomy::validate_search_query(query)?;
                if *limit == 0 || *limit as usize > DISCOVERY_MENTION_MAX_REFS {
                    return Err(DiscoveryWorkspaceValidationError::InvalidField("limit"));
                }
                Ok(())
            }
            Self::ResolveEntities { refs } => {
                if refs.is_empty() || refs.len() > DISCOVERY_MENTION_MAX_REFS {
                    return Err(DiscoveryWorkspaceValidationError::InvalidField("refs"));
                }
                for entity_ref in refs {
                    entity_ref.validate()?;
                }
                Ok(())
            }
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
    /// Count of workspace-unique Leads associated with this Campaign.
    pub lead_count: u32,
    /// Latest run, when the campaign has been executed.
    pub latest_run: Option<DiscoveryRunProjection>,
    /// Durable source rows for the latest run, in the snapshotted execution order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub latest_run_sources: Vec<DiscoveryRunSourceProjection>,
    /// Human-approved Campaign spending state, when the relay supports budgets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<DiscoveryCampaignBudgetProjection>,
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
    /// Campaign through which this Lead is being listed.
    pub campaign_id: Uuid,
    /// Taxonomy industry inherited from the first campaign.
    pub industry_id: String,
    /// Taxonomy vertical inherited from the first campaign.
    pub vertical_id: String,
    /// Current funnel status; unedited Leads report the lifecycle entry state.
    pub status: DiscoveryLeadStatus,
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

/// Current permission-checked context for a mentioned Industry or Vertical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryTaxonomyProjection {
    /// Parent industry identifier.
    pub industry_id: String,
    /// Parent industry label.
    pub industry_label: String,
    /// Vertical identifier; absent when this row is an industry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical_id: Option<String>,
    /// Vertical label; absent when this row is an industry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical_label: Option<String>,
    /// Canonical description, when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Leads currently retained in the workspace under this row.
    pub lead_count: u32,
}

/// Bounded current view of the Leads in one Campaign.
///
/// Deliberately a snapshot projection of at most
/// [`DISCOVERY_LEAD_COLLECTION_ROWS`] rows plus the live total: it is prompt
/// context, never a copy of the collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryLeadCollectionProjection {
    /// Campaign whose Leads are collected.
    pub campaign_id: Uuid,
    /// Live total number of Leads in the collection.
    pub total: u32,
    /// First summary rows in stable newest-first order.
    pub leads: Vec<DiscoveryBusinessLeadProjection>,
}

/// Result of resolving one Discovery mention reference.
///
/// Hidden and forbidden records both resolve to [`Self::Unavailable`] without
/// revealing whether the record exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "resolved", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResolvedDiscoveryEntity {
    /// Industry matched a canonical taxonomy row.
    Industry {
        /// Current row projection.
        taxonomy: Box<DiscoveryTaxonomyProjection>,
    },
    /// Vertical matched a canonical taxonomy row.
    Vertical {
        /// Current row projection.
        taxonomy: Box<DiscoveryTaxonomyProjection>,
    },
    /// Campaign is visible with its full entitled projection.
    Campaign {
        /// Current campaign projection.
        campaign: Box<DiscoveryCampaignProjection>,
    },
    /// Campaign Lead collection resolved to a bounded view.
    CampaignLeads {
        /// Bounded collection projection.
        collection: Box<DiscoveryLeadCollectionProjection>,
    },
    /// Lead is visible with its full detail.
    Lead {
        /// Current lead detail.
        lead: Box<DiscoveryLeadDetail>,
    },
    /// Run is visible with its current projection.
    Run {
        /// Current run projection.
        run: Box<crate::discovery::DiscoveryRunProjection>,
    },
    /// The reference was forged, malformed, deleted, unauthorized, or
    /// outside the event's community.
    Unavailable {
        /// Kind as referenced.
        kind: DiscoveryEntityKind,
        /// ID as referenced.
        id: String,
    },
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

/// Maximum Discovery references resolved for one message or one request.
pub const DISCOVERY_MENTION_MAX_REFS: usize = 20;

/// Maximum Lead rows hydrated into a Campaign Lead collection context.
pub const DISCOVERY_LEAD_COLLECTION_ROWS: usize = 25;

/// Entity kinds addressable by a `discovery` mention tag. The kind is
/// authoritative; the display label travels with the message but is never
/// trusted to identify anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryEntityKind {
    /// Canonical business taxonomy Industry.
    Industry,
    /// Canonical business taxonomy Vertical inside an Industry.
    Vertical,
    /// One Discovery Campaign.
    Campaign,
    /// The bounded virtual collection of Leads in one Campaign.
    CampaignLeads,
    /// One retained Lead.
    Lead,
    /// One Discovery run.
    Run,
}

impl DiscoveryEntityKind {
    /// Parse the wire spelling used by `["discovery", "<kind>", ...]` tags.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "industry" => Some(Self::Industry),
            "vertical" => Some(Self::Vertical),
            "campaign" => Some(Self::Campaign),
            "campaign_leads" => Some(Self::CampaignLeads),
            "lead" => Some(Self::Lead),
            "run" => Some(Self::Run),
            _ => None,
        }
    }

    /// Whether this kind's ID must be a UUID (as opposed to a taxonomy ID).
    pub const fn requires_uuid(self) -> bool {
        matches!(
            self,
            Self::Campaign | Self::CampaignLeads | Self::Lead | Self::Run
        )
    }

    /// Whether this kind is one of the two canonical taxonomy rows.
    pub const fn is_taxonomy(self) -> bool {
        matches!(self, Self::Industry | Self::Vertical)
    }
}

/// Structured reference embedded in a mention tag or a resolve request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryEntityRef {
    /// Authoritative referenced-entity kind.
    pub kind: DiscoveryEntityKind,
    /// Stable identifier: a UUID, a canonical taxonomy ID, or, for Verticals,
    /// the composite `<industry_id>/<vertical_id>` (vertical slugs repeat
    /// across industries, so the parent must travel with the child).
    pub id: String,
}

/// A vertical reference carries its parent industry ID so resolution can
/// locate the canonical row without guessing.
impl DiscoveryEntityRef {
    /// Validate the strict shape of this reference.
    pub fn validate(&self) -> Result<(), DiscoveryWorkspaceValidationError> {
        match self.kind {
            DiscoveryEntityKind::Campaign
            | DiscoveryEntityKind::CampaignLeads
            | DiscoveryEntityKind::Lead
            | DiscoveryEntityKind::Run => {
                let Ok(uuid) = Uuid::parse_str(&self.id) else {
                    return Err(DiscoveryWorkspaceValidationError::InvalidField(
                        "entity_ref",
                    ));
                };
                validate_uuid(uuid, "entity_ref")
            }
            DiscoveryEntityKind::Industry => validate_taxonomy_id(&self.id, "entity_ref"),
            DiscoveryEntityKind::Vertical => match self.id.split_once('/') {
                Some((industry_id, vertical_id)) => {
                    validate_taxonomy_id(industry_id, "entity_ref")?;
                    validate_taxonomy_id(vertical_id, "entity_ref")
                }
                None => Err(DiscoveryWorkspaceValidationError::InvalidField(
                    "entity_ref",
                )),
            },
        }
    }

    /// Split a Vertical reference into `(industry, vertical)` components.
    /// Returns `None` for other kinds or malformed composites.
    pub fn vertical_components(&self) -> Option<(&str, &str)> {
        if self.kind != DiscoveryEntityKind::Vertical {
            return None;
        }
        self.id.split_once('/')
    }
}

/// Search result row surfaced to mention directories and the CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryEntitySummary {
    /// Referenced-entity kind.
    pub kind: DiscoveryEntityKind,
    /// Stable identifier suitable for building a mention tag.
    pub id: String,
    /// Human-readable label (presentation only).
    pub label: String,
    /// Parent industry ID for vertical results, campaign ID for run results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    /// Short secondary detail line (status, location, counts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Funnel status vocabulary for a retained Lead, mirroring the Party
/// relationship lifecycle (`client_active` displays as Converted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryLeadStatus {
    /// Returned by Discovery, not yet accepted by the company.
    Candidate,
    /// Accepted as a prospect the company owns.
    Accepted,
    /// Qualified for commercial pursuit.
    Qualified,
    /// Parked without being ruled out.
    Dormant,
    /// Judged not worth pursuing.
    Disqualified,
    /// Converted to an active Client relationship.
    ClientActive,
}

impl DiscoveryLeadStatus {
    /// Map this Discovery status onto the Party relationship lifecycle.
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

    /// Map a Party relationship status back onto the Discovery vocabulary.
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
    /// Website override.
    pub website: Option<String>,
    /// Email override.
    pub email: Option<String>,
    /// Phone override.
    pub phone: Option<String>,
    /// LinkedIn profile URL.
    pub linkedin_url: Option<String>,
    /// Contact name (People leads).
    pub contact_name: Option<String>,
    /// Contact title (People leads).
    pub contact_title: Option<String>,
    /// Free-text notes.
    pub notes: Option<String>,
    /// Quality score from zero through 100.
    pub score: Option<u16>,
    /// Persona accountable for this Lead.
    pub owner_persona_id: Option<String>,
    /// Funnel status to move the Lead to.
    pub status: Option<DiscoveryLeadStatus>,
}

impl DiscoveryLeadUpdateInput {
    /// Validate every editable field against its bound.
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
    /// The immutable observation this profile edits. The flattened projection
    /// carries the current funnel status, so the detail and the list rows
    /// always agree on one value.
    #[serde(flatten)]
    pub lead: DiscoveryBusinessLeadProjection,
    /// Persona accountable for this Lead.
    pub owner_persona_id: Option<String>,
    /// Website override.
    pub website_override: Option<String>,
    /// Email override.
    pub email: Option<String>,
    /// Phone override.
    pub phone_override: Option<String>,
    /// LinkedIn profile URL.
    pub linkedin_url: Option<String>,
    /// Contact name (People leads).
    pub contact_name: Option<String>,
    /// Contact title (People leads).
    pub contact_title: Option<String>,
    /// Free-text notes.
    pub notes: Option<String>,
    /// Quality score from zero through 100.
    pub score: Option<u16>,
    /// Public key of the last editor, hex-encoded.
    pub updated_by: Option<String>,
    /// Time of the last edit.
    pub updated_at: Option<DateTime<Utc>>,
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
    /// Current Campaign budget.
    Budget {
        /// Strict point-in-time budget projection.
        budget: DiscoveryCampaignBudgetProjection,
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
    /// Mention-directory search results across Discovery entities.
    EntitySearch {
        /// Ranked, bounded result rows.
        entities: Vec<DiscoveryEntitySummary>,
    },
    /// Permission-checked resolution of every requested reference, in
    /// request order (duplicates collapsed to their first occurrence).
    ResolvedEntities {
        /// Current resolution per unique reference.
        entities: Vec<ResolvedDiscoveryEntity>,
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

fn validate_hex_id(
    value: &str,
    field: &'static str,
) -> Result<(), DiscoveryWorkspaceValidationError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
                campaign: Box::new(DiscoveryCampaignCreateInput::Current(
                    DiscoveryCampaignInputV2::from_legacy(campaign()),
                )),
                budget_approval: None,
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
    fn current_campaign_create_omits_sources_but_released_input_still_decodes() {
        let current = DiscoveryCampaignCreateInput::Current(DiscoveryCampaignInputV2::from_legacy(
            campaign(),
        ));
        let current_json = serde_json::to_value(&current).expect("serialize current Campaign");
        assert!(current_json.get("source_config").is_none());
        assert_eq!(current.validate(), Ok(()));

        let legacy_campaign = campaign();
        let legacy_campaign_id = legacy_campaign.campaign_id;
        let mut legacy_json =
            serde_json::to_value(legacy_campaign).expect("serialize legacy Campaign");
        legacy_json
            .as_object_mut()
            .expect("Campaign object")
            .insert(
                "source_config".to_owned(),
                serde_json::json!({"mode":"concurrent","sources":["brave_search"]}),
            );
        let legacy: DiscoveryCampaignCreateInput =
            serde_json::from_value(legacy_json).expect("decode released Campaign");
        assert_eq!(legacy.validate(), Ok(()));
        assert_eq!(legacy.normalized().campaign_id, legacy_campaign_id);
    }

    #[test]
    fn budget_fingerprint_covers_spend_inputs_not_presentation() {
        let payer = nostr::PublicKey::from_hex(&"11".repeat(32)).expect("payer");
        let price =
            DiscoveryNanoUsd::new(DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD).expect("launch price");
        let campaign = DiscoveryCampaignInputV2::from_legacy(campaign());
        let baseline =
            campaign_budget_fingerprint(&campaign, &payer, price).expect("fingerprint Campaign");

        let mut renamed = campaign.clone();
        renamed.name = "Renamed Campaign".to_owned();
        renamed.description = None;
        assert_eq!(
            campaign_budget_fingerprint(&renamed, &payer, price).expect("fingerprint rename"),
            baseline
        );

        let mut retargeted = campaign.clone();
        retargeted.query = "orthodontists".to_owned();
        assert_ne!(
            campaign_budget_fingerprint(&retargeted, &payer, price).expect("fingerprint retarget"),
            baseline
        );
        let other_payer = nostr::PublicKey::from_hex(&"12".repeat(32)).expect("other payer");
        assert_ne!(
            campaign_budget_fingerprint(&campaign, &other_payer, price).expect("fingerprint payer"),
            baseline
        );
        let other_price = DiscoveryNanoUsd::new(price.get() + 1).expect("other price");
        assert_ne!(
            campaign_budget_fingerprint(&campaign, &payer, other_price).expect("fingerprint price"),
            baseline
        );
    }

    #[test]
    fn budget_fingerprint_matches_the_desktop_contract_vector() {
        let payer = nostr::PublicKey::from_hex(&"11".repeat(32)).expect("payer");
        let price =
            DiscoveryNanoUsd::new(DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD).expect("launch price");
        let campaign = DiscoveryCampaignInputV2 {
            campaign_id: Uuid::from_u128(3),
            name: "Sandton dentists".into(),
            industry_id: "healthcare".into(),
            industry_name: "Healthcare".into(),
            vertical_id: "dentists".into(),
            vertical_name: "Dentists".into(),
            query: "dentists".into(),
            location: "Sandton, South Africa".into(),
            target: 100,
            description: None,
            language: "en".into(),
            region: Some("ZA".into()),
        };
        let fingerprint =
            campaign_budget_fingerprint(&campaign, &payer, price).expect("fingerprint Campaign");
        assert_eq!(
            hex::encode(fingerprint),
            "9c9192ad1893bf8122ff29ef3f0ca90e5c227639c685b1f4844ad8884d3596c7"
        );

        let payload = DiscoveryWorkspaceActionPayload::CreateCampaign {
            campaign: Box::new(DiscoveryCampaignCreateInput::Current(campaign)),
            budget_approval: Some(DiscoveryCampaignBudgetApproval {
                campaign_id: Uuid::from_u128(3),
                payer_pubkey: payer,
                approved_nanousd: DiscoveryNanoUsd::new(5_000_000_000).expect("approved maximum"),
                price_per_retained_lead_nanousd: price,
                campaign_fingerprint: hex::encode(fingerprint),
                approval_action_event_id: None,
                approval_expires_at: None,
            }),
        };
        assert_eq!(payload.validate(), Ok(()));
    }

    #[test]
    fn budget_actions_require_canonical_positive_launch_price() {
        let campaign_id = Uuid::new_v4();
        let payer = nostr::PublicKey::from_hex(&"22".repeat(32)).expect("payer");
        let campaign = DiscoveryCampaignInputV2::from_legacy(DiscoveryCampaignInput {
            campaign_id,
            ..campaign()
        });
        let price =
            DiscoveryNanoUsd::new(DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD).expect("launch price");
        let fingerprint = hex::encode(
            campaign_budget_fingerprint(&campaign, &payer, price).expect("fingerprint"),
        );
        let approve = DiscoveryWorkspaceActionPayload::ApproveCampaignBudget {
            approval: DiscoveryCampaignBudgetApproval {
                campaign_id,
                payer_pubkey: payer,
                approved_nanousd: DiscoveryNanoUsd::new(500_000_000).expect("maximum"),
                price_per_retained_lead_nanousd: price,
                campaign_fingerprint: fingerprint,
                approval_action_event_id: None,
                approval_expires_at: None,
            },
        };
        assert_eq!(approve.validate(), Ok(()));
        assert_eq!(
            approve.operation(),
            DiscoveryWorkspaceOperation::ApproveCampaignBudget
        );
        for action in [
            DiscoveryWorkspaceActionPayload::GetCampaignBudget { campaign_id },
            DiscoveryWorkspaceActionPayload::PauseCampaignBudget { campaign_id },
            DiscoveryWorkspaceActionPayload::RevokeCampaignBudget { campaign_id },
        ] {
            assert_eq!(action.validate(), Ok(()));
        }
    }

    #[test]
    fn agent_budget_approval_proposal_pins_every_spend_field() {
        let approval = DiscoveryCampaignBudgetApproval {
            campaign_id: Uuid::from_u128(3),
            payer_pubkey: nostr::PublicKey::from_hex(&"11".repeat(32)).expect("payer"),
            approved_nanousd: DiscoveryNanoUsd::new(5_000_000_000).expect("maximum"),
            price_per_retained_lead_nanousd: DiscoveryNanoUsd::new(
                DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD,
            )
            .expect("price"),
            campaign_fingerprint:
                "9c9192ad1893bf8122ff29ef3f0ca90e5c227639c685b1f4844ad8884d3596c7".into(),
            approval_action_event_id: Some("22".repeat(32)),
            approval_expires_at: Some(
                chrono::DateTime::from_timestamp(2_000_000_000, 0).expect("expiry"),
            ),
        };
        let proposal = approval.approval_proposal().expect("exact proposal");
        assert_eq!(proposal.action, DISCOVERY_BUDGET_APPROVAL_ACTION);
        assert_eq!(
            proposal.destination,
            "colony:discovery:campaign:00000000-0000-0000-0000-000000000003"
        );
        assert_eq!(proposal.expires_at, 2_000_000_000);
        let content = proposal.content.as_str().expect("string content");
        for expected in [
            "5000000000",
            "50000000",
            "9c9192ad1893bf8122ff29ef3f0ca90e5c227639c685b1f4844ad8884d3596c7",
            &"11".repeat(32),
        ] {
            assert!(content.contains(expected));
        }
        assert_eq!(
            crate::block::compute_approval_hash(&proposal)
                .expect("approval hash")
                .len(),
            64
        );
    }

    #[test]
    fn budget_projection_rejects_overspend_and_partial_approval() {
        let zero = DiscoveryNanoUsd::new(0).expect("zero");
        let mut budget = DiscoveryCampaignBudgetProjection {
            state: DiscoveryCampaignBudgetState::Unapproved,
            payer_pubkey: None,
            approved_nanousd: zero,
            spent_nanousd: zero,
            reserved_nanousd: zero,
            price_per_retained_lead_nanousd: None,
            campaign_fingerprint: None,
            approval_action_event_id: None,
            approved_at: None,
        };
        assert_eq!(budget.validate(), Ok(()));

        budget.state = DiscoveryCampaignBudgetState::Active;
        assert!(budget.validate().is_err());
        budget.approved_nanousd = DiscoveryNanoUsd::new(100).expect("approved");
        budget.spent_nanousd = DiscoveryNanoUsd::new(101).expect("spent");
        assert!(budget.validate().is_err());
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
