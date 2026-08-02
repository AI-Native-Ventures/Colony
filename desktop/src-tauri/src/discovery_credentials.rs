//! Device-local Discovery provider credentials.
//!
//! The Tauri surface is intentionally status-only: provider values enter on
//! save, remain in the existing OS keychain blob, and never cross IPC again.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::secret_store::{KeyringProbe, SecretStore};

const OUTSCRAPER_API_KEY: &str = "discovery.outscraper.api_key";
const UNAVAILABLE_MESSAGE: &str = "secure Discovery credential storage is unavailable";

/// Safe credential state exposed to React.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryCredentialStatus {
    /// A non-empty credential exists in the OS keychain.
    Configured,
    /// The keychain is reachable but the credential is absent.
    Missing,
    /// The keychain cannot be reached safely this boot.
    Unavailable,
}

trait CredentialStore: Send + Sync {
    fn probe(&self, key: &str) -> KeyringProbe;
    fn store(&self, key: &str, value: &str) -> Result<(), String>;
    fn verify_stored_raw(&self, key: &str, expected: &str) -> Result<bool, String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

impl CredentialStore for SecretStore {
    fn probe(&self, key: &str) -> KeyringProbe {
        SecretStore::probe(self, key)
    }

    fn store(&self, key: &str, value: &str) -> Result<(), String> {
        SecretStore::store(self, key, value)
    }

    fn verify_stored_raw(&self, key: &str, expected: &str) -> Result<bool, String> {
        SecretStore::verify_stored_raw(self, key, expected)
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        SecretStore::delete(self, key)
    }
}

fn shared_store() -> &'static SecretStore {
    SecretStore::shared(crate::app_state::keyring_service())
}

fn status_with(store: &dyn CredentialStore) -> DiscoveryCredentialStatus {
    match store.probe(OUTSCRAPER_API_KEY) {
        KeyringProbe::Present => DiscoveryCredentialStatus::Configured,
        KeyringProbe::ReachableButEmpty => DiscoveryCredentialStatus::Missing,
        KeyringProbe::Unreachable => DiscoveryCredentialStatus::Unavailable,
    }
}

fn save_with(
    store: &dyn CredentialStore,
    value: String,
) -> Result<DiscoveryCredentialStatus, String> {
    let input = Zeroizing::new(value);
    let trimmed = Zeroizing::new(input.trim().to_owned());
    if trimmed.is_empty() {
        return Err("Outscraper API key cannot be empty".to_string());
    }
    store
        .store(OUTSCRAPER_API_KEY, trimmed.as_str())
        .map_err(|_| UNAVAILABLE_MESSAGE.to_string())?;
    match store.verify_stored_raw(OUTSCRAPER_API_KEY, trimmed.as_str()) {
        Ok(true) => Ok(DiscoveryCredentialStatus::Configured),
        Ok(false) | Err(_) => {
            let _ = store.delete(OUTSCRAPER_API_KEY);
            Err(UNAVAILABLE_MESSAGE.to_string())
        }
    }
}

fn delete_with(store: &dyn CredentialStore) -> Result<DiscoveryCredentialStatus, String> {
    store
        .delete(OUTSCRAPER_API_KEY)
        .map_err(|_| UNAVAILABLE_MESSAGE.to_string())?;
    Ok(DiscoveryCredentialStatus::Missing)
}

/// Load the credential for a native adapter without exposing it through IPC.
pub(crate) fn load_outscraper_credential() -> Result<Option<Zeroizing<String>>, String> {
    shared_store()
        .load(OUTSCRAPER_API_KEY)
        .map(|value| value.map(Zeroizing::new))
        .map_err(|_| UNAVAILABLE_MESSAGE.to_string())
}

/// Whether the proof-only fake worker is explicitly enabled.
pub(crate) fn fake_local_worker_enabled() -> bool {
    std::env::var_os("BUZZ_DISCOVERY_FAKE_LOCAL_WORKER_ENABLED")
        .as_deref()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|value| fake_local_worker_enabled_value(Some(value)))
}

fn fake_local_worker_enabled_value(value: Option<&str>) -> bool {
    value.is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

/// Save or replace the device-local Outscraper credential.
#[tauri::command]
pub async fn save_discovery_outscraper_credential(
    value: String,
) -> Result<DiscoveryCredentialStatus, String> {
    let status = tokio::task::spawn_blocking(move || save_with(shared_store(), value))
        .await
        .map_err(|_| UNAVAILABLE_MESSAGE.to_string())??;
    crate::discovery_worker::workspace_changed();
    Ok(status)
}

/// Return only whether the Outscraper credential is usable, absent, or blocked.
#[tauri::command]
pub async fn get_discovery_outscraper_credential_status(
) -> Result<DiscoveryCredentialStatus, String> {
    tokio::task::spawn_blocking(|| Ok(status_with(shared_store())))
        .await
        .map_err(|_| UNAVAILABLE_MESSAGE.to_string())?
}

/// Delete the device-local Outscraper credential idempotently.
#[tauri::command]
pub async fn delete_discovery_outscraper_credential() -> Result<DiscoveryCredentialStatus, String> {
    let status = tokio::task::spawn_blocking(|| delete_with(shared_store()))
        .await
        .map_err(|_| UNAVAILABLE_MESSAGE.to_string())??;
    crate::discovery_worker::workspace_changed();
    Ok(status)
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;

    struct MemoryStore {
        values: Mutex<HashMap<String, String>>,
        reachable: bool,
        verify: bool,
    }

    impl MemoryStore {
        fn reachable() -> Self {
            Self {
                values: Mutex::new(HashMap::new()),
                reachable: true,
                verify: true,
            }
        }
    }

    impl CredentialStore for MemoryStore {
        fn probe(&self, key: &str) -> KeyringProbe {
            if !self.reachable {
                KeyringProbe::Unreachable
            } else if self.values.lock().expect("memory store").contains_key(key) {
                KeyringProbe::Present
            } else {
                KeyringProbe::ReachableButEmpty
            }
        }

        fn store(&self, key: &str, value: &str) -> Result<(), String> {
            if !self.reachable {
                return Err("unavailable".to_string());
            }
            self.values
                .lock()
                .expect("memory store")
                .insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn verify_stored_raw(&self, key: &str, expected: &str) -> Result<bool, String> {
            Ok(self.verify
                && self
                    .values
                    .lock()
                    .expect("memory store")
                    .get(key)
                    .is_some_and(|value| value == expected))
        }

        fn delete(&self, key: &str) -> Result<(), String> {
            if !self.reachable {
                return Err("unavailable".to_string());
            }
            self.values.lock().expect("memory store").remove(key);
            Ok(())
        }
    }

    #[test]
    fn safe_status_serializes_without_a_secret_field() {
        let json = serde_json::to_string(&DiscoveryCredentialStatus::Configured)
            .expect("serialize credential status");
        assert_eq!(json, "\"configured\"");
        assert!(!json.contains("secret"));
        assert!(!json.contains("api_key"));
    }

    #[test]
    fn save_trims_rejects_empty_and_returns_only_status() {
        let store = MemoryStore::reachable();
        assert!(save_with(&store, "   ".to_string()).is_err());
        assert_eq!(status_with(&store), DiscoveryCredentialStatus::Missing);
        assert_eq!(
            save_with(&store, "  fixture-value  ".to_string()),
            Ok(DiscoveryCredentialStatus::Configured)
        );
        assert_eq!(status_with(&store), DiscoveryCredentialStatus::Configured);
        assert_eq!(
            store
                .values
                .lock()
                .expect("memory store")
                .get(OUTSCRAPER_API_KEY)
                .map(String::as_str),
            Some("fixture-value")
        );
    }

    #[test]
    fn status_distinguishes_missing_from_unavailable() {
        let missing = MemoryStore::reachable();
        let unavailable = MemoryStore {
            values: Mutex::new(HashMap::new()),
            reachable: false,
            verify: true,
        };
        assert_eq!(status_with(&missing), DiscoveryCredentialStatus::Missing);
        assert_eq!(
            status_with(&unavailable),
            DiscoveryCredentialStatus::Unavailable
        );
    }

    #[test]
    fn delete_is_idempotent() {
        let store = MemoryStore::reachable();
        assert_eq!(delete_with(&store), Ok(DiscoveryCredentialStatus::Missing));
        save_with(&store, "fixture-value".to_string()).expect("save fixture");
        assert_eq!(delete_with(&store), Ok(DiscoveryCredentialStatus::Missing));
        assert_eq!(delete_with(&store), Ok(DiscoveryCredentialStatus::Missing));
    }

    #[test]
    fn failed_raw_verification_removes_candidate() {
        let store = MemoryStore {
            values: Mutex::new(HashMap::new()),
            reachable: true,
            verify: false,
        };
        assert_eq!(
            save_with(&store, "fixture-value".to_string()),
            Err(UNAVAILABLE_MESSAGE.to_string())
        );
        assert_eq!(status_with(&store), DiscoveryCredentialStatus::Missing);
    }

    #[test]
    fn fake_worker_is_disabled_unless_explicitly_enabled() {
        assert!(!fake_local_worker_enabled_value(None));
        assert!(fake_local_worker_enabled_value(Some("1")));
        assert!(fake_local_worker_enabled_value(Some("true")));
        assert!(fake_local_worker_enabled_value(Some("TRUE")));
        assert!(!fake_local_worker_enabled_value(Some("yes")));
        assert!(!fake_local_worker_enabled_value(Some("")));
        assert!(!fake_local_worker_enabled_value(Some("false")));
    }

    #[cfg(feature = "system-keyring")]
    #[ignore = "requires a real OS keychain"]
    #[test]
    fn real_os_keychain_round_trip_is_internal_and_verified() {
        const SERVICE: &str = "buzz-test-colony-discovery-credential";
        const KEY: &str = "discovery.outscraper.api_key";
        const VALUE: &str = "colony-discovery-keychain-fixture-9e3c2a61";

        let store = SecretStore::keyring(SERVICE);
        let _ = store.delete(KEY);
        store.store(KEY, VALUE).expect("store Discovery fixture");
        assert!(store
            .verify_stored_raw(KEY, VALUE)
            .expect("raw-verify Discovery fixture"));
        assert_eq!(store.probe(KEY), KeyringProbe::Present);
        let loaded = Zeroizing::new(
            store
                .load(KEY)
                .expect("load Discovery fixture")
                .expect("Discovery fixture is present"),
        );
        assert_eq!(loaded.as_str(), VALUE);
        store.delete(KEY).expect("delete Discovery fixture");
        assert_eq!(store.probe(KEY), KeyringProbe::ReachableButEmpty);
    }
}
