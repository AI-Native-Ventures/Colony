use std::cell::RefCell;
use std::collections::HashMap;

use super::*;
use crate::secret_store::KeyringProbe;

/// Minimal in-memory [`IdentityKeyStore`] fake for legacy-service recovery
/// tests. Deliberately smaller than `app_state_tests.rs`'s `FakeIdentityStore`
/// (no failure-injection knobs) — these tests only need `Present` and
/// `ReachableButEmpty` seeding, kept local so this file doesn't need
/// visibility into that sibling test module's private fake.
struct FakeStore {
    probe: KeyringProbe,
    slot: RefCell<HashMap<String, String>>,
    deleted: RefCell<Vec<String>>,
}

impl FakeStore {
    fn present_with(value: &str) -> Self {
        let mut slot = HashMap::new();
        slot.insert(IDENTITY_KEY_NAME.to_string(), value.to_string());
        Self {
            probe: KeyringProbe::Present,
            slot: RefCell::new(slot),
            deleted: RefCell::new(Vec::new()),
        }
    }

    fn reachable_but_empty() -> Self {
        Self {
            probe: KeyringProbe::ReachableButEmpty,
            slot: RefCell::new(HashMap::new()),
            deleted: RefCell::new(Vec::new()),
        }
    }
}

impl IdentityKeyStore for FakeStore {
    fn probe(&self, _name: &str) -> KeyringProbe {
        self.probe
    }
    fn load(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.slot.borrow().get(name).cloned())
    }
    fn store(&self, name: &str, value: &str) -> Result<(), String> {
        self.slot
            .borrow_mut()
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        self.deleted.borrow_mut().push(name.to_string());
        self.slot.borrow_mut().remove(name);
        Ok(())
    }
    fn verify_stored(&self, name: &str, expected: &str) -> Result<bool, String> {
        Ok(self.slot.borrow().get(name).is_some_and(|v| v == expected))
    }
}

fn assert_key_eq(a: &Keys, b: &Keys) {
    assert_eq!(a.public_key().to_hex(), b.public_key().to_hex());
}

// --- Legacy-service recovery (2026-08-30 incident: PR #478 baked a new,
// channel-scoped keyring service with no migration, so an install whose
// identity lived under the old service booted into an empty scoped service,
// found no marker under the new name either, and silently minted a fresh
// identity — dropping the user out of their community.) ---

#[test]
fn legacy_service_identity_recovered_not_rotated() {
    // THE regression guard. Scoped service is reachable-but-empty (a
    // channel-scoped build's first boot since the service was renamed), the
    // legacy service still holds the real identity, and nothing under the
    // scoped name exists yet (no file, no scoped marker). Before the fix this
    // fell straight through to `generate_and_persist` and rotated the
    // identity out from under the user; the fix must recover the legacy key
    // instead.
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("identity.key");
    let original_keys = Keys::generate();
    let original_nsec = original_keys.secret_key().to_bech32().unwrap();

    let scoped_store = FakeStore::reachable_but_empty();
    let legacy_store = FakeStore::present_with(&original_nsec);

    assert!(!legacy_path.exists());
    assert!(!migration_marker_path(dir.path()).exists());

    let resolved =
        resolve_identity_with_stores(&scoped_store, Some(&legacy_store), &legacy_path, dir.path())
            .unwrap();

    // The user's ORIGINAL identity is recovered — not a freshly rotated one.
    assert_key_eq(&original_keys, &resolved.keys);
    assert_eq!(resolved.recovery, RecoveryState::None);
    assert_eq!(resolved.storage, IdentityStorage::SystemKeyring);

    // The scoped service now owns its own durable, read-back-verified copy.
    assert_eq!(
        scoped_store
            .slot
            .borrow()
            .get(IDENTITY_KEY_NAME)
            .map(String::as_str),
        Some(original_nsec.as_str())
    );
    // The scoped service's own migration marker was written, so a future
    // "reachable but empty" boot (e.g. after a manual keychain reset) is
    // correctly treated as Lost rather than fresh.
    assert!(migration_marker_path(dir.path()).exists());

    // The legacy entry is untouched — another channel install may still
    // depend on it. Nothing was deleted from it.
    assert!(legacy_store.deleted.borrow().is_empty());
    assert_eq!(
        legacy_store
            .slot
            .borrow()
            .get(IDENTITY_KEY_NAME)
            .map(String::as_str),
        Some(original_nsec.as_str())
    );
}

#[test]
fn legacy_service_corrupt_with_marker_returns_lost_not_fresh() {
    // Legacy service holds something (Present) but it is not a parseable
    // key, and the LEGACY unscoped marker proves an identity existed at some
    // point. No key can be recovered from either service — this must be
    // `Lost` recovery (prompting re-import), never a silently generated key.
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("identity.key");
    // The legacy service's own (unscoped) marker — written back when this
    // channel used the historical `"buzz-desktop"` service.
    write_migration_marker(&dir.path().join(MIGRATION_MARKER_NAME)).unwrap();

    let scoped_store = FakeStore::reachable_but_empty();
    let legacy_store = FakeStore::present_with("not-a-valid-nsec");

    let resolved =
        resolve_identity_with_stores(&scoped_store, Some(&legacy_store), &legacy_path, dir.path())
            .unwrap();

    assert_eq!(
        resolved.recovery,
        RecoveryState::Lost,
        "an unrecoverable legacy identity with a marker present must be Lost, not a fresh key"
    );
    assert_eq!(resolved.storage, IdentityStorage::Ephemeral);
    // Nothing was ever written under the scoped service — no silent rotation.
    assert!(scoped_store.slot.borrow().is_empty());
}

#[test]
fn legacy_service_empty_with_scoped_marker_returns_lost_not_fresh() {
    // The scoped service's OWN marker (from a prior successful boot under
    // this scoped service) proves an identity existed, even though the
    // legacy service has nothing to offer this time. Must not regenerate.
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("identity.key");
    write_migration_marker(&migration_marker_path(dir.path())).unwrap();

    let scoped_store = FakeStore::reachable_but_empty();
    let legacy_store = FakeStore::reachable_but_empty();

    let resolved =
        resolve_identity_with_stores(&scoped_store, Some(&legacy_store), &legacy_path, dir.path())
            .unwrap();

    assert_eq!(resolved.recovery, RecoveryState::Lost);
    assert_eq!(resolved.storage, IdentityStorage::Ephemeral);
}

#[test]
fn legacy_service_empty_no_markers_generates_fresh() {
    // Counter-case: both scoped and legacy services are genuinely empty and
    // neither marker exists anywhere — a real first-ever launch. Must still
    // generate normally; the legacy check must not block a genuine fresh
    // install forever.
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("identity.key");

    let scoped_store = FakeStore::reachable_but_empty();
    let legacy_store = FakeStore::reachable_but_empty();

    let resolved =
        resolve_identity_with_stores(&scoped_store, Some(&legacy_store), &legacy_path, dir.path())
            .unwrap();

    assert_eq!(resolved.recovery, RecoveryState::None);
    assert_eq!(resolved.storage, IdentityStorage::SystemKeyring);
    assert!(
        scoped_store.slot.borrow().contains_key(IDENTITY_KEY_NAME),
        "a fresh key must be generated and stored under the scoped service"
    );
}

#[test]
fn corrupt_scoped_keyring_recovers_legacy_identity() {
    // The corrupt-keyring path (`recover_from_keyring`) shares the same
    // "is this really fresh?" question as the empty-keyring path, so it must
    // also check the legacy service before generating.
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("identity.key");
    let original_keys = Keys::generate();
    let original_nsec = original_keys.secret_key().to_bech32().unwrap();

    let scoped_store = FakeStore::present_with("not-a-valid-nsec");
    let legacy_store = FakeStore::present_with(&original_nsec);

    let resolved =
        resolve_identity_with_stores(&scoped_store, Some(&legacy_store), &legacy_path, dir.path())
            .unwrap();

    assert_key_eq(&original_keys, &resolved.keys);
    assert_eq!(resolved.recovery, RecoveryState::None);
    // The corrupt scoped value was cleared before recovery ran.
    assert_eq!(
        scoped_store.deleted.borrow().as_slice(),
        [IDENTITY_KEY_NAME]
    );
}

#[test]
fn no_legacy_store_behaves_exactly_like_before() {
    // `legacy_store: None` (the non-scoped / OSS / stable-channel case) must
    // reproduce the pre-fix behavior exactly: empty keyring, no file, no
    // marker → generate fresh, with no legacy check attempted at all.
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("identity.key");
    let store = FakeStore::reachable_but_empty();

    let resolved =
        resolve_identity_with_stores(&store, None::<&FakeStore>, &legacy_path, dir.path()).unwrap();

    assert_eq!(resolved.recovery, RecoveryState::None);
    assert_eq!(resolved.storage, IdentityStorage::SystemKeyring);
}
