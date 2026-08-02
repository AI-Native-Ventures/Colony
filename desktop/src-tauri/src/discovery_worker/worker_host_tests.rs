use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        Mutex,
    },
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

use super::*;
use crate::discovery_worker::protocol::ProtocolFuture;

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
    use buzz_sdk_pkg::discovery::build_discovery_start_action;
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

    let actions_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND kind=40017")
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
        sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND kind=40017")
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
    ) -> Uuid {
        let request = DiscoveryStartRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            campaign_id: Uuid::new_v4(),
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
        Uuid::parse_str(
            message
                .get("run")
                .and_then(|run| run.get("run_id"))
                .and_then(serde_json::Value::as_str)
                .expect("started run id"),
        )
        .expect("valid started run id")
    }

    let first_run = start_run(&state, &actor, relay_pubkey, &api_base_url).await;
    let first_protocol = RelayWorkerProtocol::connect(
        &state,
        actor.clone(),
        api_base_url.clone(),
        worker_id,
        generation,
    )
    .await
    .expect("first native host protocol");
    let mut first_host = Box::pin(run_once_with_credential(
        &first_protocol,
        worker_id,
        Duration::from_secs(2),
        Zeroizing::new(FIXTURE_SECRET.to_string()),
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
        run_once_with_credential(
            &restarted_protocol,
            worker_id,
            Duration::ZERO,
            Zeroizing::new(FIXTURE_SECRET.to_string()),
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
    let checkpoints: Vec<i32> = sqlx::query_scalar(
        "SELECT sequence FROM discovery_run_checkpoints \
             WHERE community_id=$1 AND run_id=$2 ORDER BY sequence",
    )
    .bind(community_id)
    .bind(first_run)
    .fetch_all(&pool)
    .await
    .expect("native checkpoints");
    assert_eq!(checkpoints, vec![1, 2]);
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
}
