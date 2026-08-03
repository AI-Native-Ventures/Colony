//! Core contracts for trusted local Discovery workers.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub use crate::discovery::DiscoveryProvider;
use crate::discovery::{DiscoveryBusinessSearchSpec, DiscoveryRunProjection};

/// Operation requested by a trusted local Discovery worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryWorkerOperation {
    /// Claim the oldest eligible workspace run.
    Claim,
    /// Extend a currently owned lease.
    Heartbeat,
    /// Commit a monotonic non-secret execution checkpoint.
    Checkpoint,
    /// Persist a bounded batch of normalized provider observations.
    StoreObservations,
    /// Mark a currently leased run failed without retaining provider details.
    Fail,
    /// Mark a currently owned run successful.
    Complete,
}

const MAX_OBSERVATIONS_PER_BATCH: usize = 25;
const MAX_OBSERVATION_BATCH_INDEX: u32 = 19;
const MAX_OBSERVATION_BATCH_TEXT_BYTES: usize = 128 * 1024;
const MAX_PROVIDER_REQUEST_ID_BYTES: usize = 128;
const MAX_PROVIDER_RECORD_ID_BYTES: usize = 256;
const MAX_OBSERVATION_NAME_BYTES: usize = 256;
const MAX_OBSERVATION_TEXT_BYTES: usize = 512;
const MAX_OBSERVATION_SHORT_TEXT_BYTES: usize = 128;
const MAX_OBSERVATION_URL_BYTES: usize = 2_048;
const MAX_OBSERVATION_SUBTYPES: usize = 20;

/// Why a normalized provider observation was refused.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DiscoveryObservationError {
    /// A named field is empty, malformed, duplicated, or outside its bound.
    #[error("invalid Discovery business observation field: {0}")]
    InvalidField(&'static str),
}

/// Strict normalized operating status retained for one business observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryBusinessStatus {
    /// Provider reports that the business is operating.
    Operational,
    /// Provider reports a temporary closure.
    TemporarilyClosed,
    /// Provider reports a permanent closure.
    PermanentlyClosed,
}

/// Provider-neutral business fields Colony is allowed to retain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryBusinessObservationInput {
    /// Deterministic UUIDv5 derived from the run and provider record identifier.
    pub observation_id: Uuid,
    /// Stable provider identifier selected during normalization.
    pub provider_record_id: String,
    /// Google Places identifier, when returned.
    pub place_id: Option<String>,
    /// Google Maps feature identifier, when returned.
    pub google_id: Option<String>,
    /// Display name.
    pub name: String,
    /// Canonical business website.
    pub website: Option<String>,
    /// Public business telephone number.
    pub phone: Option<String>,
    /// Full postal address.
    pub full_address: Option<String>,
    /// City or locality.
    pub city: Option<String>,
    /// State, province, or region.
    pub state: Option<String>,
    /// Postal code.
    pub postal_code: Option<String>,
    /// Country display name.
    pub country: Option<String>,
    /// Uppercase ISO 3166-1 alpha-2 country code.
    pub country_code: Option<String>,
    /// Latitude multiplied by one million.
    pub latitude_micros: Option<i32>,
    /// Longitude multiplied by one million.
    pub longitude_micros: Option<i32>,
    /// Primary provider category.
    pub category: Option<String>,
    /// Bounded secondary provider categories.
    pub subtypes: Vec<String>,
    /// Rating multiplied by one hundred.
    pub rating_hundredths: Option<u16>,
    /// Public review count.
    pub reviews_count: Option<u32>,
    /// Strict normalized operating status.
    pub business_status: Option<DiscoveryBusinessStatus>,
    /// Provider verification signal.
    pub verified: Option<bool>,
    /// Public source listing URL.
    pub source_url: Option<String>,
    /// Public representative image URL.
    pub image_url: Option<String>,
}

impl DiscoveryBusinessObservationInput {
    /// Validate the retained allowlist and deterministic identity.
    pub fn validate(&self) -> Result<(), DiscoveryObservationError> {
        validate_identifier(
            &self.provider_record_id,
            MAX_PROVIDER_RECORD_ID_BYTES,
            true,
            "provider_record_id",
        )?;
        if self.observation_id != deterministic_business_observation_id(&self.provider_record_id) {
            return Err(DiscoveryObservationError::InvalidField("observation_id"));
        }
        validate_optional_identifier(&self.place_id, "place_id")?;
        validate_optional_identifier(&self.google_id, "google_id")?;
        validate_text(&self.name, MAX_OBSERVATION_NAME_BYTES, "name")?;
        validate_optional_url(&self.website, "website")?;
        validate_optional_text(&self.phone, 64, "phone")?;
        validate_optional_text(
            &self.full_address,
            MAX_OBSERVATION_TEXT_BYTES,
            "full_address",
        )?;
        for (value, field) in [
            (&self.city, "city"),
            (&self.state, "state"),
            (&self.postal_code, "postal_code"),
            (&self.country, "country"),
            (&self.category, "category"),
        ] {
            validate_optional_text(value, MAX_OBSERVATION_SHORT_TEXT_BYTES, field)?;
        }
        if self
            .country_code
            .as_deref()
            .is_some_and(|value| value.len() != 2 || !value.bytes().all(|b| b.is_ascii_uppercase()))
        {
            return Err(DiscoveryObservationError::InvalidField("country_code"));
        }
        if self
            .latitude_micros
            .is_some_and(|value| !(-90_000_000..=90_000_000).contains(&value))
        {
            return Err(DiscoveryObservationError::InvalidField("latitude_micros"));
        }
        if self
            .longitude_micros
            .is_some_and(|value| !(-180_000_000..=180_000_000).contains(&value))
        {
            return Err(DiscoveryObservationError::InvalidField("longitude_micros"));
        }
        if self.subtypes.len() > MAX_OBSERVATION_SUBTYPES {
            return Err(DiscoveryObservationError::InvalidField("subtypes"));
        }
        let mut unique_subtypes = HashSet::with_capacity(self.subtypes.len());
        for subtype in &self.subtypes {
            validate_text(subtype, MAX_OBSERVATION_SHORT_TEXT_BYTES, "subtypes")?;
            if !unique_subtypes.insert(subtype) {
                return Err(DiscoveryObservationError::InvalidField("subtypes"));
            }
        }
        if self.rating_hundredths.is_some_and(|value| value > 500) {
            return Err(DiscoveryObservationError::InvalidField("rating_hundredths"));
        }
        validate_optional_url(&self.source_url, "source_url")?;
        validate_optional_url(&self.image_url, "image_url")?;
        Ok(())
    }

    fn retained_text_bytes(&self) -> usize {
        let optional = [
            &self.place_id,
            &self.google_id,
            &self.website,
            &self.phone,
            &self.full_address,
            &self.city,
            &self.state,
            &self.postal_code,
            &self.country,
            &self.country_code,
            &self.category,
            &self.source_url,
            &self.image_url,
        ];
        self.provider_record_id.len()
            + self.name.len()
            + optional
                .into_iter()
                .filter_map(|value| value.as_deref())
                .map(str::len)
                .sum::<usize>()
            + self.subtypes.iter().map(String::len).sum::<usize>()
    }
}

/// Request to retain one bounded normalized result batch under a current lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerObservationBatchRequest {
    /// Current lease identity and command retry identifiers.
    #[serde(flatten)]
    pub lease: DiscoveryWorkerLeaseRequest,
    /// Opaque provider request reference previously checkpointed for this run.
    pub provider_request_id: String,
    /// Zero-based batch position within the bounded 500-result response.
    pub batch_index: u32,
    /// Normalized allowlisted observations.
    pub observations: Vec<DiscoveryBusinessObservationInput>,
}

impl DiscoveryWorkerObservationBatchRequest {
    /// Validate batch bounds, identifiers, and deterministic record identity.
    pub fn validate(&self) -> Result<(), DiscoveryObservationError> {
        if [
            self.lease.request_id,
            self.lease.idempotency_key,
            self.lease.worker_id,
            self.lease.run_id,
            self.lease.lease_id,
        ]
        .into_iter()
        .any(|value| value.is_nil())
        {
            return Err(DiscoveryObservationError::InvalidField("lease"));
        }
        validate_identifier(
            &self.provider_request_id,
            MAX_PROVIDER_REQUEST_ID_BYTES,
            false,
            "provider_request_id",
        )?;
        if self.batch_index > MAX_OBSERVATION_BATCH_INDEX {
            return Err(DiscoveryObservationError::InvalidField("batch_index"));
        }
        if self.observations.is_empty() || self.observations.len() > MAX_OBSERVATIONS_PER_BATCH {
            return Err(DiscoveryObservationError::InvalidField("observations"));
        }
        let mut provider_ids = HashSet::with_capacity(self.observations.len());
        let mut retained_text_bytes = self.provider_request_id.len();
        for observation in &self.observations {
            observation.validate()?;
            if !provider_ids.insert(observation.provider_record_id.as_str()) {
                return Err(DiscoveryObservationError::InvalidField("observations"));
            }
            retained_text_bytes = retained_text_bytes
                .checked_add(observation.retained_text_bytes())
                .ok_or(DiscoveryObservationError::InvalidField("observations"))?;
        }
        if retained_text_bytes > MAX_OBSERVATION_BATCH_TEXT_BYTES {
            return Err(DiscoveryObservationError::InvalidField("observations"));
        }
        Ok(())
    }
}

/// Private result of an idempotent observation batch write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerStoredObservationsProjection {
    /// Renewed current lease.
    pub lease: DiscoveryWorkerLeaseProjection,
    /// Records inserted by this write.
    pub accepted_count: u16,
    /// Identical records already present from an earlier write.
    pub existing_count: u16,
}

/// Derive stable per-run observation identity for retry-safe inserts.
pub fn deterministic_business_observation_id(provider_record_id: &str) -> Uuid {
    let namespace = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        b"colony.discovery.business/outscraper",
    );
    Uuid::new_v5(&namespace, provider_record_id.as_bytes())
}

fn validate_identifier(
    value: &str,
    max_bytes: usize,
    allow_colon: bool,
    field: &'static str,
) -> Result<(), DiscoveryObservationError> {
    let valid = !value.is_empty()
        && value.len() <= max_bytes
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_')
                || (allow_colon && byte == b':')
        });
    if valid {
        Ok(())
    } else {
        Err(DiscoveryObservationError::InvalidField(field))
    }
}

fn validate_optional_identifier(
    value: &Option<String>,
    field: &'static str,
) -> Result<(), DiscoveryObservationError> {
    match value {
        Some(value) => validate_identifier(value, MAX_PROVIDER_RECORD_ID_BYTES, true, field),
        None => Ok(()),
    }
}

fn validate_text(
    value: &str,
    max_bytes: usize,
    field: &'static str,
) -> Result<(), DiscoveryObservationError> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        Err(DiscoveryObservationError::InvalidField(field))
    } else {
        Ok(())
    }
}

fn validate_optional_text(
    value: &Option<String>,
    max_bytes: usize,
    field: &'static str,
) -> Result<(), DiscoveryObservationError> {
    match value {
        Some(value) => validate_text(value, max_bytes, field),
        None => Ok(()),
    }
}

fn validate_optional_url(
    value: &Option<String>,
    field: &'static str,
) -> Result<(), DiscoveryObservationError> {
    match value {
        Some(value)
            if value.len() <= MAX_OBSERVATION_URL_BYTES
                && value == value.trim()
                && !value.chars().any(char::is_control)
                && (value.starts_with("https://") || value.starts_with("http://")) =>
        {
            Ok(())
        }
        Some(_) => Err(DiscoveryObservationError::InvalidField(field)),
        None => Ok(()),
    }
}

/// Durable boundary reached by the local worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryCheckpointKind {
    /// The provider accepted a request and returned an opaque request reference.
    ProviderSubmitted,
    /// The provider request returned a bounded number of results.
    ProviderResultsReady,
}

/// Request to claim one eligible workspace run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerClaimRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this logical command.
    pub idempotency_key: Uuid,
    /// Stable identifier for this local worker installation.
    pub worker_id: Uuid,
}

/// Request operating on a currently owned worker lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerLeaseRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this logical command.
    pub idempotency_key: Uuid,
    /// Stable identifier for this local worker installation.
    pub worker_id: Uuid,
    /// Durable run being operated.
    pub run_id: Uuid,
    /// Random relay-issued fencing token for the current lease.
    pub lease_id: Uuid,
}

/// Strict, non-secret checkpoint persisted for restart recovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerCheckpoint {
    /// Monotonic one-based checkpoint sequence within the run.
    pub sequence: u32,
    /// Durable execution boundary represented by this checkpoint.
    pub kind: DiscoveryCheckpointKind,
    /// Provider associated with the checkpoint.
    pub provider: DiscoveryProvider,
    /// Strict opaque provider reference, only for `provider_submitted`.
    pub provider_request_id: Option<String>,
    /// Returned result count, only for `provider_results_ready`.
    pub item_count: Option<u32>,
}

/// Request to commit a checkpoint under a current lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerCheckpointRequest {
    /// Current lease identity and command retry identifiers.
    #[serde(flatten)]
    pub lease: DiscoveryWorkerLeaseRequest,
    /// Monotonic checkpoint to persist.
    pub checkpoint: DiscoveryWorkerCheckpoint,
}

/// Validated operation-specific local worker action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryWorkerAction {
    /// Claim one eligible workspace run.
    Claim(DiscoveryWorkerClaimRequest),
    /// Extend a current lease.
    Heartbeat(DiscoveryWorkerLeaseRequest),
    /// Persist restart-safe progress.
    Checkpoint(DiscoveryWorkerCheckpointRequest),
    /// Persist normalized observations.
    StoreObservations(DiscoveryWorkerObservationBatchRequest),
    /// Fail a current run without a provider error payload.
    Fail(DiscoveryWorkerLeaseRequest),
    /// Complete a current run.
    Complete(DiscoveryWorkerLeaseRequest),
}

impl DiscoveryWorkerAction {
    /// Operation represented by this action.
    pub const fn operation(&self) -> DiscoveryWorkerOperation {
        match self {
            Self::Claim(_) => DiscoveryWorkerOperation::Claim,
            Self::Heartbeat(_) => DiscoveryWorkerOperation::Heartbeat,
            Self::Checkpoint(_) => DiscoveryWorkerOperation::Checkpoint,
            Self::StoreObservations(_) => DiscoveryWorkerOperation::StoreObservations,
            Self::Fail(_) => DiscoveryWorkerOperation::Fail,
            Self::Complete(_) => DiscoveryWorkerOperation::Complete,
        }
    }

    /// Command-attempt identifier carried by this action.
    pub const fn request_id(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.request_id,
            Self::Heartbeat(value) | Self::Fail(value) | Self::Complete(value) => value.request_id,
            Self::Checkpoint(value) => value.lease.request_id,
            Self::StoreObservations(value) => value.lease.request_id,
        }
    }

    /// Stable retry key carried by this action.
    pub const fn idempotency_key(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.idempotency_key,
            Self::Heartbeat(value) | Self::Fail(value) | Self::Complete(value) => {
                value.idempotency_key
            }
            Self::Checkpoint(value) => value.lease.idempotency_key,
            Self::StoreObservations(value) => value.lease.idempotency_key,
        }
    }

    /// Local worker installation identifier carried by this action.
    pub const fn worker_id(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.worker_id,
            Self::Heartbeat(value) | Self::Fail(value) | Self::Complete(value) => value.worker_id,
            Self::Checkpoint(value) => value.lease.worker_id,
            Self::StoreObservations(value) => value.lease.worker_id,
        }
    }
}

/// Current fenced lease returned to a local worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerLeaseProjection {
    /// Stable local worker installation identifier.
    pub worker_id: Uuid,
    /// Relay-issued random fencing token.
    pub lease_id: Uuid,
    /// Monotonically increasing run attempt number.
    pub attempt: u32,
    /// Relay-owned lease expiry.
    pub lease_until: DateTime<Utc>,
    /// Safe run projection.
    pub run: DiscoveryRunProjection,
    /// Immutable non-secret Businesses query captured when the run started.
    pub business_search: DiscoveryBusinessSearchSpec,
    /// Latest durable restart checkpoint, when present.
    pub last_checkpoint: Option<DiscoveryWorkerCheckpoint>,
}

/// Result of a worker command safe to return in a private relay receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status", content = "value")]
pub enum DiscoveryWorkerReceiptOutcome {
    /// No workspace run was currently eligible.
    Idle,
    /// The worker owns or renewed this lease.
    Lease(DiscoveryWorkerLeaseProjection),
    /// A bounded normalized batch was retained or already existed.
    ObservationsStored(DiscoveryWorkerStoredObservationsProjection),
    /// The supplied lease is no longer current.
    LostLease(DiscoveryRunProjection),
    /// The current lease completed its run.
    Completed(DiscoveryRunProjection),
    /// The current lease ended with a privacy-safe executor failure.
    Failed(DiscoveryRunProjection),
}

/// Relay-signed result of one local worker command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerReceipt {
    /// Operation processed by the relay.
    pub operation: DiscoveryWorkerOperation,
    /// Command-attempt identifier copied from the action.
    pub request_id: Uuid,
    /// Stable retry key copied from the action.
    pub idempotency_key: Uuid,
    /// Local worker installation addressed by the result.
    pub worker_id: Uuid,
    /// Private operation outcome.
    pub outcome: DiscoveryWorkerReceiptOutcome,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(provider_record_id: &str) -> DiscoveryBusinessObservationInput {
        DiscoveryBusinessObservationInput {
            observation_id: deterministic_business_observation_id(provider_record_id),
            provider_record_id: provider_record_id.to_owned(),
            place_id: Some("ChIJ_test".to_owned()),
            google_id: Some("0xabc:0xdef".to_owned()),
            name: "Sandton Dental Studio".to_owned(),
            website: Some("https://example.test".to_owned()),
            phone: Some("+27 11 555 0100".to_owned()),
            full_address: Some("1 Example Road, Sandton".to_owned()),
            city: Some("Sandton".to_owned()),
            state: Some("Gauteng".to_owned()),
            postal_code: Some("2196".to_owned()),
            country: Some("South Africa".to_owned()),
            country_code: Some("ZA".to_owned()),
            latitude_micros: Some(-26_107_600),
            longitude_micros: Some(28_056_700),
            category: Some("Dentist".to_owned()),
            subtypes: vec!["Dental clinic".to_owned()],
            rating_hundredths: Some(470),
            reviews_count: Some(52),
            business_status: Some(DiscoveryBusinessStatus::Operational),
            verified: Some(true),
            source_url: Some("https://maps.google.com/example".to_owned()),
            image_url: Some("https://images.example.test/place.jpg".to_owned()),
        }
    }

    fn batch() -> DiscoveryWorkerObservationBatchRequest {
        DiscoveryWorkerObservationBatchRequest {
            lease: DiscoveryWorkerLeaseRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                worker_id: Uuid::new_v4(),
                run_id: Uuid::new_v4(),
                lease_id: Uuid::new_v4(),
            },
            provider_request_id: "request_123".to_owned(),
            batch_index: 0,
            observations: vec![observation("0xabc:0xdef")],
        }
    }

    #[test]
    fn worker_operation_json_is_stable() {
        assert_eq!(
            serde_json::to_string(&DiscoveryWorkerOperation::Checkpoint)
                .expect("serialize operation"),
            "\"checkpoint\""
        );
        assert_eq!(
            serde_json::to_string(&DiscoveryWorkerOperation::Fail)
                .expect("serialize failure operation"),
            "\"fail\""
        );
    }

    #[test]
    fn claim_rejects_unknown_fields() {
        let value = serde_json::json!({
            "request_id": Uuid::new_v4(),
            "idempotency_key": Uuid::new_v4(),
            "worker_id": Uuid::new_v4(),
            "api_key": "must-not-fit-the-schema"
        });
        assert!(serde_json::from_value::<DiscoveryWorkerClaimRequest>(value).is_err());
    }

    #[test]
    fn observation_batch_is_strict_bounded_and_workspace_deterministic() {
        let valid = batch();
        assert_eq!(valid.validate(), Ok(()));
        assert_eq!(
            deterministic_business_observation_id("0xabc:0xdef"),
            observation("0xabc:0xdef").observation_id
        );

        let mut invalid = valid.clone();
        invalid.observations[0].rating_hundredths = Some(501);
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.observations[0].latitude_micros = Some(90_000_001);
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.observations[0].website = Some("javascript:alert(1)".to_owned());
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.observations.push(invalid.observations[0].clone());
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.observations[0].observation_id = Uuid::new_v4();
        assert!(invalid.validate().is_err());
        let long_url = format!("https://{}", "x".repeat(2_040));
        let mut invalid = valid.clone();
        invalid.observations = (0..22)
            .map(|index| {
                let provider_id = format!("provider_{index}");
                let mut observation = observation(&provider_id);
                observation.website = Some(long_url.clone());
                observation.source_url = Some(long_url.clone());
                observation.image_url = Some(long_url.clone());
                observation
            })
            .collect();
        assert!(invalid.validate().is_err());

        let mut raw = serde_json::to_value(&valid).expect("serialize batch");
        raw.as_object_mut().expect("batch object").insert(
            "raw_provider_payload".to_owned(),
            serde_json::json!({"secret": true}),
        );
        assert!(serde_json::from_value::<DiscoveryWorkerObservationBatchRequest>(raw).is_err());
    }
}
