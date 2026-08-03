use super::*;

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
