//! Core contracts for Colony business Discovery runs.

use chrono::{DateTime, Utc};
use nostr::PublicKey;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;
use uuid::Uuid;

const MAX_DISCOVERY_SEARCH_TEXT_BYTES: usize = 256;
const MAX_DISCOVERY_SOURCES: usize = 3;

/// Fixed launch price for one newly retained, deduplicated Discovery Lead.
pub const DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD: i64 = 50_000_000;
/// Worker protocol that uses Colony-hosted provider credentials.
pub const DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION: u16 = 3;
/// Released multi-source worker protocol retained during rolling upgrades.
pub const DISCOVERY_RELEASED_PROTOCOL_VERSION: u16 = 2;

/// Why an integer Colony Credits amount was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum DiscoveryMoneyError {
    /// Amount is negative or outside PostgreSQL BIGINT range.
    #[error("invalid Discovery nanoUSD amount")]
    InvalidAmount,
}

/// Non-negative nanoUSD amount with canonical decimal-string JSON encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct DiscoveryNanoUsd(i64);

impl DiscoveryNanoUsd {
    /// Construct a bounded non-negative amount.
    pub const fn new(value: i64) -> Result<Self, DiscoveryMoneyError> {
        if value < 0 {
            Err(DiscoveryMoneyError::InvalidAmount)
        } else {
            Ok(Self(value))
        }
    }

    /// Return the integer nanoUSD amount.
    pub const fn get(self) -> i64 {
        self.0
    }

    /// Whether the amount is zero.
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// Checked multiplication by a bounded Lead count.
    pub fn checked_mul(self, quantity: u16) -> Result<Self, DiscoveryMoneyError> {
        self.0
            .checked_mul(i64::from(quantity))
            .map(Self)
            .ok_or(DiscoveryMoneyError::InvalidAmount)
    }
}

impl Serialize for DiscoveryNanoUsd {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for DiscoveryNanoUsd {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let canonical = value == "0"
            || (!value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit()));
        if !canonical {
            return Err(de::Error::custom(
                "nanoUSD must be a canonical decimal string",
            ));
        }
        let parsed = value
            .parse::<i64>()
            .map_err(|_| de::Error::custom("nanoUSD exceeds BIGINT range"))?;
        Self::new(parsed).map_err(de::Error::custom)
    }
}

/// How the selected Discovery sources execute within one run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoverySourceMode {
    /// Execute sources sequentially in the exact saved order.
    Waterfall,
    /// Start every selected source together.
    Concurrent,
}

/// User-facing live Businesses source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoverySource {
    /// Google Maps businesses acquired through Outscraper.
    GoogleMaps,
    /// Brave Web Search results.
    BraveSearch,
    /// Exa semantic company results.
    ExaSearch,
}

impl DiscoverySource {
    /// Return the trusted worker provider required by this source.
    pub const fn provider(self) -> DiscoveryProvider {
        match self {
            Self::GoogleMaps => DiscoveryProvider::Outscraper,
            Self::BraveSearch => DiscoveryProvider::BraveSearch,
            Self::ExaSearch => DiscoveryProvider::ExaSearch,
        }
    }
}

/// External provider used by a trusted local Discovery worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryProvider {
    /// Outscraper Google Maps business discovery.
    Outscraper,
    /// Brave Web Search.
    BraveSearch,
    /// Exa semantic company search.
    ExaSearch,
}

/// Why a Campaign source configuration was refused.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DiscoverySourceConfigError {
    /// The ordered source list was empty, too large, or contained duplicates.
    #[error("invalid Discovery source configuration")]
    InvalidSources,
}

/// Strict source plan saved on a Campaign and snapshotted into each run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoverySourceConfig {
    /// Sequential or parallel source execution.
    pub mode: DiscoverySourceMode,
    /// Ordered, unique, selected live sources.
    pub sources: Vec<DiscoverySource>,
}

impl DiscoverySourceConfig {
    /// Validate the strict selected-source bounds and uniqueness invariant.
    pub fn validate(&self) -> Result<(), DiscoverySourceConfigError> {
        if self.sources.is_empty()
            || self.sources.len() > MAX_DISCOVERY_SOURCES
            || self
                .sources
                .iter()
                .enumerate()
                .any(|(index, source)| self.sources[..index].contains(source))
        {
            return Err(DiscoverySourceConfigError::InvalidSources);
        }
        Ok(())
    }

    /// Return the required provider list in stable source order.
    pub fn providers(&self) -> Vec<DiscoveryProvider> {
        self.sources
            .iter()
            .copied()
            .map(DiscoverySource::provider)
            .collect()
    }

    /// Whether this is the released Outscraper-only configuration.
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for DiscoverySourceConfig {
    fn default() -> Self {
        Self {
            mode: DiscoverySourceMode::Waterfall,
            sources: vec![DiscoverySource::GoogleMaps],
        }
    }
}

/// Why a non-secret Businesses search snapshot was refused.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DiscoverySearchSpecError {
    /// A named field is empty, untrimmed, malformed, or outside its bound.
    #[error("invalid Discovery business search field: {0}")]
    InvalidField(&'static str),
}

/// Immutable, non-secret provider input captured when a Businesses run starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryBusinessSearchSpec {
    /// Business category or search phrase.
    pub query: String,
    /// Human-readable geography included in each configured provider query.
    pub location: String,
    /// Maximum net-new organizations requested for the run.
    pub limit: u16,
    /// Lowercase ISO 639-1 language code.
    pub language: String,
    /// Optional uppercase ISO 3166-1 alpha-2 country code.
    pub region: Option<String>,
}

impl DiscoveryBusinessSearchSpec {
    /// Validate the strict, bounded shape accepted by Colony's live sources.
    pub fn validate(&self) -> Result<(), DiscoverySearchSpecError> {
        validate_search_text(&self.query, "query")?;
        validate_search_text(&self.location, "location")?;
        if !(1..=500).contains(&self.limit) {
            return Err(DiscoverySearchSpecError::InvalidField("limit"));
        }
        if !is_ascii_code(&self.language, false) {
            return Err(DiscoverySearchSpecError::InvalidField("language"));
        }
        if self
            .region
            .as_deref()
            .is_some_and(|value| !is_ascii_code(value, true))
        {
            return Err(DiscoverySearchSpecError::InvalidField("region"));
        }
        Ok(())
    }

    /// Render the shared category-and-location query sent to configured providers.
    pub fn provider_query(&self) -> String {
        format!("{}, {}", self.query, self.location)
    }
}

fn validate_search_text(value: &str, field: &'static str) -> Result<(), DiscoverySearchSpecError> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > MAX_DISCOVERY_SEARCH_TEXT_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(DiscoverySearchSpecError::InvalidField(field));
    }
    Ok(())
}

fn is_ascii_code(value: &str, uppercase: bool) -> bool {
    value.len() == 2
        && value.bytes().all(|byte| {
            if uppercase {
                byte.is_ascii_uppercase()
            } else {
                byte.is_ascii_lowercase()
            }
        })
}

/// Operation requested through a signed Discovery action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryOperation {
    /// Create a new durable run for an existing campaign reference.
    Start,
    /// Read the current durable run projection.
    Status,
    /// Request that an active run stop before its next committed step.
    Cancel,
}

/// Durable lifecycle state of a Discovery run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryRunState {
    /// Accepted but not yet claimed by a worker.
    Queued,
    /// Claimed by a worker and eligible to make progress.
    Running,
    /// Every configured step committed successfully.
    Succeeded,
    /// Stopped by an actor request or entitlement revocation.
    Cancelled,
    /// Stopped because the executor failed.
    Failed,
}

impl DiscoveryRunState {
    /// Whether no further progress may be committed for this state.
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Cancelled | Self::Failed)
    }
}

/// Stable reason attached to a terminal Discovery run when one is required.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryTerminalReason {
    /// An authorized workspace actor requested cancellation.
    CancelledByActor,
    /// The workspace lost its active Discovery entitlement.
    EntitlementRevoked,
    /// The configured executor returned a terminal failure.
    ExecutorFailed,
}

/// Payload of a signed start request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryStartRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this logical command.
    pub idempotency_key: Uuid,
    /// Opaque reference to the campaign that owns the run.
    pub campaign_id: Uuid,
    /// Worker contract requested for the run. Released payloads default to V2.
    #[serde(
        default = "default_released_protocol_version",
        skip_serializing_if = "is_released_protocol_version"
    )]
    pub protocol_version: u16,
    /// Released V1/V2 clients supplied the search. V3 derives it from Campaign state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub business_search: Option<DiscoveryBusinessSearchSpec>,
}

/// Why a run-start contract was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum DiscoveryStartRequestError {
    /// Identifier, protocol, or protocol-specific payload is inconsistent.
    #[error("invalid Discovery start request")]
    InvalidRequest,
}

impl DiscoveryStartRequest {
    /// Validate rolling-compatible V2 and hosted-gateway V3 request shapes.
    pub fn validate(&self) -> Result<(), DiscoveryStartRequestError> {
        if self.request_id.is_nil() || self.idempotency_key.is_nil() || self.campaign_id.is_nil() {
            return Err(DiscoveryStartRequestError::InvalidRequest);
        }
        match (self.protocol_version, self.business_search.as_ref()) {
            (1 | DISCOVERY_RELEASED_PROTOCOL_VERSION, Some(search)) => search
                .validate()
                .map_err(|_| DiscoveryStartRequestError::InvalidRequest),
            (DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION, None) => Ok(()),
            _ => Err(DiscoveryStartRequestError::InvalidRequest),
        }
    }
}

/// Payload of a signed status or cancel request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryRunRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this logical command.
    pub idempotency_key: Uuid,
    /// Durable run being inspected or cancelled.
    pub run_id: Uuid,
}

/// Validated operation-specific Discovery action payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryAction {
    /// Start a new run.
    Start(DiscoveryStartRequest),
    /// Read an existing run.
    Status(DiscoveryRunRequest),
    /// Request cancellation of an existing run.
    Cancel(DiscoveryRunRequest),
}

impl DiscoveryAction {
    /// Operation represented by this action.
    pub const fn operation(&self) -> DiscoveryOperation {
        match self {
            Self::Start(_) => DiscoveryOperation::Start,
            Self::Status(_) => DiscoveryOperation::Status,
            Self::Cancel(_) => DiscoveryOperation::Cancel,
        }
    }

    /// Command-attempt identifier carried by this action.
    pub const fn request_id(&self) -> Uuid {
        match self {
            Self::Start(request) => request.request_id,
            Self::Status(request) | Self::Cancel(request) => request.request_id,
        }
    }

    /// Stable retry key carried by this action.
    pub const fn idempotency_key(&self) -> Uuid {
        match self {
            Self::Start(request) => request.idempotency_key,
            Self::Status(request) | Self::Cancel(request) => request.idempotency_key,
        }
    }
}

/// Non-confidential projection safe to carry in a relay-signed receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryRunProjection {
    /// Durable run identifier.
    pub run_id: Uuid,
    /// Opaque campaign reference supplied at start.
    pub campaign_id: Uuid,
    /// Worker protocol used by this run. Released receipts default to V2.
    #[serde(
        default = "default_released_protocol_version",
        skip_serializing_if = "is_released_protocol_version"
    )]
    pub protocol_version: u16,
    /// Current durable lifecycle state.
    pub state: DiscoveryRunState,
    /// Number of committed executor steps.
    pub completed_steps: u32,
    /// Fixed number of steps configured when the run was accepted.
    pub total_steps: u32,
    /// Whether an authorized actor requested cancellation.
    pub cancel_requested: bool,
    /// Stable terminal reason, when applicable.
    pub terminal_reason: Option<DiscoveryTerminalReason>,
    /// Paid-run snapshot for hosted-gateway protocol runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing: Option<DiscoveryRunBillingProjection>,
    /// Time at which the durable run was created.
    pub created_at: DateTime<Utc>,
    /// Time at which the durable run was last changed.
    pub updated_at: DateTime<Utc>,
}

/// Why a run projection was internally inconsistent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum DiscoveryRunProjectionError {
    /// Lifecycle, progress, protocol, or billing fields disagree.
    #[error("invalid Discovery run projection")]
    InvalidProjection,
}

impl DiscoveryRunProjection {
    /// Validate protocol-specific billing and terminal-state coherence.
    pub fn validate(&self) -> Result<(), DiscoveryRunProjectionError> {
        if self.run_id.is_nil()
            || self.campaign_id.is_nil()
            || self.total_steps == 0
            || self.completed_steps > self.total_steps
        {
            return Err(DiscoveryRunProjectionError::InvalidProjection);
        }
        match (self.protocol_version, self.billing.as_ref()) {
            (1 | DISCOVERY_RELEASED_PROTOCOL_VERSION, None) => Ok(()),
            (DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION, Some(billing)) => {
                billing
                    .validate()
                    .map_err(|_| DiscoveryRunProjectionError::InvalidProjection)?;
                if self.state.is_terminal() == billing.settled_at.is_some() {
                    Ok(())
                } else {
                    Err(DiscoveryRunProjectionError::InvalidProjection)
                }
            }
            _ => Err(DiscoveryRunProjectionError::InvalidProjection),
        }
    }
}

/// Immutable reservation and terminal charge snapshot for one paid run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryRunBillingProjection {
    /// Human account that funds this run.
    pub payer_pubkey: PublicKey,
    /// Price snapshotted when the run was admitted.
    pub price_per_retained_lead_nanousd: DiscoveryNanoUsd,
    /// Maximum number of Leads this run may bill.
    pub billable_lead_limit: u16,
    /// Maximum amount reserved before provider spend.
    pub reserved_nanousd: DiscoveryNanoUsd,
    /// Actual terminal charge, when settled.
    pub settled_nanousd: Option<DiscoveryNanoUsd>,
    /// Unused terminal reservation, when settled.
    pub released_nanousd: Option<DiscoveryNanoUsd>,
    /// Newly retained unique Lead quantity, when settled.
    pub billed_retained_lead_count: Option<u16>,
    /// Unique settlement reference, when settled.
    pub settlement_ref: Option<String>,
    /// Terminal settlement time.
    pub settled_at: Option<DateTime<Utc>>,
}

impl DiscoveryRunBillingProjection {
    /// Validate reservation arithmetic and all-or-none settlement fields.
    pub fn validate(&self) -> Result<(), DiscoveryMoneyError> {
        if self.price_per_retained_lead_nanousd.is_zero()
            || !(1..=500).contains(&self.billable_lead_limit)
            || self.reserved_nanousd
                != self
                    .price_per_retained_lead_nanousd
                    .checked_mul(self.billable_lead_limit)?
        {
            return Err(DiscoveryMoneyError::InvalidAmount);
        }
        match (
            self.settled_nanousd,
            self.released_nanousd,
            self.billed_retained_lead_count,
            self.settlement_ref.as_deref(),
            self.settled_at,
        ) {
            (None, None, None, None, None) => Ok(()),
            (Some(settled), Some(released), Some(quantity), Some(reference), Some(_))
                if quantity <= self.billable_lead_limit
                    && reference == reference.trim()
                    && !reference.is_empty()
                    && reference.len() <= 256
                    && !reference.chars().any(char::is_control)
                    && settled == self.price_per_retained_lead_nanousd.checked_mul(quantity)?
                    && settled
                        .get()
                        .checked_add(released.get())
                        .is_some_and(|total| total == self.reserved_nanousd.get()) =>
            {
                Ok(())
            }
            _ => Err(DiscoveryMoneyError::InvalidAmount),
        }
    }
}

const fn default_released_protocol_version() -> u16 {
    DISCOVERY_RELEASED_PROTOCOL_VERSION
}

const fn is_released_protocol_version(version: &u16) -> bool {
    *version == DISCOVERY_RELEASED_PROTOCOL_VERSION
}

/// Public content of a relay-signed Discovery receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryReceipt {
    /// Operation processed by the relay.
    pub operation: DiscoveryOperation,
    /// Command-attempt identifier copied from the action.
    pub request_id: Uuid,
    /// Stable retry key copied from the action.
    pub idempotency_key: Uuid,
    /// Safe point-in-time run projection.
    pub run: DiscoveryRunProjection,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_config_is_strict_ordered_and_provider_mapped() {
        let valid = DiscoverySourceConfig {
            mode: DiscoverySourceMode::Waterfall,
            sources: vec![
                DiscoverySource::GoogleMaps,
                DiscoverySource::BraveSearch,
                DiscoverySource::ExaSearch,
            ],
        };
        assert_eq!(valid.validate(), Ok(()));
        assert_eq!(
            valid.providers(),
            vec![
                DiscoveryProvider::Outscraper,
                DiscoveryProvider::BraveSearch,
                DiscoveryProvider::ExaSearch,
            ]
        );
        assert_eq!(
            serde_json::to_value(&valid).expect("serialize source config"),
            serde_json::json!({
                "mode": "waterfall",
                "sources": ["google_maps", "brave_search", "exa_search"]
            })
        );

        for invalid in [
            DiscoverySourceConfig {
                mode: DiscoverySourceMode::Waterfall,
                sources: vec![],
            },
            DiscoverySourceConfig {
                mode: DiscoverySourceMode::Concurrent,
                sources: vec![DiscoverySource::BraveSearch, DiscoverySource::BraveSearch],
            },
            DiscoverySourceConfig {
                mode: DiscoverySourceMode::Concurrent,
                sources: vec![
                    DiscoverySource::GoogleMaps,
                    DiscoverySource::BraveSearch,
                    DiscoverySource::ExaSearch,
                    DiscoverySource::GoogleMaps,
                ],
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn source_config_has_a_legacy_safe_default_and_denies_unknown_fields() {
        assert_eq!(
            DiscoverySourceConfig::default(),
            DiscoverySourceConfig {
                mode: DiscoverySourceMode::Waterfall,
                sources: vec![DiscoverySource::GoogleMaps],
            }
        );
        assert!(
            serde_json::from_value::<DiscoverySourceConfig>(serde_json::json!({
                "mode": "concurrent",
                "sources": ["brave_search", "exa_search"],
                "api_key": "must-not-fit-the-schema"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<DiscoverySourceConfig>(serde_json::json!({
                "mode": "concurrent",
                "sources": ["unknown_source"]
            }))
            .is_err()
        );
    }

    fn business_search() -> DiscoveryBusinessSearchSpec {
        DiscoveryBusinessSearchSpec {
            query: "dentists".to_owned(),
            location: "Sandton, Johannesburg, South Africa".to_owned(),
            limit: 100,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        }
    }

    #[test]
    fn business_search_contract_is_bounded_and_non_secret() {
        let valid = business_search();
        assert_eq!(valid.validate(), Ok(()));

        for invalid in [
            DiscoveryBusinessSearchSpec {
                query: "dentists ".to_owned(),
                ..valid.clone()
            },
            DiscoveryBusinessSearchSpec {
                query: "é".repeat(129),
                ..valid.clone()
            },
            DiscoveryBusinessSearchSpec {
                location: "Sandton\nJohannesburg".to_owned(),
                ..valid.clone()
            },
            DiscoveryBusinessSearchSpec {
                limit: 0,
                ..valid.clone()
            },
            DiscoveryBusinessSearchSpec {
                limit: 501,
                ..valid.clone()
            },
            DiscoveryBusinessSearchSpec {
                language: "eng".to_owned(),
                ..valid.clone()
            },
            DiscoveryBusinessSearchSpec {
                region: Some("ZAF".to_owned()),
                ..valid.clone()
            },
        ] {
            assert!(invalid.validate().is_err(), "invalid search was accepted");
        }

        let serialized = serde_json::to_string(&valid).expect("serialize search");
        assert_eq!(
            valid.provider_query(),
            "dentists, Sandton, Johannesburg, South Africa"
        );
        assert!(!serialized.contains("api_key"));
        assert!(!serialized.contains("credential"));
        assert!(!serialized.contains("http://"));
        assert!(!serialized.contains("https://"));
    }

    #[test]
    fn terminal_states_are_terminal() {
        assert!(!DiscoveryRunState::Queued.is_terminal());
        assert!(!DiscoveryRunState::Running.is_terminal());
        assert!(DiscoveryRunState::Succeeded.is_terminal());
        assert!(DiscoveryRunState::Cancelled.is_terminal());
        assert!(DiscoveryRunState::Failed.is_terminal());
    }

    #[test]
    fn entitlement_revocation_is_a_stable_terminal_reason() {
        let json = serde_json::to_string(&DiscoveryTerminalReason::EntitlementRevoked)
            .expect("test serialization must succeed");
        assert_eq!(json, "\"entitlement_revoked\"");
    }

    #[test]
    fn discovery_money_is_canonical_integer_string_json() {
        let price =
            DiscoveryNanoUsd::new(DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD).expect("launch price");
        assert_eq!(serde_json::to_value(price).expect("serialize"), "50000000");
        assert_eq!(
            serde_json::from_value::<DiscoveryNanoUsd>(serde_json::json!("50000000"))
                .expect("decode"),
            price
        );
        for invalid in [
            serde_json::json!(50_000_000),
            serde_json::json!("-1"),
            serde_json::json!("01"),
            serde_json::json!("9223372036854775808"),
        ] {
            assert!(serde_json::from_value::<DiscoveryNanoUsd>(invalid).is_err());
        }
    }

    #[test]
    fn hosted_start_is_protocol_three_and_released_start_still_decodes() {
        let hosted = DiscoveryStartRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            campaign_id: Uuid::new_v4(),
            protocol_version: DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
            business_search: None,
        };
        assert_eq!(hosted.validate(), Ok(()));
        assert_eq!(
            serde_json::to_value(&hosted).expect("serialize hosted start")["protocol_version"],
            3
        );

        let released = serde_json::json!({
            "request_id": Uuid::new_v4(),
            "idempotency_key": Uuid::new_v4(),
            "campaign_id": Uuid::new_v4(),
            "business_search": business_search()
        });
        let released: DiscoveryStartRequest =
            serde_json::from_value(released).expect("decode released start");
        assert_eq!(released.protocol_version, 2);
        assert!(released.business_search.is_some());
        assert_eq!(released.validate(), Ok(()));
    }

    #[test]
    fn paid_run_billing_rejects_partial_or_inconsistent_settlement() {
        let payer = PublicKey::from_hex(&"33".repeat(32)).expect("payer");
        let price =
            DiscoveryNanoUsd::new(DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD).expect("launch price");
        let mut billing = DiscoveryRunBillingProjection {
            payer_pubkey: payer,
            price_per_retained_lead_nanousd: price,
            billable_lead_limit: 10,
            reserved_nanousd: price.checked_mul(10).expect("reservation"),
            settled_nanousd: None,
            released_nanousd: None,
            billed_retained_lead_count: None,
            settlement_ref: None,
            settled_at: None,
        };
        assert_eq!(billing.validate(), Ok(()));

        billing.settled_nanousd = Some(price.checked_mul(4).expect("settlement"));
        assert!(billing.validate().is_err());
        billing.released_nanousd = Some(price.checked_mul(6).expect("release"));
        billing.billed_retained_lead_count = Some(4);
        billing.settlement_ref = Some("discovery:run:test".to_owned());
        billing.settled_at = Some(Utc::now());
        assert_eq!(billing.validate(), Ok(()));

        let mut mismatched = billing;
        mismatched.billed_retained_lead_count = Some(5);
        assert!(mismatched.validate().is_err());
    }

    #[test]
    fn protocol_three_run_requires_terminal_settlement_coherence() {
        let payer = PublicKey::from_hex(&"44".repeat(32)).expect("payer");
        let price =
            DiscoveryNanoUsd::new(DISCOVERY_RETAINED_LEAD_PRICE_NANOUSD).expect("launch price");
        let billing = DiscoveryRunBillingProjection {
            payer_pubkey: payer,
            price_per_retained_lead_nanousd: price,
            billable_lead_limit: 2,
            reserved_nanousd: price.checked_mul(2).expect("reservation"),
            settled_nanousd: None,
            released_nanousd: None,
            billed_retained_lead_count: None,
            settlement_ref: None,
            settled_at: None,
        };
        let mut run = DiscoveryRunProjection {
            run_id: Uuid::new_v4(),
            campaign_id: Uuid::new_v4(),
            protocol_version: DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
            state: DiscoveryRunState::Queued,
            completed_steps: 0,
            total_steps: 1,
            cancel_requested: false,
            terminal_reason: None,
            billing: Some(billing),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        assert_eq!(run.validate(), Ok(()));
        run.state = DiscoveryRunState::Succeeded;
        assert!(run.validate().is_err());
        run.protocol_version = DISCOVERY_RELEASED_PROTOCOL_VERSION;
        run.state = DiscoveryRunState::Queued;
        assert!(run.validate().is_err());
    }
}
