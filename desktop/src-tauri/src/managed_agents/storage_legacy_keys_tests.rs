//! Unit tests for `managed_agents/storage_legacy_keys.rs`.
//!
//! Kept in a sibling file so `storage_legacy_keys.rs` stays closer to the
//! 1000-line gate; `#[path]`-included from there.
//!
//! Deliberately defines its own minimal [`FakeKeyStore`] rather than reusing
//! `storage_tests.rs`'s — that fake is private to `storage::tests`, a
//! sibling module this file has no visibility into (mirrors PR #526's
//! `app_state_identity_resolution_tests.rs`, which does the same for the
//! same reason).

use std::cell::RefCell;
use std::collections::HashMap;

use super::*;

/// Minimal in-memory [`KeyStore`] fake for legacy-key recovery tests.
struct FakeKeyStore {
    reachable: bool,
    fail_verify: bool,
    stored: RefCell<HashMap<String, String>>,
    read_count: RefCell<usize>,
}

impl FakeKeyStore {
    fn reachable() -> Self {
        Self {
            reachable: true,
            fail_verify: false,
            stored: RefCell::new(HashMap::new()),
            read_count: RefCell::new(0),
        }
    }
    fn unreachable() -> Self {
        Self {
            reachable: false,
            fail_verify: false,
            stored: RefCell::new(HashMap::new()),
            read_count: RefCell::new(0),
        }
    }
    fn verify_fails() -> Self {
        Self {
            reachable: true,
            fail_verify: true,
            stored: RefCell::new(HashMap::new()),
            read_count: RefCell::new(0),
        }
    }
    fn with_key(self, name: &str, value: &str) -> Self {
        self.stored
            .borrow_mut()
            .insert(name.to_string(), value.to_string());
        self
    }
}

impl KeyStore for FakeKeyStore {
    fn probe(&self, _name: &str) -> KeyringProbe {
        if self.reachable {
            KeyringProbe::ReachableButEmpty
        } else {
            KeyringProbe::Unreachable
        }
    }
    fn load(&self, name: &str) -> Result<Option<String>, String> {
        if !self.reachable {
            return Err("keyring backend unreachable".to_string());
        }
        *self.read_count.borrow_mut() += 1;
        Ok(self.stored.borrow().get(name).cloned())
    }
    fn load_all_readonly(&self) -> Result<Option<HashMap<String, String>>, String> {
        if !self.reachable {
            return Err("keyring backend unreachable".to_string());
        }
        let map = self.stored.borrow().clone();
        if map.is_empty() {
            Ok(None)
        } else {
            Ok(Some(map))
        }
    }
    fn write_and_verify(&self, name: &str, value: &str) -> Result<(), String> {
        if self.fail_verify {
            return Err("read-back verify failed".to_string());
        }
        self.stored
            .borrow_mut()
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn store_all(&self, entries: &HashMap<String, String>) -> Result<(), String> {
        if !self.reachable {
            return Err("keyring backend unreachable".to_string());
        }
        let mut stored = self.stored.borrow_mut();
        for (k, v) in entries {
            stored.insert(k.clone(), v.clone());
        }
        Ok(())
    }
}

fn record_with_pubkey(pubkey: &str) -> ManagedAgentRecord {
    serde_json::from_str(&format!(
        r#"{{
            "pubkey": "{pubkey}",
            "name": "test-agent",
            "private_key_nsec": "",
            "relay_url": "wss://localhost:3000",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }}"#
    ))
    .expect("sample record")
}

// ── recover_legacy_agent_key ───────────────────────────────────────────────

#[test]
fn recover_returns_none_without_a_legacy_store() {
    let current = FakeKeyStore::reachable();
    assert_eq!(
        recover_legacy_agent_key(&current, None::<&FakeKeyStore>, "agent-pubkey"),
        None
    );
}

#[test]
fn recover_copies_the_key_from_legacy_into_current_and_leaves_legacy_intact() {
    let name = agent_keyring_name("agent-pubkey");
    let current = FakeKeyStore::reachable();
    let legacy = FakeKeyStore::reachable().with_key(&name, "nsec1legacy");

    let recovered = recover_legacy_agent_key(&current, Some(&legacy), "agent-pubkey");

    assert_eq!(recovered, Some("nsec1legacy".to_string()));
    assert_eq!(
        current.stored.borrow().get(&name).map(String::as_str),
        Some("nsec1legacy"),
        "recovered key must be copied into the current service"
    );
    assert_eq!(
        legacy.stored.borrow().get(&name).map(String::as_str),
        Some("nsec1legacy"),
        "the legacy entry must be left untouched — another channel install may depend on it"
    );
}

#[test]
fn recover_still_returns_the_key_when_the_copy_fails_to_persist() {
    // A keyring write/verify failure on the CURRENT service must not lose the
    // recovered key for this boot — the agent can still spawn — even though
    // the copy did not persist.
    let name = agent_keyring_name("agent-pubkey");
    let current = FakeKeyStore::verify_fails();
    let legacy = FakeKeyStore::reachable().with_key(&name, "nsec1legacy");

    let recovered = recover_legacy_agent_key(&current, Some(&legacy), "agent-pubkey");

    assert_eq!(recovered, Some("nsec1legacy".to_string()));
    assert!(
        current.stored.borrow().is_empty(),
        "an unverified write must not be recorded as persisted"
    );
}

#[test]
fn recover_returns_none_when_legacy_also_lacks_the_key() {
    let current = FakeKeyStore::reachable();
    let legacy = FakeKeyStore::reachable();

    assert_eq!(
        recover_legacy_agent_key(&current, Some(&legacy), "agent-pubkey"),
        None
    );
}

#[test]
fn recover_returns_none_when_legacy_is_unreachable() {
    // An outage on the legacy service is treated the same as "genuinely
    // unrecoverable" — the caller keeps going rather than failing the load.
    let current = FakeKeyStore::reachable();
    let legacy = FakeKeyStore::unreachable();

    assert_eq!(
        recover_legacy_agent_key(&current, Some(&legacy), "agent-pubkey"),
        None
    );
}

// ── hydrate_keys_with, legacy-recovery integration ──────────────────────────

#[test]
fn hydrate_recovers_key_from_legacy_keyring_service_when_current_lacks_it() {
    // The bug this fixes: an agent whose key exists only under the legacy
    // service loads blank today. Before the fix this assertion fails with
    // an empty string; after it, the record carries the recovered key.
    let name = agent_keyring_name("agent-pubkey");
    let current = FakeKeyStore::reachable();
    let legacy = FakeKeyStore::reachable().with_key(&name, "nsec1legacy");
    let mut records = vec![record_with_pubkey("agent-pubkey")];

    hydrate_keys_with(&current, Some(&legacy), &mut records);

    assert_eq!(
        records[0].private_key_nsec, "nsec1legacy",
        "an agent whose key exists only under the legacy service must load with a usable key"
    );
    assert_eq!(
        current.stored.borrow().get(&name).map(String::as_str),
        Some("nsec1legacy"),
        "the current service must now own an independent copy"
    );
}

#[test]
fn hydrate_never_lets_a_legacy_key_overwrite_one_the_current_service_already_has() {
    let name = agent_keyring_name("agent-pubkey");
    let current = FakeKeyStore::reachable().with_key(&name, "nsec1current");
    let legacy = FakeKeyStore::reachable().with_key(&name, "nsec1legacy");
    let mut records = vec![record_with_pubkey("agent-pubkey")];

    hydrate_keys_with(&current, Some(&legacy), &mut records);

    assert_eq!(
        records[0].private_key_nsec, "nsec1current",
        "the current service's own key must win — the legacy value must never overwrite it"
    );
    assert_eq!(
        *legacy.read_count.borrow(),
        0,
        "the legacy service must not even be consulted when the current service already has the key"
    );
}

#[test]
fn hydrate_is_idempotent_across_boots_once_recovered() {
    // Second boot: the current service already holds the copy made on the
    // first boot. It must be used directly, with no further legacy churn.
    let name = agent_keyring_name("agent-pubkey");
    let current = FakeKeyStore::reachable().with_key(&name, "nsec1legacy");
    let legacy = FakeKeyStore::reachable().with_key(&name, "nsec1legacy");
    let mut records = vec![record_with_pubkey("agent-pubkey")];

    hydrate_keys_with(&current, Some(&legacy), &mut records);

    assert_eq!(records[0].private_key_nsec, "nsec1legacy");
    assert_eq!(
        *legacy.read_count.borrow(),
        0,
        "a second boot must not re-read, let alone re-copy, the legacy key"
    );
}

#[test]
fn hydrate_recovery_is_per_agent_and_does_not_abort_the_whole_load() {
    let recoverable_name = agent_keyring_name("agent-recoverable");
    let current = FakeKeyStore::reachable();
    let legacy = FakeKeyStore::reachable().with_key(&recoverable_name, "nsec1legacy");
    let mut records = vec![
        record_with_pubkey("agent-recoverable"),
        record_with_pubkey("agent-gone-everywhere"),
    ];

    hydrate_keys_with(&current, Some(&legacy), &mut records);

    assert_eq!(
        records[0].private_key_nsec, "nsec1legacy",
        "the recoverable agent must still be recovered"
    );
    assert!(
        records[1].private_key_nsec.is_empty(),
        "an agent with no key anywhere must stay empty, not panic or abort the load"
    );
}
