use buzz_core_pkg::discovery_worker::{
    deterministic_business_observation_id, DiscoveryBusinessObservationInput, DiscoveryProvider,
};
use uuid::Uuid;

use super::*;

pub(super) const ACTOR_ONE: &str =
    "31029e74e8d93b2238fdf0be93f56a084b923e4e5b6ff55b03109bd86a87061b";
pub(super) const ACTOR_TWO: &str =
    "17c4e256a47fd3b862e98af9877dd954b24135e875d077a94ca5c2f1cb6e49dc";

fn observation(provider: DiscoveryProvider, index: usize) -> DiscoveryBusinessObservationInput {
    let provider_record_id = format!("provider-record-{index}");
    DiscoveryBusinessObservationInput {
        observation_id: deterministic_business_observation_id(provider, &provider_record_id),
        provider,
        provider_record_id,
        place_id: None,
        google_id: None,
        name: format!("Business {index}"),
        website: Some(format!("https://business-{index}.example")),
        phone: None,
        full_address: None,
        city: Some("Johannesburg".to_owned()),
        state: Some("Gauteng".to_owned()),
        postal_code: None,
        country: Some("South Africa".to_owned()),
        country_code: Some("ZA".to_owned()),
        latitude_micros: None,
        longitude_micros: None,
        category: None,
        subtypes: Vec::new(),
        rating_hundredths: None,
        reviews_count: None,
        business_status: None,
        verified: None,
        source_url: None,
        image_url: None,
        description: None,
    }
}

pub(super) fn observations(
    provider: DiscoveryProvider,
    count: usize,
) -> Vec<DiscoveryBusinessObservationInput> {
    (0..count)
        .map(|index| observation(provider, index))
        .collect()
}

#[test]
fn written_intent_becomes_outcome_unknown_after_restart_and_cannot_repeat() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    first
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .expect("write call intent");
    assert_eq!(
        first.state_for(run_id, DiscoveryProvider::BraveSearch),
        Some(SynchronousCallState::Intent)
    );
    drop(first);

    let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("reopen outbox");
    assert_eq!(
        recovered.state_for(run_id, DiscoveryProvider::BraveSearch),
        Some(SynchronousCallState::OutcomeUnknown)
    );
    assert!(recovered
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .is_err());
}

#[test]
fn provider_response_without_normalized_outbox_is_not_repeated_after_restart() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    let _call = first
        .begin_call(run_id, DiscoveryProvider::ExaSearch)
        .expect("write call intent");
    // Simulate the process dying after the HTTP response arrived but before
    // the normalized response could be committed atomically.
    drop(first);

    let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("reopen outbox");
    assert_eq!(
        recovered.state_for(run_id, DiscoveryProvider::ExaSearch),
        Some(SynchronousCallState::OutcomeUnknown)
    );
}

#[test]
fn normalized_results_and_batch_identities_survive_restart() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    let call = first
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .expect("write call intent");
    first
        .record_results(
            call.call_id,
            None,
            2,
            observations(DiscoveryProvider::BraveSearch, 30),
        )
        .expect("record normalized results");
    let first_batch = first
        .next_batch(call.call_id)
        .expect("read batch")
        .expect("first batch");
    drop(first);

    let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("reopen outbox");
    assert_eq!(
        recovered.state_for(run_id, DiscoveryProvider::BraveSearch),
        Some(SynchronousCallState::Ready)
    );
    let recovered_batch = recovered
        .next_batch(call.call_id)
        .expect("read recovered batch")
        .expect("recovered first batch");
    assert_eq!(recovered_batch, first_batch);
    assert_eq!(recovered_batch.observations.len(), 25);
    assert_eq!(
        recovered.call_for(run_id, DiscoveryProvider::BraveSearch),
        Some(call)
    );
    assert_eq!(
        recovered
            .ready_metadata(call.call_id)
            .expect("read result metadata"),
        Some(SynchronousReadyMetadata {
            provider_request_id: call.call_id.to_string(),
            request_count: 2,
            item_count: 30,
            response_complete: true,
        })
    );
}

#[test]
fn paid_page_is_durable_before_the_response_is_complete() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    let call = first
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .expect("write call intent");
    first
        .append_results(
            call.call_id,
            None,
            1,
            observations(DiscoveryProvider::BraveSearch, 2),
        )
        .expect("persist paid first page");
    let batch = first
        .next_batch(call.call_id)
        .expect("read paid page")
        .expect("paid page batch");
    first
        .acknowledge_batch(call.call_id, batch.batch_index)
        .expect("acknowledge paid page");
    drop(first);

    let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("recover incomplete paid search");
    assert!(recovered
        .next_batch(call.call_id)
        .expect("read drained paid page")
        .is_none());
    assert_eq!(
        recovered
            .ready_metadata(call.call_id)
            .expect("read incomplete response"),
        Some(SynchronousReadyMetadata {
            provider_request_id: call.call_id.to_string(),
            request_count: 1,
            item_count: 2,
            response_complete: false,
        })
    );
}

#[test]
fn acknowledged_batch_progress_survives_restart_and_keeps_retry_ids_stable() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    let call = first
        .begin_call(run_id, DiscoveryProvider::ExaSearch)
        .expect("write call intent");
    first
        .record_results(
            call.call_id,
            Some("exa-request-1".to_owned()),
            1,
            observations(DiscoveryProvider::ExaSearch, 30),
        )
        .expect("record normalized results");
    let first_batch = first
        .next_batch(call.call_id)
        .expect("read batch")
        .expect("first batch");
    first
        .acknowledge_batch(call.call_id, first_batch.batch_index)
        .expect("acknowledge first batch");
    drop(first);

    let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("reopen outbox");
    let second_batch = recovered
        .next_batch(call.call_id)
        .expect("read second batch")
        .expect("second batch");
    assert_eq!(second_batch.batch_index, 1);
    assert_eq!(second_batch.observations.len(), 5);
    assert_ne!(first_batch.request_id, second_batch.request_id);
    assert_ne!(first_batch.idempotency_key, second_batch.idempotency_key);
}

#[test]
fn fully_drained_results_remain_until_a_relay_terminal_acknowledgement() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    let call = outbox
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .expect("write call intent");
    outbox
        .record_results(
            call.call_id,
            None,
            1,
            observations(DiscoveryProvider::BraveSearch, 2),
        )
        .expect("record normalized results");
    let batch = outbox
        .next_batch(call.call_id)
        .expect("read batch")
        .expect("batch");
    outbox
        .acknowledge_batch(call.call_id, batch.batch_index)
        .expect("acknowledge batch");
    assert!(outbox
        .next_batch(call.call_id)
        .expect("read drained state")
        .is_none());
    assert_eq!(
        outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
        Some(SynchronousCallState::Ready)
    );

    outbox
        .remove_after_relay_ack(call.call_id)
        .expect("remove after relay ack");
    assert_eq!(
        outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
        None
    );
}
