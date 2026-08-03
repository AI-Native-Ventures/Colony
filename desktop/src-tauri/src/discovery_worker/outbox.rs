use std::{
    collections::HashSet,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    sync::Mutex,
};

use atomic_write_file::AtomicWriteFile;
use buzz_core_pkg::discovery_worker::{DiscoveryBusinessObservationInput, DiscoveryProvider};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use url::Url;
use uuid::Uuid;

use super::installation::{set_directory_owner_only, set_file_owner_only};

const OUTBOX_VERSION: u8 = 1;
const DISCOVERY_DIR: &str = "discovery";
const OUTBOX_DIR: &str = "outbox";
const MAX_OUTBOX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_OUTBOX_CALLS: usize = 128;
const MAX_RESULTS_PER_CALL: usize = 500;
const OBSERVATIONS_PER_BATCH: usize = 25;
const MAX_PROVIDER_REQUEST_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SynchronousCallState {
    Intent,
    Ready,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SynchronousCallIntent {
    pub(super) call_id: Uuid,
    pub(super) run_id: Uuid,
    pub(super) provider: DiscoveryProvider,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SynchronousOutboxBatch {
    pub(super) call_id: Uuid,
    pub(super) run_id: Uuid,
    pub(super) provider: DiscoveryProvider,
    pub(super) provider_request_id: String,
    pub(super) request_id: Uuid,
    pub(super) idempotency_key: Uuid,
    pub(super) batch_index: u32,
    pub(super) observations: Vec<DiscoveryBusinessObservationInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SynchronousReadyMetadata {
    pub(super) provider_request_id: String,
    pub(super) request_count: u16,
    pub(super) item_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct PersistedOutbox {
    version: u8,
    workspace_scope: String,
    calls: Vec<PersistedCall>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct PersistedCall {
    call_id: Uuid,
    run_id: Uuid,
    provider: DiscoveryProvider,
    state: PersistedCallState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status", deny_unknown_fields)]
enum PersistedCallState {
    Intent,
    Ready {
        provider_request_id: String,
        request_count: u16,
        item_count: u32,
        acknowledged_batches: usize,
        batches: Vec<PersistedBatch>,
    },
    OutcomeUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct PersistedBatch {
    request_id: Uuid,
    idempotency_key: Uuid,
    observations: Vec<DiscoveryBusinessObservationInput>,
}

pub(super) struct DiscoveryOutbox {
    path: PathBuf,
    state: Mutex<PersistedOutbox>,
}

impl DiscoveryOutbox {
    pub(super) fn open(
        app_data_dir: &Path,
        relay_url: &str,
        actor_pubkey: &str,
    ) -> Result<Self, String> {
        let workspace_scope = workspace_scope(relay_url, actor_pubkey)?;
        let outbox_dir = app_data_dir.join(DISCOVERY_DIR).join(OUTBOX_DIR);
        fs::create_dir_all(&outbox_dir)
            .map_err(|error| format!("create Discovery outbox directory: {error}"))?;
        set_directory_owner_only(&app_data_dir.join(DISCOVERY_DIR))?;
        set_directory_owner_only(&outbox_dir)?;
        let path = outbox_dir.join(format!("{workspace_scope}.json"));
        let mut state = load_outbox(&path, &workspace_scope)?;
        let recovered = state.calls.iter_mut().fold(false, |changed, call| {
            if matches!(call.state, PersistedCallState::Intent) {
                call.state = PersistedCallState::OutcomeUnknown;
                true
            } else {
                changed
            }
        });
        validate_outbox(&state, &workspace_scope)?;
        if recovered {
            persist_outbox(&path, &state)?;
        }
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    pub(super) fn begin_call(
        &self,
        run_id: Uuid,
        provider: DiscoveryProvider,
    ) -> Result<SynchronousCallIntent, String> {
        if run_id.is_nil() || !is_synchronous_provider(provider) {
            return Err("invalid synchronous Discovery call intent".to_owned());
        }
        self.update(|state| {
            if state
                .calls
                .iter()
                .any(|call| call.run_id == run_id && call.provider == provider)
            {
                return Err("a synchronous Discovery call already exists".to_owned());
            }
            if state.calls.len() >= MAX_OUTBOX_CALLS {
                return Err("the Discovery outbox is full".to_owned());
            }
            let intent = SynchronousCallIntent {
                call_id: Uuid::new_v4(),
                run_id,
                provider,
            };
            state.calls.push(PersistedCall {
                call_id: intent.call_id,
                run_id,
                provider,
                state: PersistedCallState::Intent,
            });
            Ok(intent)
        })
    }

    pub(super) fn record_results(
        &self,
        call_id: Uuid,
        provider_request_id: Option<String>,
        request_count: u16,
        observations: Vec<DiscoveryBusinessObservationInput>,
    ) -> Result<(), String> {
        if call_id.is_nil() || observations.len() > MAX_RESULTS_PER_CALL {
            return Err("invalid synchronous Discovery results".to_owned());
        }
        self.update(|state| {
            let call = state
                .calls
                .iter_mut()
                .find(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call intent was not found".to_owned())?;
            if !matches!(call.state, PersistedCallState::Intent) {
                return Err("Discovery call results were already resolved".to_owned());
            }
            let provider_request_id =
                provider_request_id.unwrap_or_else(|| call.call_id.to_string());
            validate_provider_request_id(&provider_request_id)?;
            let mut provider_records = HashSet::with_capacity(observations.len());
            for observation in &observations {
                observation
                    .validate()
                    .map_err(|_| "invalid normalized Discovery observation".to_owned())?;
                if observation.provider != call.provider
                    || !provider_records.insert(observation.provider_record_id.as_str())
                {
                    return Err("invalid normalized Discovery observation set".to_owned());
                }
            }
            let item_count = u32::try_from(observations.len())
                .map_err(|_| "too many normalized Discovery observations".to_owned())?;
            let batches = observations
                .chunks(OBSERVATIONS_PER_BATCH)
                .map(|chunk| PersistedBatch {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    observations: chunk.to_vec(),
                })
                .collect();
            call.state = PersistedCallState::Ready {
                provider_request_id,
                request_count,
                item_count,
                acknowledged_batches: 0,
                batches,
            };
            Ok(())
        })
    }

    pub(super) fn mark_outcome_unknown(&self, call_id: Uuid) -> Result<(), String> {
        self.update(|state| {
            let call = state
                .calls
                .iter_mut()
                .find(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call intent was not found".to_owned())?;
            if !matches!(call.state, PersistedCallState::Intent) {
                return Err("Discovery call cannot become outcome unknown".to_owned());
            }
            call.state = PersistedCallState::OutcomeUnknown;
            Ok(())
        })
    }

    pub(super) fn call_for(
        &self,
        run_id: Uuid,
        provider: DiscoveryProvider,
    ) -> Option<SynchronousCallIntent> {
        let state = self.state.lock().ok()?;
        state
            .calls
            .iter()
            .find(|call| call.run_id == run_id && call.provider == provider)
            .map(|call| SynchronousCallIntent {
                call_id: call.call_id,
                run_id: call.run_id,
                provider: call.provider,
            })
    }

    pub(super) fn state_for(
        &self,
        run_id: Uuid,
        provider: DiscoveryProvider,
    ) -> Option<SynchronousCallState> {
        let state = self.state.lock().ok()?;
        state
            .calls
            .iter()
            .find(|call| call.run_id == run_id && call.provider == provider)
            .map(|call| match call.state {
                PersistedCallState::Intent => SynchronousCallState::Intent,
                PersistedCallState::Ready { .. } => SynchronousCallState::Ready,
                PersistedCallState::OutcomeUnknown => SynchronousCallState::OutcomeUnknown,
            })
    }

    pub(super) fn ready_metadata(
        &self,
        call_id: Uuid,
    ) -> Result<Option<SynchronousReadyMetadata>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Discovery outbox lock failed".to_owned())?;
        let call = state
            .calls
            .iter()
            .find(|call| call.call_id == call_id)
            .ok_or_else(|| "Discovery call was not found".to_owned())?;
        Ok(match &call.state {
            PersistedCallState::Ready {
                provider_request_id,
                request_count,
                item_count,
                ..
            } => Some(SynchronousReadyMetadata {
                provider_request_id: provider_request_id.clone(),
                request_count: *request_count,
                item_count: *item_count,
            }),
            PersistedCallState::Intent | PersistedCallState::OutcomeUnknown => None,
        })
    }

    pub(super) fn next_batch(
        &self,
        call_id: Uuid,
    ) -> Result<Option<SynchronousOutboxBatch>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Discovery outbox lock failed".to_owned())?;
        let call = state
            .calls
            .iter()
            .find(|call| call.call_id == call_id)
            .ok_or_else(|| "Discovery call was not found".to_owned())?;
        let PersistedCallState::Ready {
            provider_request_id,
            acknowledged_batches,
            batches,
            ..
        } = &call.state
        else {
            return Ok(None);
        };
        let Some(batch) = batches.get(*acknowledged_batches) else {
            return Ok(None);
        };
        let batch_index = u32::try_from(*acknowledged_batches)
            .map_err(|_| "invalid Discovery outbox batch index".to_owned())?;
        Ok(Some(SynchronousOutboxBatch {
            call_id: call.call_id,
            run_id: call.run_id,
            provider: call.provider,
            provider_request_id: provider_request_id.clone(),
            request_id: batch.request_id,
            idempotency_key: batch.idempotency_key,
            batch_index,
            observations: batch.observations.clone(),
        }))
    }

    pub(super) fn acknowledge_batch(&self, call_id: Uuid, batch_index: u32) -> Result<(), String> {
        self.update(|state| {
            let call = state
                .calls
                .iter_mut()
                .find(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call was not found".to_owned())?;
            let PersistedCallState::Ready {
                acknowledged_batches,
                batches,
                ..
            } = &mut call.state
            else {
                return Err("Discovery call has no result batches".to_owned());
            };
            let supplied = usize::try_from(batch_index)
                .map_err(|_| "invalid Discovery outbox batch index".to_owned())?;
            if supplied < *acknowledged_batches {
                return Ok(());
            }
            if supplied != *acknowledged_batches || supplied >= batches.len() {
                return Err("Discovery outbox batches must be acknowledged in order".to_owned());
            }
            *acknowledged_batches += 1;
            Ok(())
        })
    }

    pub(super) fn remove_after_relay_ack(&self, call_id: Uuid) -> Result<(), String> {
        self.update(|state| {
            let index = state
                .calls
                .iter()
                .position(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call was not found".to_owned())?;
            if let PersistedCallState::Ready {
                acknowledged_batches,
                batches,
                ..
            } = &state.calls[index].state
            {
                if *acknowledged_batches != batches.len() {
                    return Err("Discovery result batches are not fully acknowledged".to_owned());
                }
            }
            state.calls.remove(index);
            Ok(())
        })
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.path
    }

    fn update<T>(
        &self,
        operation: impl FnOnce(&mut PersistedOutbox) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "Discovery outbox lock failed".to_owned())?;
        let mut updated = guard.clone();
        let result = operation(&mut updated)?;
        validate_outbox(&updated, &updated.workspace_scope)?;
        persist_outbox(&self.path, &updated)?;
        *guard = updated;
        Ok(result)
    }
}

fn workspace_scope(relay_url: &str, actor_pubkey: &str) -> Result<String, String> {
    let parsed = Url::parse(relay_url).map_err(|_| "invalid Discovery relay URL".to_owned())?;
    if !matches!(parsed.scheme(), "ws" | "wss" | "http" | "https") {
        return Err("invalid Discovery relay URL".to_owned());
    }
    let host = parsed
        .host_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "invalid Discovery relay URL".to_owned())?
        .to_ascii_lowercase();
    if actor_pubkey.len() != 64 || !actor_pubkey.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid Discovery actor identity".to_owned());
    }
    let port = parsed.port_or_known_default().unwrap_or(0);
    let identity = format!("{host}:{port}\0{}", actor_pubkey.to_ascii_lowercase());
    Ok(hex::encode(Sha256::digest(identity.as_bytes())))
}

fn load_outbox(path: &Path, workspace_scope: &str) -> Result<PersistedOutbox, String> {
    if !path.exists() {
        return Ok(PersistedOutbox {
            version: OUTBOX_VERSION,
            workspace_scope: workspace_scope.to_owned(),
            calls: Vec::new(),
        });
    }
    set_file_owner_only(path)?;
    let metadata =
        fs::metadata(path).map_err(|error| format!("read Discovery outbox metadata: {error}"))?;
    if metadata.len() > MAX_OUTBOX_BYTES {
        return Err("Discovery outbox is too large".to_owned());
    }
    let bytes = fs::read(path).map_err(|error| format!("read Discovery outbox: {error}"))?;
    let state: PersistedOutbox =
        serde_json::from_slice(&bytes).map_err(|_| "Discovery outbox is malformed".to_owned())?;
    validate_outbox(&state, workspace_scope)?;
    Ok(state)
}

fn persist_outbox(path: &Path, state: &PersistedOutbox) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|_| "serialize Discovery outbox".to_owned())?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_OUTBOX_BYTES {
        return Err("Discovery outbox is too large".to_owned());
    }
    let mut file =
        AtomicWriteFile::open(path).map_err(|error| format!("open Discovery outbox: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect Discovery outbox: {error}"))?;
    }
    file.write_all(&bytes)
        .map_err(|error| format!("write Discovery outbox: {error}"))?;
    file.commit()
        .map_err(|error| format!("commit Discovery outbox: {error}"))?;
    Ok(())
}

fn validate_outbox(state: &PersistedOutbox, workspace_scope: &str) -> Result<(), String> {
    if state.version != OUTBOX_VERSION
        || state.workspace_scope != workspace_scope
        || state.calls.len() > MAX_OUTBOX_CALLS
    {
        return Err("invalid Discovery outbox scope or version".to_owned());
    }
    let mut call_ids = HashSet::with_capacity(state.calls.len());
    for (index, call) in state.calls.iter().enumerate() {
        if call.call_id.is_nil()
            || call.run_id.is_nil()
            || !is_synchronous_provider(call.provider)
            || !call_ids.insert(call.call_id)
            || state.calls[..index]
                .iter()
                .any(|other| other.run_id == call.run_id && other.provider == call.provider)
        {
            return Err("invalid Discovery outbox call identity".to_owned());
        }
        if let PersistedCallState::Ready {
            provider_request_id,
            acknowledged_batches,
            batches,
            item_count,
            ..
        } = &call.state
        {
            validate_provider_request_id(provider_request_id)?;
            if *acknowledged_batches > batches.len()
                || batches.len() > MAX_RESULTS_PER_CALL.div_ceil(OBSERVATIONS_PER_BATCH)
                || usize::try_from(*item_count).ok()
                    != Some(batches.iter().map(|batch| batch.observations.len()).sum())
            {
                return Err("invalid Discovery outbox batch state".to_owned());
            }
            let mut request_ids = HashSet::with_capacity(batches.len());
            let mut retry_ids = HashSet::with_capacity(batches.len());
            let mut provider_records = HashSet::new();
            for batch in batches {
                if batch.request_id.is_nil()
                    || batch.idempotency_key.is_nil()
                    || batch.observations.is_empty()
                    || batch.observations.len() > OBSERVATIONS_PER_BATCH
                    || !request_ids.insert(batch.request_id)
                    || !retry_ids.insert(batch.idempotency_key)
                {
                    return Err("invalid Discovery outbox batch identity".to_owned());
                }
                for observation in &batch.observations {
                    observation
                        .validate()
                        .map_err(|_| "invalid normalized Discovery observation".to_owned())?;
                    if observation.provider != call.provider
                        || !provider_records.insert(observation.provider_record_id.as_str())
                    {
                        return Err("invalid normalized Discovery observation set".to_owned());
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_provider_request_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_PROVIDER_REQUEST_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err("invalid Discovery provider request identity".to_owned());
    }
    Ok(())
}

const fn is_synchronous_provider(provider: DiscoveryProvider) -> bool {
    matches!(
        provider,
        DiscoveryProvider::BraveSearch | DiscoveryProvider::ExaSearch
    )
}

#[cfg(test)]
mod tests {
    use buzz_core_pkg::discovery_worker::{
        deterministic_business_observation_id, DiscoveryBusinessObservationInput, DiscoveryProvider,
    };
    use uuid::Uuid;

    use super::*;

    const ACTOR_ONE: &str = "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b";
    const ACTOR_TWO: &str = "17c4e256a47fd3b862e98af9877dd954b24135e875d077a94ca5c2f1cb6e49dc";

    fn observation(provider: DiscoveryProvider, index: usize) -> DiscoveryBusinessObservationInput {
        let provider_record_id = format!("provider-record-{index}");
        DiscoveryBusinessObservationInput {
            observation_id: deterministic_business_observation_id(provider, &provider_record_id),
            provider,
            provider_record_id,
            place_id: None,
            google_id: None,
            name: format!("Business {index}"),
            website: Some(format!("https://business-{index}.example")),
            phone: None,
            full_address: None,
            city: Some("Johannesburg".to_owned()),
            state: Some("Gauteng".to_owned()),
            postal_code: None,
            country: Some("South Africa".to_owned()),
            country_code: Some("ZA".to_owned()),
            latitude_micros: None,
            longitude_micros: None,
            category: None,
            subtypes: Vec::new(),
            rating_hundredths: None,
            reviews_count: None,
            business_status: None,
            verified: None,
            source_url: None,
            image_url: None,
            description: None,
        }
    }

    fn observations(
        provider: DiscoveryProvider,
        count: usize,
    ) -> Vec<DiscoveryBusinessObservationInput> {
        (0..count)
            .map(|index| observation(provider, index))
            .collect()
    }

    #[test]
    fn written_intent_becomes_outcome_unknown_after_restart_and_cannot_repeat() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let run_id = Uuid::new_v4();
        let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        first
            .begin_call(run_id, DiscoveryProvider::BraveSearch)
            .expect("write call intent");
        assert_eq!(
            first.state_for(run_id, DiscoveryProvider::BraveSearch),
            Some(SynchronousCallState::Intent)
        );
        drop(first);

        let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("reopen outbox");
        assert_eq!(
            recovered.state_for(run_id, DiscoveryProvider::BraveSearch),
            Some(SynchronousCallState::OutcomeUnknown)
        );
        assert!(recovered
            .begin_call(run_id, DiscoveryProvider::BraveSearch)
            .is_err());
    }

    #[test]
    fn provider_response_without_normalized_outbox_is_not_repeated_after_restart() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let run_id = Uuid::new_v4();
        let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        let _call = first
            .begin_call(run_id, DiscoveryProvider::ExaSearch)
            .expect("write call intent");
        // Simulate the process dying after the HTTP response arrived but before
        // the normalized response could be committed atomically.
        drop(first);

        let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("reopen outbox");
        assert_eq!(
            recovered.state_for(run_id, DiscoveryProvider::ExaSearch),
            Some(SynchronousCallState::OutcomeUnknown)
        );
    }

    #[test]
    fn normalized_results_and_batch_identities_survive_restart() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let run_id = Uuid::new_v4();
        let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        let call = first
            .begin_call(run_id, DiscoveryProvider::BraveSearch)
            .expect("write call intent");
        first
            .record_results(
                call.call_id,
                None,
                2,
                observations(DiscoveryProvider::BraveSearch, 30),
            )
            .expect("record normalized results");
        let first_batch = first
            .next_batch(call.call_id)
            .expect("read batch")
            .expect("first batch");
        drop(first);

        let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("reopen outbox");
        assert_eq!(
            recovered.state_for(run_id, DiscoveryProvider::BraveSearch),
            Some(SynchronousCallState::Ready)
        );
        let recovered_batch = recovered
            .next_batch(call.call_id)
            .expect("read recovered batch")
            .expect("recovered first batch");
        assert_eq!(recovered_batch, first_batch);
        assert_eq!(recovered_batch.observations.len(), 25);
        assert_eq!(
            recovered.call_for(run_id, DiscoveryProvider::BraveSearch),
            Some(call)
        );
        assert_eq!(
            recovered
                .ready_metadata(call.call_id)
                .expect("read result metadata"),
            Some(SynchronousReadyMetadata {
                provider_request_id: call.call_id.to_string(),
                request_count: 2,
                item_count: 30,
            })
        );
    }

    #[test]
    fn acknowledged_batch_progress_survives_restart_and_keeps_retry_ids_stable() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let run_id = Uuid::new_v4();
        let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        let call = first
            .begin_call(run_id, DiscoveryProvider::ExaSearch)
            .expect("write call intent");
        first
            .record_results(
                call.call_id,
                Some("exa-request-1".to_owned()),
                1,
                observations(DiscoveryProvider::ExaSearch, 30),
            )
            .expect("record normalized results");
        let first_batch = first
            .next_batch(call.call_id)
            .expect("read batch")
            .expect("first batch");
        first
            .acknowledge_batch(call.call_id, first_batch.batch_index)
            .expect("acknowledge first batch");
        drop(first);

        let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("reopen outbox");
        let second_batch = recovered
            .next_batch(call.call_id)
            .expect("read second batch")
            .expect("second batch");
        assert_eq!(second_batch.batch_index, 1);
        assert_eq!(second_batch.observations.len(), 5);
        assert_ne!(first_batch.request_id, second_batch.request_id);
        assert_ne!(first_batch.idempotency_key, second_batch.idempotency_key);
    }

    #[test]
    fn fully_drained_results_remain_until_a_relay_terminal_acknowledgement() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let run_id = Uuid::new_v4();
        let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        let call = outbox
            .begin_call(run_id, DiscoveryProvider::BraveSearch)
            .expect("write call intent");
        outbox
            .record_results(
                call.call_id,
                None,
                1,
                observations(DiscoveryProvider::BraveSearch, 2),
            )
            .expect("record normalized results");
        let batch = outbox
            .next_batch(call.call_id)
            .expect("read batch")
            .expect("batch");
        outbox
            .acknowledge_batch(call.call_id, batch.batch_index)
            .expect("acknowledge batch");
        assert!(outbox
            .next_batch(call.call_id)
            .expect("read drained state")
            .is_none());
        assert_eq!(
            outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
            Some(SynchronousCallState::Ready)
        );

        outbox
            .remove_after_relay_ack(call.call_id)
            .expect("remove after relay ack");
        assert_eq!(
            outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
            None
        );
    }

    #[test]
    fn community_and_actor_scopes_are_physically_isolated() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let run_id = Uuid::new_v4();
        let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open first outbox");
        first
            .begin_call(run_id, DiscoveryProvider::BraveSearch)
            .expect("write first intent");

        let other_relay = DiscoveryOutbox::open(dir.path(), "wss://relay-two.example", ACTOR_ONE)
            .expect("open other relay outbox");
        let other_actor = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_TWO)
            .expect("open other actor outbox");
        assert_eq!(
            other_relay.state_for(run_id, DiscoveryProvider::BraveSearch),
            None
        );
        assert_eq!(
            other_actor.state_for(run_id, DiscoveryProvider::BraveSearch),
            None
        );
        assert_ne!(first.path(), other_relay.path());
        assert_ne!(first.path(), other_actor.path());
    }

    #[test]
    fn accepted_call_without_recoverable_response_stays_outcome_unknown() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let run_id = Uuid::new_v4();
        let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        let call = first
            .begin_call(run_id, DiscoveryProvider::ExaSearch)
            .expect("write call intent");
        first
            .mark_outcome_unknown(call.call_id)
            .expect("record unknown outcome");
        drop(first);

        let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("reopen outbox");
        assert_eq!(
            recovered.state_for(run_id, DiscoveryProvider::ExaSearch),
            Some(SynchronousCallState::OutcomeUnknown)
        );
        assert!(recovered
            .begin_call(run_id, DiscoveryProvider::ExaSearch)
            .is_err());
    }

    #[test]
    fn outbox_contains_no_provider_secret_query_or_raw_response() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let run_id = Uuid::new_v4();
        let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        let call = outbox
            .begin_call(run_id, DiscoveryProvider::ExaSearch)
            .expect("write call intent");
        outbox
            .record_results(
                call.call_id,
                Some("exa-request-safe".to_owned()),
                1,
                observations(DiscoveryProvider::ExaSearch, 1),
            )
            .expect("record normalized results");
        let serialized = std::fs::read_to_string(outbox.path()).expect("read persisted outbox");
        for forbidden in [
            "api_key",
            "authorization",
            "x-api-key",
            "x-subscription-token",
            "raw_response",
            "search_query",
        ] {
            assert!(!serialized.to_ascii_lowercase().contains(forbidden));
        }
    }

    #[cfg(unix)]
    #[test]
    fn outbox_directory_and_file_are_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().expect("temporary app data");
        let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        outbox
            .begin_call(Uuid::new_v4(), DiscoveryProvider::BraveSearch)
            .expect("write call intent");
        assert_eq!(
            std::fs::metadata(outbox.path().parent().expect("outbox directory"))
                .expect("outbox directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(outbox.path())
                .expect("outbox metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn malformed_outbox_fails_closed_without_starting_another_call() {
        let dir = tempfile::tempdir().expect("temporary app data");
        let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
            .expect("open outbox");
        let path = outbox.path().to_path_buf();
        drop(outbox);
        std::fs::write(path, br#"{"version":1,"calls":"unsafe"}"#).expect("corrupt outbox fixture");

        assert!(DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE).is_err());
    }
}
