use super::*;

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
