use super::*;
use crate::discovery_worker::outbox::SynchronousCallState;

#[tokio::test]
async fn startup_reconciliation_preserves_unresolved_terminal_calls() {
    let mut lease = concurrent_synchronous_lease();
    lease.run.state = DiscoveryRunState::Cancelled;
    lease.run.cancel_requested = true;
    let run_id = lease.run.run_id;
    let worker_id = lease.worker_id;
    let protocol = MultiSourceProtocol::new(lease);
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open terminal reconciliation outbox");
    outbox
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .expect("write stale terminal call");

    reconcile_terminal_outbox(&protocol, &outbox, worker_id)
        .await
        .expect("reconcile terminal run");

    assert_eq!(
        outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
        Some(SynchronousCallState::Intent)
    );
}

#[tokio::test]
async fn startup_reconciliation_salvages_and_removes_terminal_paid_results() {
    let mut lease = concurrent_synchronous_lease();
    lease.run.state = DiscoveryRunState::Cancelled;
    lease.run.cancel_requested = true;
    for source in &mut lease.source_states {
        source.status = DiscoveryRunSourceStatus::Cancelled;
        source.failure_class = Some(DiscoveryRunSourceFailureClass::Cancelled);
        source.started_at = Some(Utc::now());
        source.finished_at = Some(Utc::now());
    }
    let run_id = lease.run.run_id;
    let worker_id = lease.worker_id;
    let protocol = MultiSourceProtocol::new(lease);
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open terminal salvage outbox");
    let call = outbox
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .expect("write paid call");
    outbox
        .record_results(
            call.call_id,
            None,
            1,
            vec![{
                let mut value = observation("salvage-paid-result");
                value.provider = DiscoveryProvider::BraveSearch;
                value.observation_id = deterministic_business_observation_id(
                    DiscoveryProvider::BraveSearch,
                    &value.provider_record_id,
                );
                value.place_id = None;
                value
            }],
        )
        .expect("persist paid result");

    reconcile_terminal_outbox(&protocol, &outbox, worker_id)
        .await
        .expect("salvage terminal paid result");

    assert_eq!(
        outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
        None
    );
    assert!(protocol
        .calls
        .lock()
        .expect("salvage calls")
        .contains(&"salvage_observations"));
}

#[tokio::test]
async fn terminal_outscraper_submission_is_polled_without_resubmit_then_salvaged() {
    let mut lease = concurrent_synchronous_lease();
    lease.run.state = DiscoveryRunState::Cancelled;
    lease.run.cancel_requested = true;
    for source in &mut lease.source_states {
        source.status = DiscoveryRunSourceStatus::Cancelled;
        source.failure_class = Some(DiscoveryRunSourceFailureClass::Cancelled);
        source.started_at = Some(Utc::now());
        source.finished_at = Some(Utc::now());
    }
    let run_id = lease.run.run_id;
    let worker_id = lease.worker_id;
    let protocol = MultiSourceProtocol::new(lease);
    let (outscraper, outscraper_state, outscraper_handle) = start_local_outscraper().await;
    outscraper_state
        .allow_success
        .store(true, AtomicOrdering::SeqCst);
    let (brave, exa, synchronous_handle) = start_local_synchronous_sources().await;
    let providers = ProductionProviderClients::for_test(outscraper, brave, exa);
    let credentials = LocalProviderCredentials::for_test(Some("outscraper-test-key"), None, None);
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open terminal submitted outbox");
    let call = outbox
        .begin_call(run_id, DiscoveryProvider::Outscraper)
        .expect("write paid Outscraper intent");
    outbox
        .mark_submitted(call.call_id, "local-job-1")
        .expect("persist submitted Outscraper job");

    recover_terminal_outscraper_submissions(
        &protocol,
        &providers,
        &credentials,
        &outbox,
        worker_id,
    )
    .await
    .expect("poll and salvage terminal paid job");

    assert_eq!(
        outscraper_state.submit_count.load(AtomicOrdering::SeqCst),
        0
    );
    assert_eq!(outscraper_state.poll_count.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(
        outbox.state_for(run_id, DiscoveryProvider::Outscraper),
        None
    );
    assert!(protocol
        .calls
        .lock()
        .expect("recovery calls")
        .contains(&"salvage_observations"));
    outscraper_handle.abort();
    synchronous_handle.abort();
}

#[tokio::test]
async fn pending_terminal_recovery_is_bounded_and_does_not_block_a_new_brave_run() {
    let mut lease = concurrent_synchronous_lease();
    lease.business_search.limit = 1;
    lease.source_config = DiscoverySourceConfig {
        mode: DiscoverySourceMode::Waterfall,
        sources: vec![DiscoverySource::BraveSearch],
    };
    lease.source_states.truncate(1);
    let worker_id = lease.worker_id;
    let mut terminal_run = lease.run.clone();
    terminal_run.run_id = Uuid::new_v4();
    terminal_run.state = DiscoveryRunState::Cancelled;
    terminal_run.cancel_requested = true;
    let terminal_run_id = terminal_run.run_id;
    let protocol = MultiSourceProtocol::new(lease);
    protocol.add_terminal_run(terminal_run);

    let (outscraper, outscraper_state, outscraper_handle) = start_local_outscraper().await;
    let (brave, exa, synchronous_handle) = start_local_synchronous_sources().await;
    let providers = ProductionProviderClients::for_test(outscraper, brave, exa);
    let credentials = LocalProviderCredentials::for_test(
        Some("outscraper-test-key"),
        Some("brave-test-key"),
        None,
    );
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open mixed recovery outbox");
    let call = outbox
        .begin_call(terminal_run_id, DiscoveryProvider::Outscraper)
        .expect("write stale paid submission");
    outbox
        .mark_submitted(call.call_id, "local-job-1")
        .expect("persist stale submitted job");

    reconcile_terminal_outbox(&protocol, &outbox, worker_id)
        .await
        .expect("inspect terminal outbox");
    recover_terminal_outscraper_submissions(
        &protocol,
        &providers,
        &credentials,
        &outbox,
        worker_id,
    )
    .await
    .expect("bounded terminal recovery pass");

    let outcome = run_multi_source_production_once(
        &protocol,
        &providers,
        &credentials,
        &outbox,
        worker_id,
        vec![DiscoveryProvider::BraveSearch],
    )
    .await
    .expect("unrelated Brave run proceeds");

    assert_eq!(outcome, HostRunOutcome::Completed);
    assert!(protocol.completed.load(AtomicOrdering::SeqCst));
    assert_eq!(
        outscraper_state.submit_count.load(AtomicOrdering::SeqCst),
        0
    );
    assert_eq!(outscraper_state.poll_count.load(AtomicOrdering::SeqCst), 1);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    assert_eq!(
        outbox
            .submitted_recovery_due(call.call_id, now)
            .expect("persisted recovery backoff"),
        None
    );
    assert_eq!(
        outbox.state_for(terminal_run_id, DiscoveryProvider::Outscraper),
        Some(SynchronousCallState::Submitted)
    );
    outscraper_handle.abort();
    synchronous_handle.abort();
}

#[tokio::test]
async fn rejected_terminal_salvage_does_not_block_a_new_brave_run() {
    let mut lease = concurrent_synchronous_lease();
    lease.business_search.limit = 1;
    lease.source_config = DiscoverySourceConfig {
        mode: DiscoverySourceMode::Waterfall,
        sources: vec![DiscoverySource::BraveSearch],
    };
    lease.source_states.truncate(1);
    let worker_id = lease.worker_id;
    let mut terminal_run = lease.run.clone();
    terminal_run.run_id = Uuid::new_v4();
    terminal_run.state = DiscoveryRunState::Cancelled;
    terminal_run.cancel_requested = true;
    let terminal_run_id = terminal_run.run_id;
    let protocol = MultiSourceProtocol::new(lease);
    protocol.add_terminal_run(terminal_run);
    protocol.reject_salvage_for(terminal_run_id);

    let (outscraper, _, outscraper_handle) = start_local_outscraper().await;
    let (brave, exa, synchronous_handle) = start_local_synchronous_sources().await;
    let providers = ProductionProviderClients::for_test(outscraper, brave, exa);
    let credentials = LocalProviderCredentials::for_test(None, Some("brave-test-key"), None);
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open rejected salvage outbox");
    let call = outbox
        .begin_call(terminal_run_id, DiscoveryProvider::ExaSearch)
        .expect("write paid Exa result");
    let mut paid_observation = observation("rejected-salvage");
    paid_observation.provider = DiscoveryProvider::ExaSearch;
    paid_observation.place_id = None;
    paid_observation.observation_id = deterministic_business_observation_id(
        DiscoveryProvider::ExaSearch,
        &paid_observation.provider_record_id,
    );
    outbox
        .record_results(call.call_id, None, 1, vec![paid_observation])
        .expect("persist paid Exa result");

    reconcile_terminal_outbox(&protocol, &outbox, worker_id)
        .await
        .expect("best-effort rejected salvage pass");

    let outcome = run_multi_source_production_once(
        &protocol,
        &providers,
        &credentials,
        &outbox,
        worker_id,
        vec![DiscoveryProvider::BraveSearch],
    )
    .await
    .expect("unrelated Brave run proceeds after salvage rejection");

    assert_eq!(outcome, HostRunOutcome::Completed);
    assert!(protocol.completed.load(AtomicOrdering::SeqCst));
    assert_eq!(
        outbox.state_for(terminal_run_id, DiscoveryProvider::ExaSearch),
        Some(SynchronousCallState::Ready)
    );
    outscraper_handle.abort();
    synchronous_handle.abort();
}

#[tokio::test]
async fn production_multi_source_entry_runs_brave_and_exa_to_completion() {
    let lease = concurrent_synchronous_lease();
    let worker_id = lease.worker_id;
    let protocol = MultiSourceProtocol::new(lease);
    let (outscraper, _, outscraper_handle) = start_local_outscraper().await;
    let (brave, exa, synchronous_handle) = start_local_synchronous_sources().await;
    let providers = ProductionProviderClients::for_test(outscraper, brave, exa);
    let credentials =
        LocalProviderCredentials::for_test(None, Some("brave-test-key"), Some("exa-test-key"));
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open multi-source outbox");

    let outcome = run_multi_source_production_once(
        &protocol,
        &providers,
        &credentials,
        &outbox,
        worker_id,
        vec![DiscoveryProvider::BraveSearch, DiscoveryProvider::ExaSearch],
    )
    .await
    .expect("integrated multi-source production run");

    assert_eq!(outcome, HostRunOutcome::Completed);
    assert!(protocol.completed.load(AtomicOrdering::SeqCst));
    let final_lease = protocol.lease();
    assert_eq!(final_lease.run.state, DiscoveryRunState::Succeeded);
    assert_eq!(
        final_lease
            .source_states
            .iter()
            .map(|source| source.retained_count)
            .sum::<u32>(),
        2
    );
    assert!(final_lease.source_states.iter().all(|source| {
        source.status == DiscoveryRunSourceStatus::Completed
            && source.request_count == 1
            && source.returned_count == 1
    }));
    assert_eq!(
        protocol
            .calls
            .lock()
            .expect("multi-source calls")
            .iter()
            .filter(|call| **call == "store_observations")
            .count(),
        2
    );
    assert_eq!(
        outbox.state_for(final_lease.run.run_id, DiscoveryProvider::BraveSearch),
        None
    );
    assert_eq!(
        outbox.state_for(final_lease.run.run_id, DiscoveryProvider::ExaSearch),
        None
    );
    outscraper_handle.abort();
    synchronous_handle.abort();
}

#[tokio::test]
async fn production_failures_record_every_paid_brave_and_exa_attempt() {
    let lease = concurrent_synchronous_lease();
    let worker_id = lease.worker_id;
    let protocol = MultiSourceProtocol::new(lease);
    let router = Router::new()
        .route("/brave", get(local_rate_limited))
        .route("/exa", post(local_rate_limited));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind rate-limited provider server");
    let address = listener
        .local_addr()
        .expect("rate-limited provider address");
    let provider_handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve rate-limited provider endpoints");
    });
    let (outscraper, _, outscraper_handle) = start_local_outscraper().await;
    let brave = BraveSearchClient::for_local_test(format!("http://{address}/brave"))
        .expect("rate-limited Brave client");
    let exa = ExaSearchClient::for_local_test(format!("http://{address}/exa"))
        .expect("rate-limited Exa client");
    let providers = ProductionProviderClients::for_test(outscraper, brave, exa);
    let credentials =
        LocalProviderCredentials::for_test(None, Some("brave-test-key"), Some("exa-test-key"));
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open rate-limited outbox");

    let outcome = run_multi_source_production_once(
        &protocol,
        &providers,
        &credentials,
        &outbox,
        worker_id,
        vec![DiscoveryProvider::BraveSearch, DiscoveryProvider::ExaSearch],
    )
    .await
    .expect("record bounded provider failures");

    assert_eq!(outcome, HostRunOutcome::Failed);
    assert!(protocol.lease().source_states.iter().all(|source| {
        source.status == DiscoveryRunSourceStatus::Failed
            && source.request_count == 3
            && source.returned_count == 0
            && source.failure_class == Some(DiscoveryRunSourceFailureClass::RateLimited)
    }));
    assert!(outbox.run_ids().expect("read failed outbox").is_empty());
    outscraper_handle.abort();
    provider_handle.abort();
}

#[tokio::test]
async fn terminal_lost_lease_preserves_an_inflight_synchronous_call() {
    let mut lease = concurrent_synchronous_lease();
    lease.lease_until = Utc::now() + chrono::Duration::milliseconds(150);
    lease.business_search.limit = 1;
    lease.source_config = DiscoverySourceConfig {
        mode: DiscoverySourceMode::Waterfall,
        sources: vec![DiscoverySource::BraveSearch],
    };
    lease.source_states.truncate(1);
    let run_id = lease.run.run_id;
    let worker_id = lease.worker_id;
    let protocol = MultiSourceProtocol::cancelling(lease, 2);
    let (outscraper, _, outscraper_handle) = start_local_outscraper().await;
    let router = Router::new()
        .route("/brave-delayed", get(local_delayed_brave_search))
        .route("/exa", post(local_exa_search));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind cancellation provider server");
    let address = listener
        .local_addr()
        .expect("cancellation provider address");
    let cancellation_handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve cancellation provider endpoint");
    });
    let brave = BraveSearchClient::for_local_test(format!("http://{address}/brave-delayed"))
        .expect("delayed Brave client");
    let exa = ExaSearchClient::for_local_test(format!("http://{address}/exa"))
        .expect("unused local Exa client");
    let providers = ProductionProviderClients::for_test(outscraper, brave, exa);
    let credentials = LocalProviderCredentials::for_test(None, Some("brave-test-key"), None);
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open cancellation outbox");

    let outcome = run_multi_source_production_once(
        &protocol,
        &providers,
        &credentials,
        &outbox,
        worker_id,
        vec![DiscoveryProvider::BraveSearch],
    )
    .await
    .expect("cancel inflight multi-source run");

    assert_eq!(outcome, HostRunOutcome::LostLease);
    assert!(!protocol.completed.load(AtomicOrdering::SeqCst));
    assert_eq!(
        outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
        Some(SynchronousCallState::Intent)
    );
    outscraper_handle.abort();
    cancellation_handle.abort();
}

#[tokio::test]
async fn entitlement_loss_between_brave_pages_preserves_first_page_and_buys_no_second_page() {
    let mut lease = concurrent_synchronous_lease();
    lease.business_search.limit = 30;
    lease.source_config = DiscoverySourceConfig {
        mode: DiscoverySourceMode::Waterfall,
        sources: vec![DiscoverySource::BraveSearch],
    };
    lease.source_states.truncate(1);
    let run_id = lease.run.run_id;
    let worker_id = lease.worker_id;
    // Heartbeats: source admission, first provider request, second provider request.
    let protocol = MultiSourceProtocol::cancelling(lease, 3);
    let provider_requests = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route("/brave", get(local_paginated_brave_search))
        .route("/exa", post(local_exa_search))
        .with_state(Arc::clone(&provider_requests));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind paginated provider server");
    let address = listener.local_addr().expect("paginated provider address");
    let provider_handle = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve paginated provider endpoint");
    });
    let (outscraper, _, outscraper_handle) = start_local_outscraper().await;
    let brave = BraveSearchClient::for_local_test(format!("http://{address}/brave"))
        .expect("paginated Brave client");
    let exa = ExaSearchClient::for_local_test(format!("http://{address}/exa"))
        .expect("unused local Exa client");
    let providers = ProductionProviderClients::for_test(outscraper, brave, exa);
    let credentials = LocalProviderCredentials::for_test(None, Some("brave-test-key"), None);
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("open paginated outbox");

    let outcome = run_multi_source_production_once(
        &protocol,
        &providers,
        &credentials,
        &outbox,
        worker_id,
        vec![DiscoveryProvider::BraveSearch],
    )
    .await
    .expect("cancel between paid Brave pages");

    assert_eq!(outcome, HostRunOutcome::LostLease);
    assert_eq!(provider_requests.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(protocol.lease().source_states[0].retained_count, 1);
    assert_eq!(
        outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
        None
    );
    outscraper_handle.abort();
    provider_handle.abort();
}
