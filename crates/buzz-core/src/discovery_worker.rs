//! Core contracts for trusted local Discovery workers.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

pub use crate::discovery::DiscoveryProvider;
use crate::discovery::{
    DiscoveryBusinessSearchSpec, DiscoveryRunProjection, DiscoverySource, DiscoverySourceConfig,
};

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
    /// Persist one source's truthful execution state and provider counts.
    SourceProgress,
    /// Persist a bounded batch of normalized provider observations.
    StoreObservations,
    /// Recover a paid result batch after its original run became terminal.
    SalvageObservations,
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
const MAX_AVAILABLE_PROVIDERS: usize = 3;

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
    /// Deterministic UUIDv5 derived from provider plus provider record identifier.
    pub observation_id: Uuid,
    /// Provider that produced this observation.
    #[serde(
        default = "default_outscraper_provider",
        skip_serializing_if = "is_outscraper_provider"
    )]
    pub provider: DiscoveryProvider,
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
    /// Bounded public provider summary, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
        let current_id =
            deterministic_business_observation_id(self.provider, &self.provider_record_id);
        let released_outscraper_id = (self.provider == DiscoveryProvider::Outscraper)
            .then(|| legacy_outscraper_business_observation_id(&self.provider_record_id));
        if self.observation_id != current_id && released_outscraper_id != Some(self.observation_id)
        {
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
        validate_optional_text(&self.description, 2_048, "description")?;
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
            &self.description,
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
    /// Provider that produced every observation in this batch.
    pub provider: DiscoveryProvider,
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
        validate_observation_batch(
            self.provider,
            &self.provider_request_id,
            self.batch_index,
            &self.observations,
        )
    }
}

fn validate_observation_batch(
    provider: DiscoveryProvider,
    provider_request_id: &str,
    batch_index: u32,
    observations: &[DiscoveryBusinessObservationInput],
) -> Result<(), DiscoveryObservationError> {
    validate_identifier(
        provider_request_id,
        MAX_PROVIDER_REQUEST_ID_BYTES,
        false,
        "provider_request_id",
    )?;
    if batch_index > MAX_OBSERVATION_BATCH_INDEX {
        return Err(DiscoveryObservationError::InvalidField("batch_index"));
    }
    if observations.is_empty() || observations.len() > MAX_OBSERVATIONS_PER_BATCH {
        return Err(DiscoveryObservationError::InvalidField("observations"));
    }
    let mut provider_ids = HashSet::with_capacity(observations.len());
    let mut retained_text_bytes = provider_request_id.len();
    for observation in observations {
        observation.validate()?;
        if observation.provider != provider {
            return Err(DiscoveryObservationError::InvalidField("provider"));
        }
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

/// Request to recover one durable paid-result batch after lease loss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerSalvageBatchRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this exact result batch.
    pub idempotency_key: Uuid,
    /// Stable identifier for this local worker installation.
    pub worker_id: Uuid,
    /// Original terminal run that paid for the observations.
    pub run_id: Uuid,
    /// Provider that produced every observation in this batch.
    pub provider: DiscoveryProvider,
    /// Opaque provider request reference retained in the local outbox.
    pub provider_request_id: String,
    /// Zero-based batch position within the bounded response.
    pub batch_index: u32,
    /// Normalized allowlisted observations.
    pub observations: Vec<DiscoveryBusinessObservationInput>,
}

impl DiscoveryWorkerSalvageBatchRequest {
    /// Validate terminal recovery identifiers and observation bounds.
    pub fn validate(&self) -> Result<(), DiscoveryObservationError> {
        if [
            self.request_id,
            self.idempotency_key,
            self.worker_id,
            self.run_id,
        ]
        .into_iter()
        .any(|value| value.is_nil())
        {
            return Err(DiscoveryObservationError::InvalidField("salvage"));
        }
        validate_observation_batch(
            self.provider,
            &self.provider_request_id,
            self.batch_index,
            &self.observations,
        )
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

/// Private result of recovering one paid batch into a terminal run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerSalvagedObservationsProjection {
    /// Original terminal run that now owns the recovered Leads.
    pub run: DiscoveryRunProjection,
    /// Records inserted by this write.
    pub accepted_count: u16,
    /// Identical workspace records already present.
    pub existing_count: u16,
}

/// Derive stable provider-scoped observation identity for retry-safe inserts.
pub fn deterministic_business_observation_id(
    provider: DiscoveryProvider,
    provider_record_id: &str,
) -> Uuid {
    if provider == DiscoveryProvider::Outscraper {
        return legacy_outscraper_business_observation_id(provider_record_id);
    }
    let namespace = Uuid::new_v5(&Uuid::NAMESPACE_URL, b"colony.discovery.business/v2");
    let provider_record = format!("{}\0{provider_record_id}", provider_identity_text(provider));
    Uuid::new_v5(&namespace, provider_record.as_bytes())
}

fn legacy_outscraper_business_observation_id(provider_record_id: &str) -> Uuid {
    let namespace = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        b"colony.discovery.business/outscraper",
    );
    Uuid::new_v5(&namespace, provider_record_id.as_bytes())
}

/// Derive a lowercase canonical-domain digest for workspace deduplication.
pub fn canonical_business_domain_digest(website: &str) -> Option<[u8; 32]> {
    let url = Url::parse(website).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let canonical = host.strip_prefix("www.").unwrap_or(&host);
    (!canonical.is_empty()).then(|| Sha256::digest(canonical.as_bytes()).into())
}

/// Derive an exact normalized-phone digest for workspace deduplication.
pub fn normalized_business_phone_digest(phone: &str) -> Option<[u8; 32]> {
    let mut normalized = String::with_capacity(phone.len());
    for (index, character) in phone.chars().enumerate() {
        if character.is_ascii_digit() || (character == '+' && index == 0) {
            normalized.push(character);
        }
    }
    (normalized.chars().filter(char::is_ascii_digit).count() >= 7)
        .then(|| Sha256::digest(normalized.as_bytes()).into())
}

/// Derive a normalized name-plus-locality digest for workspace deduplication.
pub fn normalized_business_name_locality_digest(
    name: &str,
    city: Option<&str>,
    state: Option<&str>,
    country: Option<&str>,
) -> Option<[u8; 32]> {
    let locality = city.or(state).or(country)?;
    let name = normalized_business_text(name);
    let locality = normalized_business_text(locality);
    if name.is_empty() || locality.is_empty() {
        return None;
    }
    Some(Sha256::digest(format!("{name}\u{1f}{locality}").as_bytes()).into())
}

fn normalized_business_text(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn provider_identity_text(provider: DiscoveryProvider) -> &'static str {
    match provider {
        DiscoveryProvider::Outscraper => "outscraper",
        DiscoveryProvider::BraveSearch => "brave_search",
        DiscoveryProvider::ExaSearch => "exa_search",
    }
}

fn default_outscraper_provider() -> DiscoveryProvider {
    DiscoveryProvider::Outscraper
}

fn is_outscraper_provider(provider: &DiscoveryProvider) -> bool {
    *provider == DiscoveryProvider::Outscraper
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
    /// Ordered, unique providers configured on this device. No credential data is included.
    pub available_providers: Vec<DiscoveryProvider>,
}

impl DiscoveryWorkerClaimRequest {
    /// Validate the non-secret capability advertisement used for run matching.
    pub fn validate(&self) -> Result<(), DiscoveryWorkerClaimError> {
        if self.available_providers.is_empty()
            || self.available_providers.len() > MAX_AVAILABLE_PROVIDERS
            || self
                .available_providers
                .iter()
                .enumerate()
                .any(|(index, provider)| self.available_providers[..index].contains(provider))
        {
            return Err(DiscoveryWorkerClaimError::InvalidAvailableProviders);
        }
        Ok(())
    }
}

/// Why a local worker capability advertisement was refused.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DiscoveryWorkerClaimError {
    /// The provider list was empty, too large, or contained duplicates.
    #[error("invalid Discovery worker provider capabilities")]
    InvalidAvailableProviders,
}

/// Durable execution state for one source in an immutable run plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryRunSourceStatus {
    /// The source has not started.
    Pending,
    /// The source currently has work in progress.
    Active,
    /// The source completed normally.
    Completed,
    /// The source produced no further candidates.
    Exhausted,
    /// The source stopped after a classified failure.
    Failed,
    /// The source was cancelled.
    Cancelled,
    /// The worker cannot prove whether a submitted request completed.
    OutcomeUnknown,
    /// Waterfall execution stopped because the target was already met.
    SkippedTargetMet,
}

/// Privacy-safe class for a source execution failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryRunSourceFailureClass {
    /// The configured provider credential was rejected.
    CredentialRejected,
    /// The provider account requires billing or funds.
    BillingRequired,
    /// The provider rejected the request shape.
    InvalidRequest,
    /// The provider rate-limited the worker.
    RateLimited,
    /// The provider was temporarily unavailable.
    ProviderUnavailable,
    /// The provider response exceeded Colony's safety bound.
    ResponseTooLarge,
    /// The provider request exceeded its time bound.
    RequestTimedOut,
    /// The provider response could not be normalized safely.
    MalformedResponse,
    /// The worker cannot determine the submitted request outcome.
    OutcomeUnknown,
    /// Execution was cancelled before this source completed.
    Cancelled,
}

/// Why a local worker source-progress request was refused.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DiscoverySourceProgressError {
    /// The lease, provider cursor, status, failure, or counts are inconsistent.
    #[error("invalid Discovery source progress")]
    InvalidProgress,
}

/// Durable, non-secret progress for one source in a leased run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryRunSourceProjection {
    /// User-facing source key.
    pub source: DiscoverySource,
    /// Local provider required by the source.
    pub provider: DiscoveryProvider,
    /// Stable zero-based position in the immutable source plan.
    pub position: u8,
    /// Current source execution state.
    pub status: DiscoveryRunSourceStatus,
    /// Opaque restart cursor, when a request has been submitted.
    pub request_cursor: Option<String>,
    /// Provider requests attempted for this source.
    pub request_count: u32,
    /// Provider records returned for this source.
    pub returned_count: u32,
    /// New workspace records retained from this source.
    pub retained_count: u32,
    /// Existing workspace records skipped from this source.
    pub duplicate_count: u32,
    /// Privacy-safe failure class, when the source failed.
    pub failure_class: Option<DiscoveryRunSourceFailureClass>,
    /// First durable start time.
    pub started_at: Option<DateTime<Utc>>,
    /// Durable terminal time.
    pub finished_at: Option<DateTime<Utc>>,
    /// Last durable progress update.
    pub updated_at: DateTime<Utc>,
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

/// Absolute, privacy-safe progress for one provider in the immutable run plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerSourceProgressRequest {
    /// Current lease identity and command retry identifiers.
    #[serde(flatten)]
    pub lease: DiscoveryWorkerLeaseRequest,
    /// Provider whose source row is being updated.
    pub provider: DiscoveryProvider,
    /// New durable source status.
    pub status: DiscoveryRunSourceStatus,
    /// Opaque resumable provider cursor, when one exists.
    pub request_cursor: Option<String>,
    /// Absolute provider requests attempted by this source.
    pub request_count: u32,
    /// Absolute provider records returned by this source.
    pub returned_count: u32,
    /// Privacy-safe terminal failure, when applicable.
    pub failure_class: Option<DiscoveryRunSourceFailureClass>,
}

impl DiscoveryWorkerSourceProgressRequest {
    /// Validate state/failure consistency without accepting provider details.
    pub fn validate(&self) -> Result<(), DiscoverySourceProgressError> {
        if [
            self.lease.request_id,
            self.lease.idempotency_key,
            self.lease.worker_id,
            self.lease.run_id,
            self.lease.lease_id,
        ]
        .into_iter()
        .any(|value| value.is_nil())
            || self.returned_count > 500
            || self.request_cursor.as_deref().is_some_and(|cursor| {
                cursor.is_empty()
                    || cursor.len() > MAX_PROVIDER_REQUEST_ID_BYTES
                    || !cursor
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
        {
            return Err(DiscoverySourceProgressError::InvalidProgress);
        }
        let valid = match self.status {
            DiscoveryRunSourceStatus::Pending => false,
            DiscoveryRunSourceStatus::Active => self.failure_class.is_none(),
            DiscoveryRunSourceStatus::Completed => {
                self.request_count > 0 && self.returned_count > 0 && self.failure_class.is_none()
            }
            DiscoveryRunSourceStatus::Exhausted => {
                self.request_count > 0 && self.returned_count == 0 && self.failure_class.is_none()
            }
            DiscoveryRunSourceStatus::Failed => {
                matches!(
                    self.failure_class,
                    Some(
                        DiscoveryRunSourceFailureClass::CredentialRejected
                            | DiscoveryRunSourceFailureClass::BillingRequired
                            | DiscoveryRunSourceFailureClass::InvalidRequest
                            | DiscoveryRunSourceFailureClass::RateLimited
                            | DiscoveryRunSourceFailureClass::ProviderUnavailable
                            | DiscoveryRunSourceFailureClass::ResponseTooLarge
                            | DiscoveryRunSourceFailureClass::RequestTimedOut
                            | DiscoveryRunSourceFailureClass::MalformedResponse
                    )
                ) && (self.request_count > 0
                    || self.failure_class == Some(DiscoveryRunSourceFailureClass::InvalidRequest))
            }
            DiscoveryRunSourceStatus::Cancelled => {
                self.failure_class == Some(DiscoveryRunSourceFailureClass::Cancelled)
            }
            DiscoveryRunSourceStatus::OutcomeUnknown => {
                self.request_count > 0
                    && self.failure_class == Some(DiscoveryRunSourceFailureClass::OutcomeUnknown)
            }
            DiscoveryRunSourceStatus::SkippedTargetMet => {
                self.request_cursor.is_none()
                    && self.request_count == 0
                    && self.returned_count == 0
                    && self.failure_class.is_none()
            }
        };
        valid
            .then_some(())
            .ok_or(DiscoverySourceProgressError::InvalidProgress)
    }
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
    /// Persist one source's state and absolute counts.
    SourceProgress(DiscoveryWorkerSourceProgressRequest),
    /// Persist normalized observations.
    StoreObservations(DiscoveryWorkerObservationBatchRequest),
    /// Recover normalized paid results after the original lease was lost.
    SalvageObservations(DiscoveryWorkerSalvageBatchRequest),
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
            Self::SourceProgress(_) => DiscoveryWorkerOperation::SourceProgress,
            Self::StoreObservations(_) => DiscoveryWorkerOperation::StoreObservations,
            Self::SalvageObservations(_) => DiscoveryWorkerOperation::SalvageObservations,
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
            Self::SourceProgress(value) => value.lease.request_id,
            Self::StoreObservations(value) => value.lease.request_id,
            Self::SalvageObservations(value) => value.request_id,
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
            Self::SourceProgress(value) => value.lease.idempotency_key,
            Self::StoreObservations(value) => value.lease.idempotency_key,
            Self::SalvageObservations(value) => value.idempotency_key,
        }
    }

    /// Local worker installation identifier carried by this action.
    pub const fn worker_id(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.worker_id,
            Self::Heartbeat(value) | Self::Fail(value) | Self::Complete(value) => value.worker_id,
            Self::Checkpoint(value) => value.lease.worker_id,
            Self::SourceProgress(value) => value.lease.worker_id,
            Self::StoreObservations(value) => value.lease.worker_id,
            Self::SalvageObservations(value) => value.worker_id,
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
    /// Immutable source configuration captured when the run started.
    #[serde(default, skip_serializing_if = "DiscoverySourceConfig::is_default")]
    pub source_config: DiscoverySourceConfig,
    /// Durable state for each source in exact plan order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_states: Vec<DiscoveryRunSourceProjection>,
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
    /// A durable paid batch was recovered after the run became terminal.
    ObservationsSalvaged(DiscoveryWorkerSalvagedObservationsProjection),
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
            observation_id: deterministic_business_observation_id(
                DiscoveryProvider::Outscraper,
                provider_record_id,
            ),
            provider: DiscoveryProvider::Outscraper,
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
            description: None,
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
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: "request_123".to_owned(),
            batch_index: 0,
            observations: vec![observation("0xabc:0xdef")],
        }
    }

    fn source_progress(status: DiscoveryRunSourceStatus) -> DiscoveryWorkerSourceProgressRequest {
        DiscoveryWorkerSourceProgressRequest {
            lease: DiscoveryWorkerLeaseRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                worker_id: Uuid::new_v4(),
                run_id: Uuid::new_v4(),
                lease_id: Uuid::new_v4(),
            },
            provider: DiscoveryProvider::BraveSearch,
            status,
            request_cursor: None,
            request_count: 0,
            returned_count: 0,
            failure_class: None,
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
        assert_eq!(
            serde_json::to_string(&DiscoveryWorkerOperation::SourceProgress)
                .expect("serialize source progress operation"),
            "\"source_progress\""
        );
    }

    #[test]
    fn claim_rejects_unknown_fields() {
        let value = serde_json::json!({
            "request_id": Uuid::new_v4(),
            "idempotency_key": Uuid::new_v4(),
            "worker_id": Uuid::new_v4(),
            "available_providers": ["outscraper"],
            "api_key": "must-not-fit-the-schema"
        });
        assert!(serde_json::from_value::<DiscoveryWorkerClaimRequest>(value).is_err());
    }

    #[test]
    fn claim_capabilities_are_nonempty_unique_and_secret_free() {
        let mut request = DiscoveryWorkerClaimRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: Uuid::new_v4(),
            available_providers: vec![
                DiscoveryProvider::Outscraper,
                DiscoveryProvider::BraveSearch,
                DiscoveryProvider::ExaSearch,
            ],
        };
        assert_eq!(request.validate(), Ok(()));
        assert_eq!(
            serde_json::to_value(&request).expect("serialize claim")["available_providers"],
            serde_json::json!(["outscraper", "brave_search", "exa_search"])
        );

        request.available_providers.clear();
        assert!(request.validate().is_err());
        request.available_providers =
            vec![DiscoveryProvider::Outscraper, DiscoveryProvider::Outscraper];
        assert!(request.validate().is_err());

        let legacy_without_capabilities = serde_json::json!({
            "request_id": Uuid::new_v4(),
            "idempotency_key": Uuid::new_v4(),
            "worker_id": Uuid::new_v4()
        });
        assert!(
            serde_json::from_value::<DiscoveryWorkerClaimRequest>(legacy_without_capabilities)
                .is_err()
        );
    }

    #[test]
    fn observation_batch_is_strict_bounded_and_workspace_deterministic() {
        let valid = batch();
        assert_eq!(valid.validate(), Ok(()));
        assert_eq!(
            deterministic_business_observation_id(DiscoveryProvider::Outscraper, "0xabc:0xdef"),
            observation("0xabc:0xdef").observation_id
        );
        assert_ne!(
            deterministic_business_observation_id(DiscoveryProvider::Outscraper, "0xabc:0xdef"),
            deterministic_business_observation_id(DiscoveryProvider::BraveSearch, "0xabc:0xdef")
        );
        let mut released_outscraper = observation("legacy-provider-record");
        released_outscraper.observation_id =
            legacy_outscraper_business_observation_id("legacy-provider-record");
        assert_eq!(released_outscraper.validate(), Ok(()));

        assert_eq!(
            canonical_business_domain_digest("HTTPS://WWW.Example.COM/path?q=1#fragment"),
            canonical_business_domain_digest("https://example.com/other")
        );
        assert_eq!(
            normalized_business_phone_digest("+27 (11) 555-0100"),
            normalized_business_phone_digest("+27115550100")
        );
        assert_eq!(
            normalized_business_name_locality_digest(
                "Sandton Dental Studio",
                Some("Sandton"),
                None,
                None
            ),
            normalized_business_name_locality_digest(
                "SANDTON-DENTAL STUDIO",
                Some("sandton"),
                None,
                None
            )
        );

        let mut with_description = valid.clone();
        with_description.observations[0].provider = DiscoveryProvider::BraveSearch;
        with_description.observations[0].observation_id = deterministic_business_observation_id(
            DiscoveryProvider::BraveSearch,
            &with_description.observations[0].provider_record_id,
        );
        with_description.provider = DiscoveryProvider::BraveSearch;
        with_description.observations[0].description = Some("Public search snippet".to_owned());
        assert_eq!(with_description.validate(), Ok(()));
        let mut mismatched_provider = with_description.clone();
        mismatched_provider.provider = DiscoveryProvider::ExaSearch;
        assert!(mismatched_provider.validate().is_err());
        let mut oversized_description = with_description;
        oversized_description.observations[0].description = Some("x".repeat(2_049));
        assert!(oversized_description.validate().is_err());

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

    #[test]
    fn source_progress_is_absolute_strict_and_privacy_safe() {
        let active = source_progress(DiscoveryRunSourceStatus::Active);
        assert_eq!(active.validate(), Ok(()));

        let mut submitted = active.clone();
        submitted.provider = DiscoveryProvider::Outscraper;
        submitted.request_cursor = Some("provider-request_1".to_owned());
        submitted.request_count = 1;
        assert_eq!(submitted.validate(), Ok(()));

        let mut completed = active.clone();
        completed.status = DiscoveryRunSourceStatus::Completed;
        completed.request_count = 2;
        completed.returned_count = 20;
        assert_eq!(completed.validate(), Ok(()));

        let mut exhausted = active.clone();
        exhausted.status = DiscoveryRunSourceStatus::Exhausted;
        exhausted.request_count = 1;
        assert_eq!(exhausted.validate(), Ok(()));

        let mut failed = active.clone();
        failed.status = DiscoveryRunSourceStatus::Failed;
        failed.request_count = 1;
        failed.failure_class = Some(DiscoveryRunSourceFailureClass::CredentialRejected);
        assert_eq!(failed.validate(), Ok(()));

        let mut unknown = active.clone();
        unknown.status = DiscoveryRunSourceStatus::OutcomeUnknown;
        unknown.request_count = 1;
        unknown.failure_class = Some(DiscoveryRunSourceFailureClass::OutcomeUnknown);
        assert_eq!(unknown.validate(), Ok(()));

        let skipped = source_progress(DiscoveryRunSourceStatus::SkippedTargetMet);
        assert_eq!(skipped.validate(), Ok(()));

        for mut invalid in [
            source_progress(DiscoveryRunSourceStatus::Pending),
            source_progress(DiscoveryRunSourceStatus::Completed),
            source_progress(DiscoveryRunSourceStatus::Exhausted),
            source_progress(DiscoveryRunSourceStatus::Failed),
            source_progress(DiscoveryRunSourceStatus::OutcomeUnknown),
        ] {
            if invalid.status == DiscoveryRunSourceStatus::Exhausted {
                invalid.returned_count = 1;
                invalid.request_count = 1;
            }
            assert!(invalid.validate().is_err());
        }

        let mut raw = serde_json::to_value(&completed).expect("serialize source progress");
        raw.as_object_mut().expect("progress object").insert(
            "provider_error".to_owned(),
            serde_json::json!("must not enter the schema"),
        );
        assert!(serde_json::from_value::<DiscoveryWorkerSourceProgressRequest>(raw).is_err());
    }
}
