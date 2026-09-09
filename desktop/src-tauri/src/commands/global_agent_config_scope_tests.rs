use super::{with_config_save_scope, ConfigSaveScope};
use crate::app_state::{build_app_state, AppState};
use crate::managed_agents::ManagedAgentRuntimeKey;
use nostr::Keys;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

const RELAY: &str = "wss://company.example";

fn fixture() -> (Arc<AppState>, ConfigSaveScope) {
    let state = Arc::new(build_app_state());
    let keys = Keys::generate();
    let owner = keys.public_key().to_hex();
    *state.keys.lock().unwrap() = keys;
    *state.relay_url_override.lock().unwrap() = Some(RELAY.into());
    let scope = ConfigSaveScope::parse(Some(owner), Some(RELAY.into()))
        .unwrap()
        .unwrap();
    (state, scope)
}

#[test]
fn scoped_save_requires_both_valid_fields_and_accepts_equivalent_relays() {
    let (state, scope) = fixture();
    assert!(ConfigSaveScope::parse(None, None).unwrap().is_none());
    assert!(ConfigSaveScope::parse(Some(scope.owner.clone()), None).is_err());
    assert!(ConfigSaveScope::parse(None, Some(RELAY.into())).is_err());
    assert!(ConfigSaveScope::parse(Some("not-an-owner".into()), Some(RELAY.into())).is_err());
    assert!(
        ConfigSaveScope::parse(Some(scope.owner.clone()), Some("file:///other".into())).is_err()
    );
    *state.relay_url_override.lock().unwrap() = Some("wss://company.example/".into());
    assert!(with_config_save_scope(&state, Some(&scope), || Ok(())).is_ok());
}

#[test]
fn stale_owner_or_relay_never_reaches_the_disk_write() {
    for change_owner in [true, false] {
        let (state, scope) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("global-agent-config.json");
        std::fs::write(&path, b"previous config").unwrap();
        if change_owner {
            *state.keys.lock().unwrap() = Keys::generate();
        } else {
            *state.relay_url_override.lock().unwrap() = Some("wss://other.example".into());
        }
        let result = with_config_save_scope(&state, Some(&scope), || {
            std::fs::write(&path, b"stale config").map_err(|error| error.to_string())
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"previous config");
    }
}

#[test]
fn queued_save_rechecks_after_a_community_change_wins_the_lock() {
    let (state, scope) = fixture();
    let writer = state.community_operation_lock.blocking_write();
    let called = Arc::new(AtomicBool::new(false));
    let save_state = state.clone();
    let save_called = called.clone();
    let queued = std::thread::spawn(move || {
        with_config_save_scope(&save_state, Some(&scope), || {
            save_called.store(true, Ordering::Release);
            Ok(())
        })
    });
    *state.relay_url_override.lock().unwrap() = Some("wss://other.example".into());
    drop(writer);
    assert!(queued.join().unwrap().is_err());
    assert!(!called.load(Ordering::Acquire));
}

#[test]
fn queued_save_rechecks_after_an_identity_import_wins_the_lock() {
    let (state, scope) = fixture();
    let mutation = state.identity_mutation.lock().unwrap();
    let called = Arc::new(AtomicBool::new(false));
    let save_state = state.clone();
    let save_called = called.clone();
    let queued = std::thread::spawn(move || {
        with_config_save_scope(&save_state, Some(&scope), || {
            save_called.store(true, Ordering::Release);
            Ok(())
        })
    });
    *state.keys.lock().unwrap() = Keys::generate();
    drop(mutation);
    assert!(queued.join().unwrap().is_err());
    assert!(!called.load(Ordering::Acquire));
}

#[test]
fn actual_save_critical_section_holds_both_context_guards_until_write_finishes() {
    let (state, scope) = fixture();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("global-agent-config.json");
    let save_path = path.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let save_state = state.clone();
    let saver = std::thread::spawn(move || {
        with_config_save_scope(&save_state, Some(&scope), || {
            started_tx.send(()).unwrap();
            finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            std::fs::write(save_path, b"captured owner's config").map_err(|error| error.to_string())
        })
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(state.identity_mutation.try_lock().is_err());
    assert!(state.community_operation_lock.try_write().is_err());
    finish_tx.send(()).unwrap();
    saver.join().unwrap().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"captured owner's config");
    assert!(state.identity_mutation.try_lock().is_ok());
    assert!(state.community_operation_lock.try_write().is_ok());
}

#[test]
fn recovery_blocks_scoped_saves_without_changing_legacy_behavior() {
    let (state, scope) = fixture();
    state.reset_failed.store(true, Ordering::Release);
    assert!(with_config_save_scope(&state, Some(&scope), || Ok(())).is_err());
    state.reset_failed.store(false, Ordering::Release);
    state.identity_lost.store(true, Ordering::Release);
    assert!(with_config_save_scope(&state, Some(&scope), || Ok(())).is_err());
    state.identity_lost.store(false, Ordering::Release);
    state.keyring_locked.store(true, Ordering::Release);
    assert!(with_config_save_scope(&state, Some(&scope), || Ok(())).is_err());
    assert!(with_config_save_scope(&state, None, || Ok(())).is_ok());
}

#[test]
fn scoped_restart_never_stops_unknown_owners_or_other_community_pairs() {
    let (_, scope) = fixture();
    assert!(scope.owns_agent(Some(&scope.owner), RELAY));
    assert!(!scope.owns_agent(None, RELAY));
    assert!(!scope.owns_agent(Some(&"b".repeat(64)), RELAY));
    assert!(!scope.owns_agent(Some(&scope.owner), "wss://other.example"));
    let active = ManagedAgentRuntimeKey::new("a".repeat(64), RELAY).unwrap();
    let other = ManagedAgentRuntimeKey::new("a".repeat(64), "wss://other.example").unwrap();
    assert!(scope.permits_restart_pairs(&[active.clone()]));
    assert!(!scope.permits_restart_pairs(&[]));
    assert!(!scope.permits_restart_pairs(&[other.clone()]));
    assert!(!scope.permits_restart_pairs(&[active, other]));
}
