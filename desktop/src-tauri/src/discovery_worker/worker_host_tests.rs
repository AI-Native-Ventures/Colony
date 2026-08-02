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
    discovery::{DiscoveryBusinessSearchSpec, DiscoveryRunProjection, DiscoveryRunState},
    discovery_worker::{
        deterministic_business_observation_id, DiscoveryBusinessObservationInput,
        DiscoveryBusinessStatus, DiscoveryCheckpointKind, DiscoveryProvider,
        DiscoveryWorkerCheckpoint, DiscoveryWorkerStoredObservationsProjection,
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
}

impl FakeProtocol {
    fn new(outcomes: Vec<DiscoveryWorkerReceiptOutcome>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into()),
            calls: Mutex::new(Vec::new()),
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

    fn store_observations(&self, _: DiscoveryWorkerObservationBatchRequest) -> ProtocolFuture<'_> {
        Box::pin(async { self.next("store_observations") })
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
        last_checkpoint,
    }
}

fn lease_outcome(value: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerReceiptOutcome {
    DiscoveryWorkerReceiptOutcome::Lease(value.clone())
}

fn observation(provider_record_id: &str) -> DiscoveryBusinessObservationInput {
    DiscoveryBusinessObservationInput {
        observation_id: deterministic_business_observation_id(provider_record_id),
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

#[ignore = "requires isolated Postgres, Redis, and relay with external workers enabled"]
#[tokio::test]
async fn native_host_real_relay_completes_and_recovers_after_restart() {
    use buzz_core_pkg::discovery::{DiscoveryBusinessSearchSpec, DiscoveryStartRequest};
    use buzz_core_pkg::discovery_workspace::{
        DiscoveryCampaignInput, DiscoveryLeadListRequest, DiscoveryWorkspaceActionPayload,
        DiscoveryWorkspaceRequest,
    };
    use buzz_sdk_pkg::{
        discovery::build_discovery_start_action,
        discovery_workspace::build_discovery_workspace_action,
    };
    use sqlx::Row as _;

    const FIXTURE_SECRET: &str = "native-host-secret-never-crosses-relay";
    let relay_url =
        std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3030".to_string());
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_string());
    let pool = sqlx::PgPool::connect(&database_url)
        .await
        .expect("connect isolated Postgres");
    let host = buzz_core_pkg::tenant::relay_url_authority(&relay_url);
    let community_id: Uuid = sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
        .bind(&host)
        .fetch_one(&pool)
        .await
        .expect("isolated community")
        .try_get("id")
        .expect("community id");
    let actor = nostr::Keys::generate();
    let actor_bytes = actor.public_key().to_bytes();
    let actor_hex = actor.public_key().to_hex();
    sqlx::query(
        "INSERT INTO users (community_id,pubkey,display_name) \
             VALUES ($1,$2,'Native Discovery Host') \
             ON CONFLICT (community_id,pubkey) DO NOTHING",
    )
    .bind(community_id)
    .bind(actor_bytes.as_slice())
    .execute(&pool)
    .await
    .expect("provision native host user");
    sqlx::query(
        "INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member') \
             ON CONFLICT (community_id,pubkey) DO NOTHING",
    )
    .bind(community_id)
    .bind(&actor_hex)
    .execute(&pool)
    .await
    .expect("provision native host member");
    sqlx::query(
        "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
             VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
             DO UPDATE SET active=TRUE,updated_at=now()",
    )
    .bind(community_id)
    .execute(&pool)
    .await
    .expect("enable Discovery entitlement");

    let state = crate::app_state::build_app_state();
    *state.keys.lock().expect("state keys") = actor.clone();
    *state.relay_url_override.lock().expect("workspace relay") = Some(relay_url.clone());
    crate::discovery_worker::workspace_changed();
    let generation = crate::discovery_worker::workspace_generation();
    let api_base_url = relay::relay_http_base_url(&relay_url);
    let relay_pubkey = super::super::protocol::fetch_relay_pubkey(&state, &api_base_url)
        .await
        .expect("relay signing identity");
    let worker_id = Uuid::new_v4();
    let credential = Zeroizing::new(FIXTURE_SECRET.to_string());
    let (provider, provider_state, provider_handle) = start_local_outscraper().await;

    let actions_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND kind=40019")
            .bind(community_id)
            .fetch_one(&pool)
            .await
            .expect("count worker actions before missing credential");
    let no_credential_protocol = RelayWorkerProtocol::connect(
        &state,
        actor.clone(),
        api_base_url.clone(),
        worker_id,
        generation,
    )
    .await
    .expect("missing-credential protocol");
    assert_eq!(
        run_once_with_loader(&no_credential_protocol, worker_id, Duration::ZERO, || Ok(
            None
        ),)
        .await
        .expect("missing credential outcome"),
        HostRunOutcome::NoCredential
    );
    let actions_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND kind=40019")
            .bind(community_id)
            .fetch_one(&pool)
            .await
            .expect("count worker actions after missing credential");
    assert_eq!(actions_before, actions_after);

    async fn start_run(
        state: &AppState,
        actor: &nostr::Keys,
        relay_pubkey: nostr::PublicKey,
        api_base_url: &str,
    ) -> (Uuid, Uuid) {
        let campaign_id = Uuid::new_v4();
        let campaign_request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::CreateCampaign {
                campaign: DiscoveryCampaignInput {
                    campaign_id,
                    name: "Sandton dentists".to_owned(),
                    industry_id: "healthcare".to_owned(),
                    industry_name: "Healthcare".to_owned(),
                    vertical_id: "dentists".to_owned(),
                    vertical_name: "Dentists".to_owned(),
                    query: "dentists".to_owned(),
                    location: "Sandton, Johannesburg, South Africa".to_owned(),
                    target: 3,
                    description: None,
                    language: "en".to_owned(),
                    region: Some("ZA".to_owned()),
                },
            },
        };
        let campaign_response = relay::submit_event_at_with_keys(
            build_discovery_workspace_action(relay_pubkey, &campaign_request)
                .expect("Discovery campaign builder"),
            state,
            api_base_url,
            actor,
        )
        .await
        .expect("create Discovery campaign");
        assert!(campaign_response.accepted, "campaign action must commit");
        let request = DiscoveryStartRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            campaign_id,
            business_search: DiscoveryBusinessSearchSpec {
                query: "dentists".to_owned(),
                location: "Sandton, Johannesburg, South Africa".to_owned(),
                limit: 3,
                language: "en".to_owned(),
                region: Some("ZA".to_owned()),
            },
        };
        let response = relay::submit_event_at_with_keys(
            build_discovery_start_action(relay_pubkey, &request).expect("Discovery start builder"),
            state,
            api_base_url,
            actor,
        )
        .await
        .expect("start Discovery run");
        let message: serde_json::Value =
            serde_json::from_str(&response.message).expect("start response");
        let run_id = Uuid::parse_str(
            message
                .get("run")
                .and_then(|run| run.get("run_id"))
                .and_then(serde_json::Value::as_str)
                .expect("started run id"),
        )
        .expect("valid started run id");
        (run_id, campaign_id)
    }

    let (first_run, campaign_id) = start_run(&state, &actor, relay_pubkey, &api_base_url).await;
    let first_protocol = RelayWorkerProtocol::connect(
        &state,
        actor.clone(),
        api_base_url.clone(),
        worker_id,
        generation,
    )
    .await
    .expect("first native host protocol");
    let mut first_host = Box::pin(run_production_once_with_credential(
        &first_protocol,
        &provider,
        worker_id,
        &credential,
    ));
    loop {
        tokio::select! {
            result = &mut first_host => panic!("first host exited before restart point: {result:?}"),
            () = tokio::time::sleep(Duration::from_millis(50)) => {
                let submitted: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM discovery_run_checkpoints \
                     WHERE community_id=$1 AND run_id=$2 AND sequence=1",
                )
                .bind(community_id)
                .bind(first_run)
                .fetch_one(&pool)
                .await
                .expect("poll provider-submitted checkpoint");
                if submitted == 1 {
                    break;
                }
            }
        }
    }
    drop(first_host);
    provider_state
        .allow_success
        .store(true, AtomicOrdering::SeqCst);
    tokio::time::sleep(Duration::from_secs(6)).await;

    let restarted_protocol = RelayWorkerProtocol::connect(
        &state,
        actor.clone(),
        api_base_url.clone(),
        worker_id,
        generation,
    )
    .await
    .expect("restarted native host protocol");
    assert_eq!(
        run_production_once_with_credential(
            &restarted_protocol,
            &provider,
            worker_id,
            &credential,
        )
        .await
        .expect("restarted native host outcome"),
        HostRunOutcome::Completed
    );
    let run_row = sqlx::query(
        "SELECT state,attempt,completed_steps FROM discovery_runs \
             WHERE community_id=$1 AND id=$2",
    )
    .bind(community_id)
    .bind(first_run)
    .fetch_one(&pool)
    .await
    .expect("completed native run");
    assert_eq!(run_row.get::<String, _>("state"), "succeeded");
    assert_eq!(run_row.get::<i32, _>("attempt"), 2);
    assert_eq!(run_row.get::<i32, _>("completed_steps"), 1);
    let checkpoints: Vec<(i32, Option<i32>)> = sqlx::query_as(
        "SELECT sequence,item_count FROM discovery_run_checkpoints \
             WHERE community_id=$1 AND run_id=$2 ORDER BY sequence",
    )
    .bind(community_id)
    .bind(first_run)
    .fetch_all(&pool)
    .await
    .expect("native checkpoints");
    assert_eq!(checkpoints, vec![(1, None), (2, Some(3))]);
    let retained_observations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_business_observations \
             WHERE community_id=$1 AND first_run_id=$2",
    )
    .bind(community_id)
    .bind(first_run)
    .fetch_one(&pool)
    .await
    .expect("retained local provider observations");
    assert_eq!(retained_observations, 3);
    let leads_request = DiscoveryWorkspaceRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        payload: DiscoveryWorkspaceActionPayload::ListLeads {
            request: DiscoveryLeadListRequest {
                campaign_id: Some(campaign_id),
                industry_id: None,
                vertical_id: None,
                offset: 0,
                limit: 100,
            },
        },
    };
    let leads_response = relay::submit_event_at_with_keys(
        build_discovery_workspace_action(relay_pubkey, &leads_request)
            .expect("Discovery Leads builder"),
        &state,
        &api_base_url,
        &actor,
    )
    .await
    .expect("list retained Discovery Leads");
    let leads_message: serde_json::Value =
        serde_json::from_str(&leads_response.message).expect("Leads response");
    let lead_result = leads_message.get("result").expect("private Leads result");
    assert_eq!(
        lead_result
            .get("result")
            .and_then(serde_json::Value::as_str),
        Some("leads")
    );
    assert_eq!(
        lead_result
            .get("page")
            .and_then(|page| page.get("total"))
            .and_then(serde_json::Value::as_u64),
        Some(3)
    );
    assert_eq!(
        lead_result
            .get("page")
            .and_then(|page| page.get("leads"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::len),
        Some(3)
    );
    assert_eq!(
        provider_state.submit_count.load(AtomicOrdering::SeqCst),
        1,
        "restart must not submit the paid provider job twice"
    );
    assert!(provider_state.poll_count.load(AtomicOrdering::SeqCst) >= 1);
    assert!(provider_state.header_seen.load(AtomicOrdering::SeqCst));
    {
        let request_shapes = provider_state
            .request_shapes
            .lock()
            .expect("request shapes");
        assert_eq!(request_shapes.len(), 1);
        let search_request = &request_shapes[0];
        for expected in [
            "query=dentists%2C+Sandton%2C+Johannesburg%2C+South+Africa",
            "limit=3",
            "language=en",
            "region=ZA",
            "async=true",
            "fields=",
        ] {
            assert!(
                search_request.contains(expected),
                "provider request missing {expected}: {search_request}"
            );
        }
    }
    let leaked_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM events WHERE community_id=$1 AND content LIKE '%' || $2 || '%'",
    )
    .bind(community_id)
    .bind(FIXTURE_SECRET)
    .fetch_one(&pool)
    .await
    .expect("scan native event contents");
    let leaked_checkpoints: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM discovery_run_checkpoints WHERE community_id=$1 \
             AND coalesce(provider_request_id,'') LIKE '%' || $2 || '%'",
    )
    .bind(community_id)
    .bind(FIXTURE_SECRET)
    .fetch_one(&pool)
    .await
    .expect("scan native checkpoints");
    assert_eq!((leaked_events, leaked_checkpoints), (0, 0));
    assert!(provider_state
        .request_shapes
        .lock()
        .expect("request shapes")
        .iter()
        .all(|shape| !shape.contains(FIXTURE_SECRET)));
    provider_handle.abort();
}
