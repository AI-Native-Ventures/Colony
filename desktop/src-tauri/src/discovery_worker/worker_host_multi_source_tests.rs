use super::*;

#[tokio::test]
async fn startup_reconciliation_removes_outbox_calls_for_terminal_runs() {
    let mut lease = concurrent_synchronous_lease();
    lease.run.state = DiscoveryRunState::Cancelled;
    lease.run.cancel_requested = true;
    let run_id = lease.run.run_id;
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

    reconcile_terminal_outbox(&protocol, &outbox)
        .await
        .expect("reconcile terminal run");

    assert!(outbox.run_ids().expect("read reconciled calls").is_empty());
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
async fn terminal_lost_lease_clears_an_inflight_synchronous_call() {
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
        None
    );
    outscraper_handle.abort();
    cancellation_handle.abort();
}

#[tokio::test]
async fn entitlement_loss_between_brave_pages_preserves_first_page_and_buys_no_second_page() {
    let mut lease = concurrent_synchronous_lease();
    lease.business_search.limit = 2;
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
