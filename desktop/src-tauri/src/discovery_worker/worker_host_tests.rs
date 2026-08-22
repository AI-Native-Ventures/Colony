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
    Json, Router,
};
use buzz_core_pkg::{
    discovery::{
        DiscoveryBusinessSearchSpec, DiscoveryRunProjection, DiscoveryRunState, DiscoverySource,
        DiscoverySourceConfig, DiscoverySourceMode,
    },
    discovery_worker::{
        deterministic_business_observation_id, DiscoveryBusinessObservationInput,
        DiscoveryBusinessStatus, DiscoveryCheckpointKind, DiscoveryProvider,
        DiscoveryRunSourceFailureClass, DiscoveryRunSourceProjection, DiscoveryRunSourceStatus,
        DiscoveryWorkerCheckpoint, DiscoveryWorkerSourceProgressRequest,
        DiscoveryWorkerStoredObservationsProjection,
    },
};
use chrono::Utc;
use serde_json::json;

use super::*;
use crate::discovery_worker::{
    brave::BraveSearchClient, exa::ExaSearchClient, protocol::ProtocolFuture,
};

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

async fn local_brave_search(headers: HeaderMap) -> impl IntoResponse {
    assert_eq!(
        headers
            .get("x-subscription-token")
            .and_then(|value| value.to_str().ok()),
        Some("brave-test-key")
    );
    Json(json!({
        "query": {"more_results_available": false},
        "web": {"results": [{
            "title": "Brave Dental",
            "url": "https://brave-dental.example"
        }]}
    }))
}

async fn local_delayed_brave_search(headers: HeaderMap) -> impl IntoResponse {
    assert_eq!(
        headers
            .get("x-subscription-token")
            .and_then(|value| value.to_str().ok()),
        Some("brave-test-key")
    );
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    Json(json!({
        "query": {"more_results_available": false},
        "web": {"results": []}
    }))
}

async fn local_paginated_brave_search(
    State(request_count): State<Arc<AtomicUsize>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    assert_eq!(
        headers
            .get("x-subscription-token")
            .and_then(|value| value.to_str().ok()),
        Some("brave-test-key")
    );
    let page = request_count.fetch_add(1, AtomicOrdering::SeqCst);
    Json(json!({
        "query": {"more_results_available": page == 0},
        "web": {"results": [{
            "title": format!("Paid Brave Page {page}"),
            "url": format!("https://paid-page-{page}.example")
        }]}
    }))
}

async fn local_exa_search(
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    assert_eq!(
        headers
            .get("x-api-key")
            .and_then(|value| value.to_str().ok()),
        Some("exa-test-key")
    );
    assert_eq!(body.get("category"), Some(&json!("company")));
    Json(json!({
        "requestId": "exa-integrated-request",
        "results": [{
            "title": "Exa Dental",
            "url": "https://exa-dental.example"
        }]
    }))
}

async fn local_rate_limited() -> impl IntoResponse {
    (axum::http::StatusCode::TOO_MANY_REQUESTS, "retry later")
}

async fn start_local_synchronous_sources() -> (
    BraveSearchClient,
    ExaSearchClient,
    tokio::task::JoinHandle<()>,
) {
    let router = Router::new()
        .route("/brave", get(local_brave_search))
        .route("/brave-delayed", get(local_delayed_brave_search))
        .route("/exa", post(local_exa_search));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local multi-source server");
    let address = listener.local_addr().expect("local multi-source address");
    let handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve local multi-source endpoints");
    });
    let brave = BraveSearchClient::for_local_test(format!("http://{address}/brave"))
        .expect("local Brave client");
    let exa =
        ExaSearchClient::for_local_test(format!("http://{address}/exa")).expect("local Exa client");
    (brave, exa, handle)
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
    fn status(&self, _: Uuid) -> crate::discovery_worker::protocol::RunStatusFuture<'_> {
        Box::pin(async { Err("status fixture is not configured".to_owned()) })
    }

    fn claim(&self, _: DiscoveryWorkerClaimRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("claim") })
    }

    fn heartbeat(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("heartbeat") })
    }

    fn checkpoint(&self, _: DiscoveryWorkerCheckpointRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("checkpoint") })
    }

    fn source_progress(
        &self,
        _: buzz_core_pkg::discovery_worker::DiscoveryWorkerSourceProgressRequest,
    ) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("source_progress") })
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

struct MultiSourceProtocol {
    lease: Mutex<DiscoveryWorkerLeaseProjection>,
    terminal_runs: Mutex<Vec<DiscoveryRunProjection>>,
    fail_salvage_runs: Mutex<Vec<Uuid>>,
    calls: Mutex<Vec<&'static str>>,
    completed: AtomicBool,
    heartbeat_count: AtomicUsize,
    cancel_on_heartbeat: Option<usize>,
}

impl MultiSourceProtocol {
    fn new(lease: DiscoveryWorkerLeaseProjection) -> Self {
        Self {
            lease: Mutex::new(lease),
            terminal_runs: Mutex::new(Vec::new()),
            fail_salvage_runs: Mutex::new(Vec::new()),
            calls: Mutex::new(Vec::new()),
            completed: AtomicBool::new(false),
            heartbeat_count: AtomicUsize::new(0),
            cancel_on_heartbeat: None,
        }
    }

    fn cancelling(lease: DiscoveryWorkerLeaseProjection, heartbeat: usize) -> Self {
        Self {
            lease: Mutex::new(lease),
            terminal_runs: Mutex::new(Vec::new()),
            fail_salvage_runs: Mutex::new(Vec::new()),
            calls: Mutex::new(Vec::new()),
            completed: AtomicBool::new(false),
            heartbeat_count: AtomicUsize::new(0),
            cancel_on_heartbeat: Some(heartbeat),
        }
    }

    fn lease(&self) -> DiscoveryWorkerLeaseProjection {
        self.lease.lock().expect("multi-source lease").clone()
    }

    fn add_terminal_run(&self, run: DiscoveryRunProjection) {
        self.terminal_runs.lock().expect("terminal runs").push(run);
    }

    fn reject_salvage_for(&self, run_id: Uuid) {
        self.fail_salvage_runs
            .lock()
            .expect("failed salvage runs")
            .push(run_id);
    }

    fn record(&self, call: &'static str) {
        self.calls.lock().expect("multi-source calls").push(call);
    }
}

impl WorkerProtocol for MultiSourceProtocol {
    fn status(&self, run_id: Uuid) -> crate::discovery_worker::protocol::RunStatusFuture<'_> {
        let run = self
            .terminal_runs
            .lock()
            .expect("terminal runs")
            .iter()
            .find(|run| run.run_id == run_id)
            .cloned()
            .unwrap_or_else(|| self.lease().run);
        Box::pin(async move { Ok(run) })
    }

    fn claim(&self, _: DiscoveryWorkerClaimRequest) -> ProtocolFuture<'_> {
        Box::pin(async {
            self.record("claim");
            Ok(DiscoveryWorkerReceiptOutcome::Lease(self.lease()))
        })
    }

    fn heartbeat(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async {
            self.record("heartbeat");
            let count = self.heartbeat_count.fetch_add(1, AtomicOrdering::SeqCst) + 1;
            if self
                .cancel_on_heartbeat
                .is_some_and(|threshold| count >= threshold)
            {
                let mut run = self.lease().run;
                run.state = DiscoveryRunState::Cancelled;
                run.cancel_requested = true;
                return Ok(DiscoveryWorkerReceiptOutcome::LostLease(run));
            }
            Ok(DiscoveryWorkerReceiptOutcome::Lease(self.lease()))
        })
    }

    fn checkpoint(&self, request: DiscoveryWorkerCheckpointRequest) -> ProtocolFuture<'_> {
        Box::pin(async move {
            self.record("checkpoint");
            let mut lease = self.lease.lock().expect("multi-source lease");
            if request.checkpoint.kind == DiscoveryCheckpointKind::ProviderSubmitted {
                let source = lease
                    .source_states
                    .iter_mut()
                    .find(|source| source.provider == request.checkpoint.provider)
                    .expect("checkpoint provider source");
                source.status = DiscoveryRunSourceStatus::Active;
                source.request_cursor = request.checkpoint.provider_request_id.clone();
                source.request_count = 1;
                source.started_at = Some(Utc::now());
                source.updated_at = Utc::now();
            }
            lease.last_checkpoint = Some(request.checkpoint);
            Ok(DiscoveryWorkerReceiptOutcome::Lease(lease.clone()))
        })
    }

    fn source_progress(&self, request: DiscoveryWorkerSourceProgressRequest) -> ProtocolFuture<'_> {
        Box::pin(async move {
            self.record("source_progress");
            let mut lease = self.lease.lock().expect("multi-source lease");
            let source = lease
                .source_states
                .iter_mut()
                .find(|source| source.provider == request.provider)
                .expect("progress provider source");
            source.status = request.status;
            if request.request_cursor.is_some() {
                source.request_cursor = request.request_cursor;
            }
            source.request_count = request.request_count;
            source.returned_count = request.returned_count;
            source.failure_class = request.failure_class;
            source.started_at.get_or_insert_with(Utc::now);
            if matches!(
                request.status,
                DiscoveryRunSourceStatus::Completed
                    | DiscoveryRunSourceStatus::Exhausted
                    | DiscoveryRunSourceStatus::Failed
                    | DiscoveryRunSourceStatus::OutcomeUnknown
                    | DiscoveryRunSourceStatus::Cancelled
                    | DiscoveryRunSourceStatus::SkippedTargetMet
            ) {
                source.finished_at = Some(Utc::now());
            }
            source.updated_at = Utc::now();
            Ok(DiscoveryWorkerReceiptOutcome::Lease(lease.clone()))
        })
    }

    fn store_observations(
        &self,
        request: DiscoveryWorkerObservationBatchRequest,
    ) -> ProtocolFuture<'_> {
        Box::pin(async move {
            self.record("store_observations");
            let mut lease = self.lease.lock().expect("multi-source lease");
            let source = lease
                .source_states
                .iter_mut()
                .find(|source| source.provider == request.provider)
                .expect("observation provider source");
            let accepted_count = u16::try_from(request.observations.len())
                .map_err(|_| "too many fixture observations".to_owned())?;
            source.retained_count = source
                .retained_count
                .saturating_add(u32::from(accepted_count));
            source.updated_at = Utc::now();
            Ok(DiscoveryWorkerReceiptOutcome::ObservationsStored(
                DiscoveryWorkerStoredObservationsProjection {
                    lease: lease.clone(),
                    accepted_count,
                    existing_count: 0,
                },
            ))
        })
    }

    fn salvage_observations(
        &self,
        request: DiscoveryWorkerSalvageBatchRequest,
    ) -> ProtocolFuture<'_> {
        Box::pin(async move {
            self.record("salvage_observations");
            if self
                .fail_salvage_runs
                .lock()
                .expect("failed salvage runs")
                .contains(&request.run_id)
            {
                return Err("fixture salvage rejection".to_owned());
            }
            let accepted_count = u16::try_from(request.observations.len())
                .map_err(|_| "too many salvage fixture observations".to_owned())?;
            Ok(DiscoveryWorkerReceiptOutcome::ObservationsSalvaged(
                DiscoveryWorkerSalvagedObservationsProjection {
                    run: self.lease().run,
                    accepted_count,
                    existing_count: 0,
                },
            ))
        })
    }

    fn fail(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async {
            self.record("fail");
            let mut lease = self.lease.lock().expect("multi-source lease");
            lease.run.state = DiscoveryRunState::Failed;
            Ok(DiscoveryWorkerReceiptOutcome::Failed(lease.run.clone()))
        })
    }

    fn complete(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
        Box::pin(async {
            self.record("complete");
            self.completed.store(true, AtomicOrdering::SeqCst);
            let mut lease = self.lease.lock().expect("multi-source lease");
            lease.run.state = DiscoveryRunState::Succeeded;
            Ok(DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()))
        })
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
        protocol_version: buzz_core_pkg::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
        state: DiscoveryRunState::Running,
        completed_steps: 0,
        total_steps: 2,
        cancel_requested: false,
        terminal_reason: None,
        billing: None,
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

fn concurrent_synchronous_lease() -> DiscoveryWorkerLeaseProjection {
    let mut value = lease(None);
    value.business_search.limit = 2;
    value.source_config = DiscoverySourceConfig {
        mode: DiscoverySourceMode::Concurrent,
        sources: vec![DiscoverySource::BraveSearch, DiscoverySource::ExaSearch],
    };
    value.source_states = [
        (DiscoverySource::BraveSearch, DiscoveryProvider::BraveSearch),
        (DiscoverySource::ExaSearch, DiscoveryProvider::ExaSearch),
    ]
    .into_iter()
    .enumerate()
    .map(
        |(position, (source, provider))| DiscoveryRunSourceProjection {
            source,
            provider,
            position: u8::try_from(position).expect("source position"),
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
        },
    )
    .collect();
    value
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

#[path = "worker_host_multi_source_tests.rs"]
mod multi_source_tests;

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

#[path = "worker_host_legacy_tests.rs"]
mod legacy_tests;

#[path = "worker_host_integration_tests.rs"]
mod integration_tests;
#[path = "worker_host_outbox_tests.rs"]
mod outbox_tests;
