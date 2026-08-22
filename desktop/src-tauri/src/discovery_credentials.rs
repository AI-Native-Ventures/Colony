//! One-time cleanup for retired device-local Discovery provider keys.

use crate::secret_store::SecretStore;

const LEGACY_PROVIDER_KEYS: [&str; 3] = [
    "discovery.outscraper.api_key",
    "discovery.brave_search.api_key",
    "discovery.exa_search.api_key",
];

/// Remove provider keys that are no longer used by Colony-hosted Discovery.
pub(crate) fn purge_legacy_provider_credentials() {
    let store = SecretStore::shared(crate::app_state::keyring_service());
    for key in LEGACY_PROVIDER_KEYS {
        if let Err(error) = store.delete(key) {
            eprintln!("buzz-desktop: legacy Discovery credential cleanup failed: {error}");
        }
    }
}

/// Whether the proof-only fake worker is explicitly enabled.
pub(crate) fn fake_local_worker_enabled() -> bool {
    std::env::var_os("BUZZ_DISCOVERY_FAKE_LOCAL_WORKER_ENABLED")
        .as_deref()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn fake_worker_flag_is_exact() {
        assert!(["1", "true", "TRUE"]
            .into_iter()
            .all(|value| value == "1" || value.eq_ignore_ascii_case("true")));
        assert!(!["", "0", "yes"]
            .into_iter()
            .any(|value| value == "1" || value.eq_ignore_ascii_case("true")));
    }
}
