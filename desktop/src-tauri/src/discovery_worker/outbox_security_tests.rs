use buzz_core_pkg::discovery_worker::DiscoveryProvider;
use uuid::Uuid;

use super::{
    tests::{observations, ACTOR_ONE, ACTOR_TWO},
    DiscoveryOutbox, SynchronousCallState,
};

#[test]
fn community_and_actor_scopes_are_physically_isolated() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open first outbox");
    first
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .expect("write first intent");

    let other_relay = DiscoveryOutbox::open(dir.path(), "wss://relay-two.example", ACTOR_ONE)
        .expect("open other relay outbox");
    let other_actor = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_TWO)
        .expect("open other actor outbox");
    assert_eq!(
        other_relay.state_for(run_id, DiscoveryProvider::BraveSearch),
        None
    );
    assert_eq!(
        other_actor.state_for(run_id, DiscoveryProvider::BraveSearch),
        None
    );
    assert_ne!(first.path(), other_relay.path());
    assert_ne!(first.path(), other_actor.path());
}

#[test]
fn accepted_call_without_recoverable_response_stays_outcome_unknown() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let first = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    let call = first
        .begin_call(run_id, DiscoveryProvider::ExaSearch)
        .expect("write call intent");
    first
        .mark_outcome_unknown(call.call_id)
        .expect("record unknown outcome");
    drop(first);

    let recovered = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("reopen outbox");
    assert_eq!(
        recovered.state_for(run_id, DiscoveryProvider::ExaSearch),
        Some(SynchronousCallState::OutcomeUnknown)
    );
    assert!(recovered
        .begin_call(run_id, DiscoveryProvider::ExaSearch)
        .is_err());
}

#[test]
fn terminal_run_cleanup_removes_ambiguous_and_ready_calls() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let other_run = Uuid::new_v4();
    let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    outbox
        .begin_call(run_id, DiscoveryProvider::BraveSearch)
        .expect("write ambiguous call");
    let ready = outbox
        .begin_call(run_id, DiscoveryProvider::ExaSearch)
        .expect("write ready call");
    outbox
        .record_results(
            ready.call_id,
            Some("exa-terminal".to_owned()),
            1,
            observations(DiscoveryProvider::ExaSearch, 1),
        )
        .expect("record terminal results");
    outbox
        .begin_call(other_run, DiscoveryProvider::BraveSearch)
        .expect("write unrelated call");

    outbox
        .remove_terminal_run(run_id)
        .expect("remove terminal run calls");

    assert_eq!(
        outbox.state_for(run_id, DiscoveryProvider::BraveSearch),
        None
    );
    assert_eq!(outbox.state_for(run_id, DiscoveryProvider::ExaSearch), None);
    assert_eq!(
        outbox.state_for(other_run, DiscoveryProvider::BraveSearch),
        Some(SynchronousCallState::Intent)
    );
}

#[test]
fn outbox_contains_no_provider_secret_query_or_raw_response() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let run_id = Uuid::new_v4();
    let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    let call = outbox
        .begin_call(run_id, DiscoveryProvider::ExaSearch)
        .expect("write call intent");
    outbox
        .record_results(
            call.call_id,
            Some("exa-request-safe".to_owned()),
            1,
            observations(DiscoveryProvider::ExaSearch, 1),
        )
        .expect("record normalized results");
    let serialized = std::fs::read_to_string(outbox.path()).expect("read persisted outbox");
    for forbidden in [
        "api_key",
        "authorization",
        "x-api-key",
        "x-subscription-token",
        "raw_response",
        "search_query",
    ] {
        assert!(!serialized.to_ascii_lowercase().contains(forbidden));
    }
}

#[cfg(unix)]
#[test]
fn outbox_directory_and_file_are_owner_only() {
    use std::os::unix::fs::PermissionsExt as _;

    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    outbox
        .begin_call(Uuid::new_v4(), DiscoveryProvider::BraveSearch)
        .expect("write call intent");
    assert_eq!(
        std::fs::metadata(outbox.path().parent().expect("outbox directory"))
            .expect("outbox directory metadata")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(outbox.path())
            .expect("outbox metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn malformed_outbox_fails_closed_without_starting_another_call() {
    let dir = tempfile::tempdir().expect("temporary app data");
    let outbox = DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE)
        .expect("open outbox");
    let path = outbox.path().to_path_buf();
    drop(outbox);
    std::fs::write(path, br#"{"version":1,"calls":"unsafe"}"#).expect("corrupt outbox fixture");

    assert!(DiscoveryOutbox::open(dir.path(), "wss://relay-one.example", ACTOR_ONE).is_err());
}
