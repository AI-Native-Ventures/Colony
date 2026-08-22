use super::*;

#[tokio::test]
async fn legacy_drain_claims_released_protocols_with_only_stored_keys() {
    let protocol = FakeProtocol::new(vec![
        DiscoveryWorkerReceiptOutcome::Idle,
        DiscoveryWorkerReceiptOutcome::Idle,
    ]);
    let (outscraper, _, outscraper_server) = start_local_outscraper().await;
    let (brave, exa, source_server) = start_local_synchronous_sources().await;
    let providers = ProductionProviderClients::for_test(outscraper, brave, exa);
    let credentials = LocalProviderCredentials::for_test(Some("legacy-key"), None, None);
    let dir = tempfile::tempdir().expect("legacy drain directory");
    let outbox = DiscoveryOutbox::open(
        dir.path(),
        "wss://relay-one.example",
        "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b",
    )
    .expect("legacy drain outbox");
    let worker_id = Uuid::new_v4();
    for version in [
        buzz_core_pkg::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
        1,
    ] {
        assert_eq!(
            run_multi_source_production_for_protocol_once(
                &protocol,
                &providers,
                &credentials,
                &outbox,
                worker_id,
                credentials.available_providers(),
                version,
            )
            .await
            .expect("legacy drain claim"),
            HostRunOutcome::Idle
        );
    }
    let claims = protocol.claims.lock().expect("legacy claims");
    assert_eq!(
        claims
            .iter()
            .map(|claim| claim.protocol_version)
            .collect::<Vec<_>>(),
        vec![buzz_core_pkg::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION, 1]
    );
    assert!(claims.iter().all(|claim| {
        claim.available_providers == vec![DiscoveryProvider::Outscraper]
    }));
    outscraper_server.abort();
    source_server.abort();
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
