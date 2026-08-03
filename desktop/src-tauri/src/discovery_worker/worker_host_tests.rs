use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
};

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use buzz_core_pkg::{
    discovery::{
        DiscoveryBusinessSearchSpec, DiscoveryRunProjection, DiscoveryRunState, DiscoverySource,
        DiscoverySourceConfig, DiscoverySourceMode,
    },
    discovery_worker::{
        deterministic_business_observation_id, DiscoveryBusinessObservationInput,
        DiscoveryBusinessStatus, DiscoveryCheckpointKind, DiscoveryProvider,
        DiscoveryRunSourceProjection, DiscoveryRunSourceStatus, DiscoveryWorkerCheckpoint,
        DiscoveryWorkerStoredObservationsProjection,
    },
};
use chrono::Utc;
use serde_json::json;

use super::*;
use crate::discovery_worker::protocol::ProtocolFuture;

struct LocalOutscraperState {
    allow_success: AtomicBool,
    header_seen: AtomicBool,
    poll_count: AtomicUsize,
    request_shapes: Mutex<Vec<String>>,
    submit_count: AtomicUsize,
}

async fn local_outscraper_submit(
    State(state): State<Arc<LocalOutscraperState>>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> impl IntoResponse {
    state.submit_count.fetch_add(1, AtomicOrdering::SeqCst);
    state
        .header_seen
        .store(headers.contains_key("x-api-key"), AtomicOrdering::SeqCst);
    state
        .request_shapes
        .lock()
        .expect("request shapes")
        .push(uri.to_string());
    (
        axum::http::StatusCode::ACCEPTED,
        json!({"id": "local-job-1", "status": "Pending"}).to_string(),
    )
}

async fn local_outscraper_poll(
    State(state): State<Arc<LocalOutscraperState>>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    assert_eq!(request_id, "local-job-1");
    state.poll_count.fetch_add(1, AtomicOrdering::SeqCst);
    state
        .header_seen
        .fetch_and(headers.contains_key("x-api-key"), AtomicOrdering::SeqCst);
    if !state.allow_success.load(AtomicOrdering::SeqCst) {
        return (
            axum::http::StatusCode::OK,
            json!({"id": "local-job-1", "status": "Pending"}).to_string(),
        );
    }
    let businesses = [
        ("Sandton Dental Studio", "place-sandton-1"),
        ("Nelson Mandela Square Dental", "place-sandton-2"),
        ("Rivonia Family Dentistry", "place-sandton-3"),
    ]
    .into_iter()
    .map(|(name, place_id)| {
        json!({
            "name": name,
            "place_id": place_id,
            "site": format!("https://{place_id}.example.test"),
            "full_address": "Sandton, Johannesburg, South Africa",
            "country_code": "ZA",
            "business_status": "OPERATIONAL"
        })
    })
    .collect::<Vec<_>>();
    (
        axum::http::StatusCode::OK,
        json!({
            "id": "local-job-1",
            "status": "Success",
            "data": [businesses]
        })
        .to_string(),
    )
}

async fn start_local_outscraper() -> (
    OutscraperClient,
    Arc<LocalOutscraperState>,
    tokio::task::JoinHandle<()>,
) {
    let state = Arc::new(LocalOutscraperState {
        allow_success: AtomicBool::new(false),
        header_seen: AtomicBool::new(false),
        poll_count: AtomicUsize::new(0),
        request_shapes: Mutex::new(Vec::new()),
        submit_count: AtomicUsize::new(0),
    });
    let router = Router::new()
        .route("/google-maps-search", post(local_outscraper_submit))
        .route("/requests/{id}", get(local_outscraper_poll))
        .with_state(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local Outscraper proof server");
    let address = listener.local_addr().expect("local provider address");
    let handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("local Outscraper proof server");
    });
    let client = OutscraperClient::for_local_test(
        format!("http://{address}/google-maps-search"),
        format!("http://{address}/requests"),
    )
    .expect("local Outscraper client");
    (client, state, handle)
}

struct FakeProtocol {
    outcomes: Mutex<VecDeque<DiscoveryWorkerReceiptOutcome>>,
    calls: Mutex<Vec<&'static str>>,
    observation_requests: Mutex<Vec<DiscoveryWorkerObservationBatchRequest>>,
}

impl FakeProtocol {
    fn new(outcomes: Vec<DiscoveryWorkerReceiptOutcome>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into()),
            calls: Mutex::new(Vec::new()),
            observation_requests: Mutex::new(Vec::new()),
        }
    }

    fn next(&self, call: &'static str) -> Result<DiscoveryWorkerReceiptOutcome, String> {
        self.calls.lock().expect("calls").push(call);
        self.outcomes
            .lock()
            .expect("outcomes")
            .pop_front()
            .ok_or_else(|| format!("no fixture outcome for {call}"))
    }
}

impl WorkerProtocol for FakeProtocol {
    fn claim(&self, _: DiscoveryWorkerClaimRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("claim") })
    }

    fn heartbeat(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("heartbeat") })
    }

    fn checkpoint(&self, _: DiscoveryWorkerCheckpointRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("checkpoint") })
    }

    fn store_observations(
        &self,
        request: DiscoveryWorkerObservationBatchRequest,
    ) -> ProtocolFuture<'_> {
        Box::pin(async move {
            self.observation_requests
                .lock()
                .expect("observation requests")
                .push(request);
            self.next("store_observations")
        })
    }

    fn fail(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("fail") })
    }

    fn complete(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("complete") })
    }
}

struct FakeProvider {
    submit_calls: AtomicUsize,
    poll_calls: AtomicUsize,
    ready_on_submit: bool,
    wait_for_cancellation: bool,
    submit_error: Option<OutscraperError>,
    observations: Vec<DiscoveryBusinessObservationInput>,
}

impl FakeProvider {
    fn immediate(observations: Vec<DiscoveryBusinessObservationInput>) -> Self {
        Self {
            submit_calls: AtomicUsize::new(0),
            poll_calls: AtomicUsize::new(0),
            ready_on_submit: true,
            wait_for_cancellation: false,
            submit_error: None,
            observations,
        }
    }

    fn polled(observations: Vec<DiscoveryBusinessObservationInput>) -> Self {
        Self {
            submit_calls: AtomicUsize::new(0),
            poll_calls: AtomicUsize::new(0),
            ready_on_submit: false,
            wait_for_cancellation: false,
            submit_error: None,
            observations,
        }
    }

    fn pending_forever() -> Self {
        Self {
            submit_calls: AtomicUsize::new(0),
            poll_calls: AtomicUsize::new(0),
            ready_on_submit: false,
            wait_for_cancellation: true,
            submit_error: None,
            observations: Vec::new(),
        }
    }

    fn rejected() -> Self {
        Self {
            submit_calls: AtomicUsize::new(0),
            poll_calls: AtomicUsize::new(0),
            ready_on_submit: false,
            wait_for_cancellation: false,
            submit_error: Some(OutscraperError::CredentialRejected),
            observations: Vec::new(),
        }
    }
}

impl BusinessDiscoveryProvider for FakeProvider {
    fn submit<'a>(
        &'a self,
        _: &'a DiscoveryBusinessSearchSpec,
        _: &'a Zeroizing<String>,
        cancellation: &'a CancellationToken,
    ) -> ProviderFuture<'a, OutscraperSubmission> {
        self.submit_calls.fetch_add(1, AtomicOrdering::SeqCst);
        Box::pin(async move {
            if self.wait_for_cancellation {
                cancellation.cancelled().await;
                return Err(OutscraperError::Cancelled);
            }
            if let Some(error) = self.submit_error {
                return Err(error);
            }
            Ok(OutscraperSubmission {
                request_id: "fixture-request".to_string(),
                ready: self.ready_on_submit.then(|| self.observations.clone()),
            })
        })
    }

    fn poll<'a>(
        &'a self,
        _: &'a str,
        _: &'a Zeroizing<String>,
        cancellation: &'a CancellationToken,
    ) -> ProviderFuture<'a, Vec<DiscoveryBusinessObservationInput>> {
        self.poll_calls.fetch_add(1, AtomicOrdering::SeqCst);
        Box::pin(async move {
            if self.wait_for_cancellation {
                cancellation.cancelled().await;
                return Err(OutscraperError::Cancelled);
            }
            Ok(self.observations.clone())
        })
    }
}

fn run_projection() -> DiscoveryRunProjection {
    DiscoveryRunProjection {
        run_id: Uuid::new_v4(),
        campaign_id: Uuid::new_v4(),
        state: DiscoveryRunState::Running,
        completed_steps: 0,
        total_steps: 2,
        cancel_requested: false,
        terminal_reason: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

fn lease(last_checkpoint: Option<DiscoveryWorkerCheckpoint>) -> DiscoveryWorkerLeaseProjection {
    DiscoveryWorkerLeaseProjection {
        worker_id: Uuid::new_v4(),
        lease_id: Uuid::new_v4(),
        attempt: 1,
        lease_until: Utc::now() + chrono::Duration::seconds(30),
        run: run_projection(),
        business_search: DiscoveryBusinessSearchSpec {
            query: "dentists".to_owned(),
            location: "Sandton, Johannesburg, South Africa".to_owned(),
            limit: 3,
            language: "en".to_owned(),
            region: Some("ZA".to_owned()),
        },
        source_config: DiscoverySourceConfig {
            mode: DiscoverySourceMode::Waterfall,
            sources: vec![DiscoverySource::GoogleMaps],
        },
        source_states: vec![DiscoveryRunSourceProjection {
            source: DiscoverySource::GoogleMaps,
            provider: DiscoveryProvider::Outscraper,
            position: 0,
            status: DiscoveryRunSourceStatus::Pending,
            request_cursor: None,
            request_count: 0,
            returned_count: 0,
            retained_count: 0,
            duplicate_count: 0,
            failure_class: None,
            started_at: None,
            finished_at: None,
            updated_at: Utc::now(),
        }],
        last_checkpoint,
    }
}

fn lease_outcome(value: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerReceiptOutcome {
    DiscoveryWorkerReceiptOutcome::Lease(value.clone())
}

fn observation(provider_record_id: &str) -> DiscoveryBusinessObservationInput {
    DiscoveryBusinessObservationInput {
        observation_id: deterministic_business_observation_id(
            DiscoveryProvider::Outscraper,
            provider_record_id,
        ),
        provider: DiscoveryProvider::Outscraper,
        provider_record_id: provider_record_id.to_string(),
        place_id: Some(provider_record_id.to_string()),
        google_id: None,
        name: format!("Business {provider_record_id}"),
        website: None,
        phone: None,
        full_address: None,
        city: None,
        state: None,
        postal_code: None,
        country: None,
        country_code: None,
        latitude_micros: None,
        longitude_micros: None,
        category: None,
        subtypes: Vec::new(),
        rating_hundredths: None,
        reviews_count: None,
        business_status: Some(DiscoveryBusinessStatus::Operational),
        verified: None,
        source_url: None,
        image_url: None,
        description: None,
    }
}

fn stored_outcome(lease: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerReceiptOutcome {
    DiscoveryWorkerReceiptOutcome::ObservationsStored(DiscoveryWorkerStoredObservationsProjection {
        lease: lease.clone(),
        accepted_count: 1,
        existing_count: 0,
    })
}

#[tokio::test]
async fn missing_credential_sends_zero_claim_actions() {
    let protocol = FakeProtocol::new(Vec::new());
    let outcome = run_once_with_loader(&protocol, Uuid::new_v4(), Duration::ZERO, || Ok(None))
        .await
        .expect("missing credential is not an error");
    assert_eq!(outcome, HostRunOutcome::NoCredential);
    assert!(protocol.calls.lock().expect("calls").is_empty());
}

#[tokio::test]
async fn production_run_checkpoints_before_storing_and_completing() {
    let lease = lease(None);
    let protocol = FakeProtocol::new(vec![
        lease_outcome(&lease),
        lease_outcome(&lease),
        lease_outcome(&lease),
        stored_outcome(&lease),
        lease_outcome(&lease),
        DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
    ]);
    let provider = FakeProvider::immediate(vec![observation("place-one")]);
    let outcome = run_production_once_with_credential(
        &protocol,
        &provider,
        lease.worker_id,
        &Zeroizing::new("fixture".to_string()),
    )
    .await
    .expect("production run");
    assert_eq!(outcome, HostRunOutcome::Completed);
    assert_eq!(provider.submit_calls.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(provider.poll_calls.load(AtomicOrdering::SeqCst), 0);
    assert_eq!(
        *protocol.calls.lock().expect("calls"),
        [
            "claim",
            "heartbeat",
            "checkpoint",
            "store_observations",
            "checkpoint",
            "complete"
        ]
    );
}

#[tokio::test]
async fn production_resume_polls_existing_request_without_resubmitting() {
    let submitted = DiscoveryWorkerCheckpoint {
        sequence: 1,
        kind: DiscoveryCheckpointKind::ProviderSubmitted,
        provider: DiscoveryProvider::Outscraper,
        provider_request_id: Some("fixture-request".to_string()),
        item_count: None,
    };
    let lease = lease(Some(submitted));
    let protocol = FakeProtocol::new(vec![
        lease_outcome(&lease),
        lease_outcome(&lease),
        stored_outcome(&lease),
        lease_outcome(&lease),
        DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
    ]);
    let provider = FakeProvider::polled(vec![observation("place-one")]);
    let outcome = run_production_once_with_credential(
        &protocol,
        &provider,
        lease.worker_id,
        &Zeroizing::new("fixture".to_string()),
    )
    .await
    .expect("resumed production run");
    assert_eq!(outcome, HostRunOutcome::Completed);
    assert_eq!(provider.submit_calls.load(AtomicOrdering::SeqCst), 0);
    assert_eq!(provider.poll_calls.load(AtomicOrdering::SeqCst), 1);
}

#[tokio::test]
async fn results_ready_resume_completes_with_zero_provider_traffic() {
    let ready = DiscoveryWorkerCheckpoint {
        sequence: 2,
        kind: DiscoveryCheckpointKind::ProviderResultsReady,
        provider: DiscoveryProvider::Outscraper,
        provider_request_id: None,
        item_count: Some(1),
    };
    let lease = lease(Some(ready));
    let protocol = FakeProtocol::new(vec![
        lease_outcome(&lease),
        DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
    ]);
    let provider = FakeProvider::polled(Vec::new());
    let outcome = run_production_once_with_credential(
        &protocol,
        &provider,
        lease.worker_id,
        &Zeroizing::new("fixture".to_string()),
    )
    .await
    .expect("results-ready resume");
    assert_eq!(outcome, HostRunOutcome::Completed);
    assert_eq!(provider.submit_calls.load(AtomicOrdering::SeqCst), 0);
    assert_eq!(provider.poll_calls.load(AtomicOrdering::SeqCst), 0);
    assert_eq!(
        *protocol.calls.lock().expect("calls"),
        ["claim", "complete"]
    );
}

#[tokio::test]
async fn lost_lease_cancels_an_inflight_provider_request() {
    let mut lease = lease(None);
    lease.lease_until = Utc::now() + chrono::Duration::milliseconds(120);
    let protocol = FakeProtocol::new(vec![
        lease_outcome(&lease),
        DiscoveryWorkerReceiptOutcome::LostLease(lease.run.clone()),
    ]);
    let provider = FakeProvider::pending_forever();
    let outcome = run_production_once_with_credential(
        &protocol,
        &provider,
        lease.worker_id,
        &Zeroizing::new("fixture".to_string()),
    )
    .await
    .expect("lost lease");
    assert_eq!(outcome, HostRunOutcome::LostLease);
    assert_eq!(
        *protocol.calls.lock().expect("calls"),
        ["claim", "heartbeat"]
    );
}

#[tokio::test]
async fn terminal_provider_error_fails_once_without_persisting_details() {
    let lease = lease(None);
    let mut failed_run = lease.run.clone();
    failed_run.state = DiscoveryRunState::Failed;
    failed_run.terminal_reason =
        Some(buzz_core_pkg::discovery::DiscoveryTerminalReason::ExecutorFailed);
    let protocol = FakeProtocol::new(vec![
        lease_outcome(&lease),
        lease_outcome(&lease),
        DiscoveryWorkerReceiptOutcome::Failed(failed_run),
    ]);
    let provider = FakeProvider::rejected();
    let outcome = run_production_once_with_credential(
        &protocol,
        &provider,
        lease.worker_id,
        &Zeroizing::new("fixture-secret".to_string()),
    )
    .await
    .expect("terminal provider failure");
    assert_eq!(outcome, HostRunOutcome::Failed);
    assert_eq!(
        *protocol.calls.lock().expect("calls"),
        ["claim", "heartbeat", "fail"]
    );
}

#[tokio::test]
async fn fresh_run_heartbeats_checkpoints_twice_and_completes() {
    let lease = lease(None);
    let protocol = FakeProtocol::new(vec![
        lease_outcome(&lease),
        lease_outcome(&lease),
        lease_outcome(&lease),
        lease_outcome(&lease),
        lease_outcome(&lease),
        lease_outcome(&lease),
        DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
    ]);
    let outcome = run_once_with_credential(
        &protocol,
        lease.worker_id,
        Duration::ZERO,
        Zeroizing::new("fixture".to_string()),
    )
    .await
    .expect("fresh run");
    assert_eq!(outcome, HostRunOutcome::Completed);
    assert_eq!(
        *protocol.calls.lock().expect("calls"),
        [
            "claim",
            "heartbeat",
            "checkpoint",
            "heartbeat",
            "checkpoint",
            "heartbeat",
            "complete"
        ]
    );
}

#[tokio::test]
async fn reclaimed_run_resumes_after_provider_submitted() {
    let submitted = DiscoveryWorkerCheckpoint {
        sequence: 1,
        kind: DiscoveryCheckpointKind::ProviderSubmitted,
        provider: DiscoveryProvider::Outscraper,
        provider_request_id: Some("fixture-request".to_string()),
        item_count: None,
    };
    let lease = lease(Some(submitted));
    let protocol = FakeProtocol::new(vec![
        lease_outcome(&lease),
        lease_outcome(&lease),
        lease_outcome(&lease),
        lease_outcome(&lease),
        DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
    ]);
    let outcome = run_once_with_credential(
        &protocol,
        lease.worker_id,
        Duration::ZERO,
        Zeroizing::new("fixture".to_string()),
    )
    .await
    .expect("resumed run");
    assert_eq!(outcome, HostRunOutcome::Completed);
    assert_eq!(
        protocol
            .calls
            .lock()
            .expect("calls")
            .iter()
            .filter(|call| **call == "checkpoint")
            .count(),
        1
    );
}

#[tokio::test]
async fn lost_lease_during_paused_step_sends_no_checkpoint_or_completion() {
    let mut lease = lease(None);
    lease.lease_until = Utc::now() + chrono::Duration::milliseconds(150);
    let protocol = FakeProtocol::new(vec![
        lease_outcome(&lease),
        lease_outcome(&lease),
        DiscoveryWorkerReceiptOutcome::LostLease(lease.run.clone()),
    ]);
    let outcome = run_once_with_credential(
        &protocol,
        lease.worker_id,
        Duration::from_millis(180),
        Zeroizing::new("fixture".to_string()),
    )
    .await
    .expect("lost lease");
    assert_eq!(outcome, HostRunOutcome::LostLease);
    assert!(!protocol
        .calls
        .lock()
        .expect("calls")
        .iter()
        .any(|call| *call == "checkpoint" || *call == "complete"));
}

fn synchronous_observation(
    provider: DiscoveryProvider,
    provider_record_id: &str,
) -> DiscoveryBusinessObservationInput {
    let mut value = observation(provider_record_id);
    value.provider = provider;
    value.observation_id = deterministic_business_observation_id(provider, provider_record_id);
    value
}

#[tokio::test]
async fn synchronous_outbox_drains_with_stable_batch_retry_identities() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let mut lease = lease(None);
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open outbox");
    let call = outbox
        .begin_call(lease.run.run_id, DiscoveryProvider::BraveSearch)
        .expect("write call intent");
    let observations = (0..30)
        .map(|index| {
            synchronous_observation(
                DiscoveryProvider::BraveSearch,
                &format!("brave-record-{index}"),
            )
        })
        .collect();
    outbox
        .record_results(call.call_id, None, 2, observations)
        .expect("record normalized results");
    let expected_first = outbox
        .next_batch(call.call_id)
        .expect("read outbox")
        .expect("first batch");
    let protocol = FakeProtocol::new(vec![stored_outcome(&lease), stored_outcome(&lease)]);

    let result = drain_synchronous_outbox(&protocol, &outbox, call.call_id, &mut lease)
        .await
        .expect("drain outbox");

    assert_eq!(result, OutboxDrainOutcome::Drained);
    assert!(outbox
        .next_batch(call.call_id)
        .expect("read drained outbox")
        .is_none());
    let requests = protocol
        .observation_requests
        .lock()
        .expect("observation requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].lease.request_id, expected_first.request_id);
    assert_eq!(
        requests[0].lease.idempotency_key,
        expected_first.idempotency_key
    );
    assert_eq!(requests[0].observations.len(), 25);
    assert_eq!(requests[1].observations.len(), 5);
}

#[tokio::test]
async fn lost_lease_leaves_synchronous_outbox_batch_unacknowledged() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let mut lease = lease(None);
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open outbox");
    let call = outbox
        .begin_call(lease.run.run_id, DiscoveryProvider::ExaSearch)
        .expect("write call intent");
    outbox
        .record_results(
            call.call_id,
            Some("exa-request-1".to_owned()),
            1,
            vec![synchronous_observation(
                DiscoveryProvider::ExaSearch,
                "exa-record-1",
            )],
        )
        .expect("record normalized results");
    let expected = outbox
        .next_batch(call.call_id)
        .expect("read outbox")
        .expect("first batch");
    let protocol = FakeProtocol::new(vec![DiscoveryWorkerReceiptOutcome::LostLease(
        lease.run.clone(),
    )]);

    let result = drain_synchronous_outbox(&protocol, &outbox, call.call_id, &mut lease)
        .await
        .expect("drain outbox");

    assert_eq!(result, OutboxDrainOutcome::LostLease);
    assert_eq!(
        outbox
            .next_batch(call.call_id)
            .expect("read retained batch")
            .expect("retained batch"),
        expected
    );
}

#[path = "worker_host_integration_tests.rs"]
mod integration_tests;
