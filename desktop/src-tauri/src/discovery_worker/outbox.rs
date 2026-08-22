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
    Submitted,
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
    pub(super) response_complete: bool,
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
    Submitted {
        provider_request_id: String,
        #[serde(default)]
        recovery_attempts: u8,
        #[serde(default)]
        next_recovery_at: u64,
    },
    Ready {
        provider_request_id: String,
        request_count: u16,
        item_count: u32,
        #[serde(default = "default_true")]
        response_complete: bool,
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
        if run_id.is_nil() {
            return Err("invalid Discovery call intent".to_owned());
        }
        self.update(|state| {
            if state
                .calls
                .iter()
                .any(|call| call.run_id == run_id && call.provider == provider)
            {
                return Err("a Discovery provider call already exists".to_owned());
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

    pub(super) fn mark_submitted(
        &self,
        call_id: Uuid,
        provider_request_id: &str,
    ) -> Result<(), String> {
        validate_provider_request_id(provider_request_id)?;
        self.update(|state| {
            let call = state
                .calls
                .iter_mut()
                .find(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call intent was not found".to_owned())?;
            match &call.state {
                PersistedCallState::Intent => {
                    call.state = PersistedCallState::Submitted {
                        provider_request_id: provider_request_id.to_owned(),
                        recovery_attempts: 0,
                        next_recovery_at: 0,
                    };
                    Ok(())
                }
                PersistedCallState::Submitted {
                    provider_request_id: existing,
                    ..
                } if existing == provider_request_id => Ok(()),
                _ => Err("Discovery call submission conflicts with durable state".to_owned()),
            }
        })
    }

    pub(super) fn submitted_request_id(&self, call_id: Uuid) -> Result<Option<String>, String> {
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
            PersistedCallState::Submitted {
                provider_request_id,
                ..
            } => Some(provider_request_id.clone()),
            _ => None,
        })
    }

    #[cfg(test)]
    pub(super) fn submitted_recovery_due(
        &self,
        call_id: Uuid,
        now: u64,
    ) -> Result<Option<String>, String> {
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
            PersistedCallState::Submitted {
                provider_request_id,
                next_recovery_at,
                ..
            } if *next_recovery_at <= now => Some(provider_request_id.clone()),
            _ => None,
        })
    }

    #[cfg(test)]
    pub(super) fn defer_submitted_recovery(
        &self,
        call_id: Uuid,
        now: u64,
    ) -> Result<(), String> {
        self.update(|state| {
            let call = state
                .calls
                .iter_mut()
                .find(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call was not found".to_owned())?;
            let PersistedCallState::Submitted {
                recovery_attempts,
                next_recovery_at,
                ..
            } = &mut call.state
            else {
                return Err("Discovery call is not awaiting async recovery".to_owned());
            };
            *recovery_attempts = recovery_attempts.saturating_add(1).min(6);
            let delay = 60_u64
                .saturating_mul(1_u64 << u32::from(recovery_attempts.saturating_sub(1)))
                .min(3_600);
            *next_recovery_at = now.saturating_add(delay);
            Ok(())
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
            let provider_request_id =
                provider_request_id.unwrap_or_else(|| call.call_id.to_string());
            validate_provider_request_id(&provider_request_id)?;
            match &call.state {
                PersistedCallState::Intent => {}
                PersistedCallState::Submitted {
                    provider_request_id: submitted,
                    ..
                } if call.provider == DiscoveryProvider::Outscraper
                    && *submitted == provider_request_id => {}
                _ => return Err("Discovery call results were already resolved".to_owned()),
            }
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
                response_complete: true,
                acknowledged_batches: 0,
                batches,
            };
            Ok(())
        })
    }

    /// Durably append a paid page before requesting the next one.
    pub(super) fn append_results(
        &self,
        call_id: Uuid,
        provider_request_id: Option<String>,
        request_count: u16,
        observations: Vec<DiscoveryBusinessObservationInput>,
    ) -> Result<(), String> {
        self.update(|state| {
            let call = state
                .calls
                .iter_mut()
                .find(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call intent was not found".to_owned())?;
            let requested_id = provider_request_id.unwrap_or_else(|| call.call_id.to_string());
            validate_provider_request_id(&requested_id)?;

            let (stored_id, stored_request_count, item_count, response_complete, batches) =
                match &mut call.state {
                    PersistedCallState::Intent => {
                        call.state = PersistedCallState::Ready {
                            provider_request_id: requested_id.clone(),
                            request_count: 0,
                            item_count: 0,
                            response_complete: false,
                            acknowledged_batches: 0,
                            batches: Vec::new(),
                        };
                        let PersistedCallState::Ready {
                            provider_request_id,
                            request_count,
                            item_count,
                            response_complete,
                            batches,
                            ..
                        } = &mut call.state
                        else {
                            return Err("Discovery call state transition failed".to_owned());
                        };
                        (
                            provider_request_id,
                            request_count,
                            item_count,
                            response_complete,
                            batches,
                        )
                    }
                    PersistedCallState::Ready {
                        provider_request_id,
                        request_count,
                        item_count,
                        response_complete,
                        batches,
                        ..
                    } => (
                        provider_request_id,
                        request_count,
                        item_count,
                        response_complete,
                        batches,
                    ),
                    PersistedCallState::OutcomeUnknown => {
                        return Err("Discovery call outcome is already unknown".to_owned())
                    }
                    PersistedCallState::Submitted { .. } => {
                        return Err("async Discovery submissions cannot append results".to_owned())
                    }
                };
            if *response_complete
                || *stored_id != requested_id
                || request_count < *stored_request_count
            {
                return Err("invalid incremental Discovery results".to_owned());
            }

            let mut provider_records = batches
                .iter()
                .flat_map(|batch| &batch.observations)
                .map(|observation| observation.provider_record_id.as_str())
                .collect::<HashSet<_>>();
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
            let next_count = usize::try_from(*item_count)
                .unwrap_or(usize::MAX)
                .saturating_add(observations.len());
            if next_count > MAX_RESULTS_PER_CALL {
                return Err("too many normalized Discovery observations".to_owned());
            }
            batches.extend(observations.chunks(OBSERVATIONS_PER_BATCH).map(|chunk| {
                PersistedBatch {
                    request_id: Uuid::new_v4(),
                    idempotency_key: Uuid::new_v4(),
                    observations: chunk.to_vec(),
                }
            }));
            *stored_request_count = request_count;
            *item_count = u32::try_from(next_count)
                .map_err(|_| "too many normalized Discovery observations".to_owned())?;
            Ok(())
        })
    }

    pub(super) fn mark_response_complete(
        &self,
        call_id: Uuid,
        provider_request_id: Option<String>,
        request_count: u16,
    ) -> Result<(), String> {
        self.append_results(call_id, provider_request_id, request_count, Vec::new())?;
        self.update(|state| {
            let call = state
                .calls
                .iter_mut()
                .find(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call was not found".to_owned())?;
            let PersistedCallState::Ready {
                response_complete, ..
            } = &mut call.state
            else {
                return Err("Discovery call has no recoverable response".to_owned());
            };
            *response_complete = true;
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

    pub(super) fn discard_unsubmitted(&self, call_id: Uuid) -> Result<(), String> {
        self.update(|state| {
            let index = state
                .calls
                .iter()
                .position(|call| call.call_id == call_id)
                .ok_or_else(|| "Discovery call intent was not found".to_owned())?;
            if !matches!(state.calls[index].state, PersistedCallState::Intent) {
                return Err("only an unsubmitted Discovery intent can be discarded".to_owned());
            }
            state.calls.remove(index);
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
                PersistedCallState::Submitted { .. } => SynchronousCallState::Submitted,
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
                response_complete,
                ..
            } => Some(SynchronousReadyMetadata {
                provider_request_id: provider_request_id.clone(),
                request_count: *request_count,
                item_count: *item_count,
                response_complete: *response_complete,
            }),
            PersistedCallState::Intent
            | PersistedCallState::Submitted { .. }
            | PersistedCallState::OutcomeUnknown => None,
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
            match &state.calls[index].state {
                PersistedCallState::Ready {
                    acknowledged_batches,
                    batches,
                    ..
                } if *acknowledged_batches != batches.len() => {
                    return Err("Discovery result batches are not fully acknowledged".to_owned())
                }
                PersistedCallState::Intent | PersistedCallState::OutcomeUnknown => {
                    return Err("Discovery call outcome is not safely removable".to_owned())
                }
                PersistedCallState::Submitted { .. } | PersistedCallState::Ready { .. } => {}
            }
            state.calls.remove(index);
            Ok(())
        })
    }

    pub(super) fn remove_terminal_run(&self, run_id: Uuid) -> Result<(), String> {
        if run_id.is_nil() {
            return Err("invalid terminal Discovery run".to_owned());
        }
        self.update(|state| {
            state.calls.retain(|call| {
                call.run_id != run_id
                    || !matches!(
                        &call.state,
                        PersistedCallState::Ready {
                            acknowledged_batches,
                            batches,
                            ..
                        } if *acknowledged_batches == batches.len()
                    )
            });
            Ok(())
        })
    }

    pub(super) fn run_ids(&self) -> Result<Vec<Uuid>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Discovery outbox lock failed".to_owned())?;
        let mut run_ids = state
            .calls
            .iter()
            .map(|call| call.run_id)
            .collect::<Vec<_>>();
        run_ids.sort_unstable();
        run_ids.dedup();
        Ok(run_ids)
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
        } else if let PersistedCallState::Submitted {
            provider_request_id,
            recovery_attempts,
            ..
        } = &call.state
        {
            validate_provider_request_id(provider_request_id)?;
            if call.provider != DiscoveryProvider::Outscraper || *recovery_attempts > 6 {
                return Err("invalid async Discovery outbox provider".to_owned());
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

const fn default_true() -> bool {
    true
}

#[cfg(test)]
#[path = "outbox_tests.rs"]
pub(super) mod tests;

#[cfg(test)]
#[path = "outbox_security_tests.rs"]
mod security_tests;
